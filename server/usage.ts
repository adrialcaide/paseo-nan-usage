import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  toneFromUsedPct,
  unavailable,
  usedPctOf,
  windowFromReportedDuration,
  windowFromUsedPct,
  type UsageAccount,
  type UsageBalance,
  type UsageDetail,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import type { UsageInput } from "../shared/input.js";

const NAN_DEFAULT_API_BASE = "https://api.nan.builders/v1";
/**
 * Undocumented dashboard quota service (the one behind cloud.nan.builders). Not part
 * of the published API, so it is best-effort only: every failure or unexpected shape
 * falls back to the catalog-derived rings below. The key only ever goes to fixed
 * origins over HTTPS, same transport discipline as the published endpoint.
 */
const NAN_QUOTA_URL = "https://cloud-api.nan.builders/api/usage/quota";

// z.coerce.number() already rejects NaN/±Infinity in zod v4 (the runtime Paseo ships);
// the old .finite() chain was a deprecated no-op.
const ApiNumberSchema = z.coerce.number();

const ModelTotalsSchema = z.object({
  model: z.string(),
  prompt_tokens: ApiNumberSchema.optional(),
  completion_tokens: ApiNumberSchema.optional(),
  total_tokens: ApiNumberSchema.optional(),
  api_requests: ApiNumberSchema.optional(),
  cached_tokens: ApiNumberSchema.optional(),
  credits: ApiNumberSchema.optional(),
});

/**
 * Documented `UsageCredits`: the single pool every credit-billed model draws from, metered
 * against the member's Stripe billing period (almost never the calendar month). `null` when
 * the account is not billed in credits.
 */
const CreditsSchema = z.object({
  period_start: z.string().optional(),
  period_end: z.string().optional(),
  allowance: ApiNumberSchema.optional(),
  used: ApiNumberSchema.optional(),
  remaining: ApiNumberSchema.optional(),
  pack_credits: ApiNumberSchema.optional(),
  pack_expires_at: z.string().nullable().optional(),
  frozen: z.boolean().optional(),
});
export type UsageCredits = z.infer<typeof CreditsSchema>;

const UsageResponseSchema = z.object({
  object: z.string().optional(),
  start_date: z.string(),
  end_date: z.string(),
  totals: z
    .object({
      prompt_tokens: ApiNumberSchema.optional(),
      completion_tokens: ApiNumberSchema.optional(),
      total_tokens: ApiNumberSchema.optional(),
      api_requests: ApiNumberSchema.optional(),
      cached_tokens: ApiNumberSchema.optional(),
      credits: ApiNumberSchema.optional(),
      by_model: z.array(ModelTotalsSchema).default([]),
    })
    .default({ by_model: [] }),
  all_time: z
    .object({
      prompt_tokens: ApiNumberSchema.optional(),
      completion_tokens: ApiNumberSchema.optional(),
      total_tokens: ApiNumberSchema.optional(),
      api_requests: ApiNumberSchema.optional(),
      cached_at: z.string().optional(),
    })
    .optional(),
  credits: CreditsSchema.nullable().optional(),
});
type UsageResponse = z.infer<typeof UsageResponseSchema>;

/** Live per-model quota entries from the dashboard quota service. */
const QuotaModelSchema = z.object({
  model: z.string().min(1).max(128),
  tokensUsed: ApiNumberSchema.optional(),
  /** Period allowance; on a first period it can be prorated, fullCap is the true cap. */
  cap: ApiNumberSchema.optional(),
  fullCap: ApiNumberSchema.optional(),
  periodEnd: z.string().optional(),
  /** Rolling sub-window, reported only when the endpoint meters one. */
  windowHours: ApiNumberSchema.optional(),
  windowTokensUsed: ApiNumberSchema.optional(),
  windowTokens: ApiNumberSchema.optional(),
  fullWindowTokens: ApiNumberSchema.optional(),
  windowResetsAt: z.string().optional(),
});

const QuotaResponseSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  periodEnd: z.string().optional(),
  models: z.array(QuotaModelSchema).min(1),
});
type QuotaResponse = z.infer<typeof QuotaResponseSchema>;

/**
 * Documented per-member quotas that still live outside the credits pool. Since the 2026-11
 * billing change the chat models have no allowance of their own: every one of them draws
 * credits from the single pool in `UsageCredits`, so the only catalog ring left is the image
 * budget, which the docs meter against the calendar month and explicitly keep separate from
 * credits ("vuelve a cero con el mes natural y no toca tus créditos").
 *
 * Also deliberately absent: glm5.3's 400M cap per rolling 4h. It is a speed limit, not a
 * balance, and it is finer than the daily granularity of `/usage` rows, so it only ever
 * renders from the live quota service below.
 */
interface MonthlyQuota {
  /** Stable feature id, used to scope window ids per quota. */
  id: string;
  label: string;
  unit: "tokens" | "requests";
  limit: number;
  /** Model ids whose window usage counts against this quota. */
  models: string[];
}

const MONTHLY_QUOTAS: MonthlyQuota[] = [
  // flux-2-klein and qwen-image-2.1 share one 100-requests/month pool ("shared with
  // flux-2-klein" in the catalog). The pool counts requests, not images.
  { id: "image-pool", label: "Images", unit: "requests", limit: 100, models: ["flux-2-klein", "qwen-image-2.1"] },
];

/** Plans that include credits every billing period, keyed by their documented allowance. */
const PLAN_BY_ALLOWANCE: Record<number, string> = { 7000: "Inference", 20000: "Premium" };

/**
 * Catalog models billed with "no counter" at https://nan.builders/docs/choose-a-model: they draw
 * no credits at all, so a `0` in their `credits` field is a feature, not a rounding artefact.
 * The docs are explicit that this is not an infinite allowance either, only the rpm limits keep
 * applying, hence the "unmetered" wording next to the mark.
 *
 * Image models are deliberately absent: they have their own request budget, rendered as a ring.
 */
const UNMETERED_MODELS = new Set([
  "gemma4",
  "qwen3.6",
  "qwen3-embedding",
  "rerank",
  "kokoro",
  "whisper",
]);

/** Env variable names that may hold an inference API key (`sk-...`). */
const ENV_KEY_LOCATORS = ["NAN_API_KEY"];
/** JSON or plain-text files that may hold the key, in preference order. */
function fileKeyLocators(): string[] {
  return [join(homedir(), ".nan", "credentials.json"), join(homedir(), ".nan", "config.json")];
}
/** Integration ids created by OpenCode's `/connect` flow that may hold the nan key. */
const OPENCODE_INTEGRATIONS = ["nan"];
/**
 * Reading OpenCode's credential store is opt-out: set NAN_USAGE_NO_OPENCODE=1 to keep
 * this source to env vars and files only, for example to stop every installed plugin
 * from resolving that store on a shared machine. Applies to both OpenCode stores
 * (the /connect credential table and the plaintext provider config).
 */
function openCodeStoreAllowed(): boolean {
  return process.env.NAN_USAGE_NO_OPENCODE !== "1";
}

// @types/node@20 predates the node:sqlite typings; declare only the slice used here,
// like Paseo's own cursor usage source does.
interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

function resolvePath(locator: string): string {
  if (locator === "~") return homedir();
  if (locator.startsWith("~/") || locator.startsWith("~\\")) return join(homedir(), locator.slice(2));
  return locator;
}

function pickKeyField(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const field of ["apiKey", "api_key", "NAN_API_KEY", "key", "token"]) {
      const entry = (value as Record<string, unknown>)[field];
      if (typeof entry === "string" && entry.trim()) return entry.trim();
    }
  }
  return undefined;
}

/** Where OpenCode keeps its data: `$XDG_DATA_HOME/opencode`, default `~/.local/share/opencode`.
 * Matches OpenCode v2's global-roots.ts exactly: os.homedir(), no HOME precedence, all platforms. */
function openCodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  return join(xdg || join(homedir(), ".local", "share"), "opencode");
}

const CREDENTIAL_ROW_SQL =
  "SELECT value FROM credential WHERE integration_id = ? AND active = 1 ORDER BY time_updated DESC LIMIT 1";

/**
 * Reads the OpenCode v2 credential from sqlite. The value is a tagged union
 * (`{"type":"key","key":...} | oauth | external`); only key credentials can
 * authenticate `/usage`, which requires the `sk-...` inference API key.
 */
async function readOpenCodeKeyRow(dbPath: string, integrationId: string): Promise<string | undefined> {
  // Variable specifier: the daemon runtime (Node 22+/24) has node:sqlite; older ones throw and we fall through.
  const sqliteSpecifier: string = "node:sqlite";
  let sqlite: NodeSqliteModule;
  try {
    sqlite = (await import(sqliteSpecifier)) as unknown as NodeSqliteModule;
  } catch {
    return undefined;
  }
  if (!existsSync(dbPath)) return undefined;
  let db: SqliteDatabase | undefined;
  try {
    try {
      db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    } catch {
      // WAL databases need the -shm sidecar; when a read-only handshake fails, a
      // plain connection still only runs SELECTs and never touches stored credentials.
      db = new sqlite.DatabaseSync(dbPath);
    }
    const row = db.prepare(CREDENTIAL_ROW_SQL).get(integrationId);
    const raw = row?.value;
    if (typeof raw !== "string") return undefined;
    return pickKeyCredential(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      /* already gone */
    }
  }
}

function pickKeyCredential(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { type, key } = value as { type?: unknown; key?: unknown };
  if (type === "key" && typeof key === "string" && key.trim()) return key.trim();
  return undefined;
}

/**
 * Resolves the key from the OpenCode login created through `/connect` (v2.x sqlite
 * `credential` table; v1 installs kept it in `auth.json`, which is checked as fallback).
 */
async function readOpenCodeKey(integrationId: string): Promise<string | undefined> {
  if (!openCodeStoreAllowed()) return undefined;
  const dir = openCodeDataDir();
  const key = await readOpenCodeKeyRow(join(dir, "opencode.db"), integrationId);
  if (key) return key;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(join(dir, "auth.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const entry = (parsed as Record<string, unknown>)[integrationId];
    if (!entry || typeof entry !== "object") return undefined;
    const { type, key: value } = entry as { type?: unknown; key?: unknown };
    if (type === "api" && typeof value === "string" && value.trim()) return value.trim();
    return undefined;
  } catch {
    return undefined;
  }
}

// --- opencode.json provider config (the setup nan's docs teach: provider.nan.options.apiKey)
//
// Mirrors OpenCode's own resolution for global discovery only (never scans project
// directories, per Paseo's rules): $XDG_CONFIG_HOME/opencode/opencode.json{,c} plus the
// legacy config.json, JSONC with {file:path} and {env:VAR} substitution like
// packages/core/src/config/variable.ts in opencode v2.

/** Where OpenCode reads global config: `$XDG_CONFIG_HOME/opencode`, default `~/.config/opencode` (XDG on Windows too). */
function openCodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), ".config"), "opencode");
}

/** Strip line and block comments outside JSON strings (jsonc-lite; no nested blocks). */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Remove trailing commas outside strings (`,}` / `,]`), like jsonc-parser's allowTrailingComma. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j += 1;
      if (text[j] === "}" || text[j] === "]") continue; // drop the comma
    }
    out += ch;
  }
  return out;
}

/** Expand `~/rel` and join relative paths against the config directory. */
function resolveAgainstConfigDir(value: string, configDir: string): string {
  const home = process.env.HOME?.trim() || homedir();
  if (value === "~" || /^~[/\\]/.test(value)) return join(home, value.slice(2));
  if (value.startsWith("/")) return value;
  return join(configDir, value);
}

async function substituteConfigVariables(text: string, configDir: string): Promise<string> {
  let out = text;
  for (const match of out.matchAll(/\{file:([^}]+)\}/g)) {
    const token = match[0];
    let value = "";
    try {
      value = (await fs.readFile(resolveAgainstConfigDir(match[1]!, configDir), "utf8")).trim();
    } catch {
      value = "";
    }
    out = out.split(token).join(JSON.stringify(value).slice(1, -1));
  }
  out = out.replace(/\{env:([^}]+)\}/g, (_, name: string) => process.env[name] || "");
  return out;
}

/** Parse a JSONC config file with OpenCode's variable substitution; undefined when unusable. */
async function parseOpenCodeConfigFile(path: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const substituted = await substituteConfigVariables(raw, join(path, ".."));
  const cleaned = stripTrailingCommas(stripJsonComments(substituted));
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* malformed or unresolved template: treat as missing */
  }
  return undefined;
}

/**
 * Reads `provider.<id>.options.apiKey` from the global OpenCode config files.
 * The nan docs put the key here in plain text, so many installs only have it in this store.
 */
export async function readOpenCodeConfigKey(providerId: string): Promise<string | undefined> {
  if (!openCodeStoreAllowed()) return undefined;
  const dir = openCodeConfigDir();
  for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) {
    const config = await parseOpenCodeConfigFile(join(dir, name));
    if (!config) continue;
    const providers = config.provider;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) continue;
    const entry = (providers as Record<string, unknown>)[providerId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const options = record.options;
    const candidates = [
      options && typeof options === "object" && !Array.isArray(options)
        ? (options as Record<string, unknown>).apiKey
        : undefined,
      record.apiKey,
    ];
    for (const candidate of candidates)
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

/**
 * Re-reads the selected store on every fetch so rotated or replaced keys take effect
 * without re-discovery. Returns undefined when the store does not (yet) hold a key.
 */
export async function readApiKey(input: UsageInput): Promise<string | undefined> {
  if (input.store === "env") return process.env[input.locator]?.trim() || undefined;
  if (input.store === "opencode") return readOpenCodeKey(input.locator.trim().toLowerCase());
  if (input.store === "opencode_config") return readOpenCodeConfigKey(input.locator.trim().toLowerCase());
  let raw: string;
  try {
    raw = (await fs.readFile(resolvePath(input.locator), "utf8")).trim();
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  if (raw.startsWith("{")) {
    try {
      return pickKeyField(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
  // Plain-text key file. Ignore anything implausibly short to avoid junk stores.
  return raw.length >= 12 ? raw : undefined;
}

function requestUsage(url: string, apiKey: string, fetchApi: typeof fetch): Promise<Response> {
  return fetchApi(url, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
}

function retryAfterSeconds(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDateUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** First day of the current UTC calendar month; nan's monthly quotas count this window. */
export function monthStartUtc(now = new Date()): string {
  return isoDateUtc(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
}

/** First instant of next month UTC, where the documented monthly counters reset. */
export function nextMonthResetIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

function slugify(value: string): string {
  const slug = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "model";
}

const groupFormatter = new Intl.NumberFormat("en-US");
function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return groupFormatter.format(Math.round(value));
}

/** `1,234,567` -> `1.23M`; keeps short numbers readable. */
function compactTokens(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2).replace(/\.?0+$/, "")}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  return formatTokens(value);
}

/** Credits come with one decimal: `82.8`, and whole numbers stay plain (`7,000`). */
function formatCredits(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return groupFormatter.format(Math.round(value * 10) / 10);
}

function pickMetric(row: ModelTotal, unit: MonthlyQuota["unit"]): number {
  const value = unit === "tokens" ? row.total_tokens : row.api_requests;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

type ModelTotal = z.infer<typeof ModelTotalsSchema>;

function positiveNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Rolling sub-windows from the live quota service (glm5.3's 400M per rolling 4h) and, only for
 * accounts that are not billed in credits, one ring per capped model.
 *
 * Which of the two applies depends on how the account pays. Credit-billed plans draw one shared
 * pool, so the per-model `cap` the service still reports is legacy and rendering it would
 * contradict the catalog (there is no allowance per model any more). Gentle is the exception the
 * error table documents: it carries no credits and keeps a monthly quota per model
 * (`402 monthly_cap_reached`), so for those accounts the caps are the real allowance and the
 * `credits` block never arrives. `creditBilled` is what tells the two apart.
 *
 * Entries with zero usage show no ring either way: the service lists the full model catalog
 * regardless of tier, so a 0% ring for a model the key cannot call is noise.
 */
export function buildLiveWindows(quota: QuotaResponse, creditBilled: boolean): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const entry of quota.models) {
    const budget = positiveNumber(entry.fullWindowTokens) ?? positiveNumber(entry.windowTokens);
    if (typeof entry.windowTokensUsed === "number" && entry.windowTokensUsed > 0 && budget !== undefined) {
      const pct = (entry.windowTokensUsed / budget) * 100;
      const hours = positiveNumber(entry.windowHours);
      windows.push(
        windowFromReportedDuration({
          durationSeconds: hours !== undefined ? hours * 3600 : null,
          scope: { id: slugify(entry.model), label: entry.model },
          unknown: { id: "rolling", label: "Rolling", shortLabel: "roll" },
          utilizationPct: pct,
          resetsAt: isoOrNull(entry.windowResetsAt),
          summary: true,
          tone: toneFromUsedPct(pct),
        }),
      );
    }
    if (creditBilled) continue;
    const allowance = positiveNumber(entry.fullCap) ?? positiveNumber(entry.cap);
    const used = typeof entry.tokensUsed === "number" && Number.isFinite(entry.tokensUsed) ? entry.tokensUsed : null;
    if (allowance === undefined || used === null || used <= 0) continue;
    const pct = usedPctOf(used, allowance);
    windows.push(
      windowFromUsedPct({
        id: `${slugify(entry.model)}:period`,
        label: `${entry.model} · Current period`,
        utilizationPct: pct,
        resetsAt: isoOrNull(entry.periodEnd ?? quota.periodEnd),
        summary: true,
        tone: toneFromUsedPct(pct),
      }),
    );
  }
  return windows;
}

/** `2026-10-29T17:14:00Z` -> `2026-10-29`; undefined unless it parses as a date. */
function dayFromIso(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
}

/**
 * The single account-level ring: credits left in this billing period. `allowance` is the plan's
 * pool (7,000 Inference · 20,000 Premium) and renews on the member's Stripe date, not on the
 * 1st, which is why the reset shown is `period_end`. A frozen subscription is metered but
 * unusable, so it reads danger even at a low percentage.
 */
export function buildCreditWindows(credits: UsageCredits | null | undefined): UsageWindow[] {
  const allowance = positiveNumber(credits?.allowance);
  if (allowance === undefined || typeof credits?.used !== "number") return [];
  const pct = usedPctOf(credits.used, allowance);
  return [
    windowFromUsedPct({
      id: "credits:period",
      label: "Credits · Current period",
      shortLabel: "mo",
      utilizationPct: pct,
      resetsAt: isoOrNull(credits.period_end),
      summary: true,
      tone: credits.frozen === true ? "danger" : toneFromUsedPct(pct),
    }),
  ];
}

/** Allowance and pack balances; packs are a remainder with no known total, so no percentage. */
export function buildCreditBalances(credits: UsageCredits | null | undefined): UsageBalance[] {
  if (!credits) return [];
  const balances: UsageBalance[] = [];
  const allowance = positiveNumber(credits.allowance);
  if (allowance !== undefined && typeof credits.used === "number") {
    const pct = usedPctOf(credits.used, allowance);
    balances.push({
      id: "credits_period",
      label: "Credits · this period",
      used: credits.used,
      remaining: typeof credits.remaining === "number" ? credits.remaining : Math.max(0, allowance - credits.used),
      limit: allowance,
      unit: "credits",
      resetsAt: isoOrNull(credits.period_end),
      tone: credits.frozen === true ? "danger" : toneFromUsedPct(pct),
    });
  }
  const packs = positiveNumber(credits.pack_credits);
  if (packs !== undefined) {
    balances.push({
      id: "credits_packs",
      label: "Credits · packs",
      remaining: packs,
      unit: "credits",
      resetsAt: isoOrNull(credits.pack_expires_at ?? undefined),
      // No tone: a pack has no known total, so there is no percentage to scale, and Paseo
      // derives the tone from the remainder itself.
    });
  }
  return balances;
}

/** Plan name from the documented credit allowance, when it matches a known tier. */
export function planLabelFor(credits: UsageCredits | null | undefined): string | undefined {
  const allowance = positiveNumber(credits?.allowance);
  return allowance === undefined ? undefined : PLAN_BY_ALLOWANCE[allowance];
}

async function fetchQuota(apiKey: string, fetchApi: typeof fetch): Promise<QuotaResponse | null> {
  try {
    const res = await fetchApi(NAN_QUOTA_URL, {
      signal: AbortSignal.timeout(8_000),
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      redirect: "manual",
    });
    if (!res.ok || res.status >= 300) return null;
    return QuotaResponseSchema.parse(await res.json());
  } catch {
    // Undocumented endpoint: any drift hides only the live rings, never the report.
    return null;
  }
}

/**
 * Rings for the quotas still metered on the calendar month, built only for the ones the member
 * touched this month; a 0% ring for an unused feature is noise. Chat models are not here: since
 * the credits migration they share the single pool that `buildCreditWindows` renders.
 */
export function buildMonthlyWindows(
  byModel: ModelTotal[],
  now = new Date(),
): UsageWindow[] {
  const totalsByModel = new Map<string, ModelTotal>();
  for (const row of byModel) totalsByModel.set(row.model, row);
  const resetsAt = nextMonthResetIso(now);
  const windows: UsageWindow[] = [];
  for (const quota of MONTHLY_QUOTAS) {
    let used = 0;
    for (const model of quota.models) {
      const row = totalsByModel.get(model);
      if (row) used += pickMetric(row, quota.unit);
    }
    if (used <= 0) continue;
    const pct = usedPctOf(used, quota.limit);
    windows.push(
      windowFromUsedPct({
        id: `${slugify(quota.id)}:monthly`,
        label: `${quota.label} · Monthly`,
        shortLabel: "mo",
        utilizationPct: pct,
        resetsAt,
        summary: true,
        tone: toneFromUsedPct(pct),
      }),
    );
  }
  return windows;
}

export interface ReportParts {
  /**
   * Counters to render: the billing period when the account is billed in credits (the pool and
   * the token counters then cover the same window), otherwise the calendar month.
   */
  counters: UsageResponse;
  /** Month-to-date report: the image budget is the one counter that still follows the calendar. */
  month: UsageResponse;
  /** Live quota service answer; only its rolling sub-windows are used any more. */
  quota?: QuotaResponse | null;
  /** False for mirror hosts, which meter their own catalogs. */
  catalogRings?: boolean;
}

/** Credits of the report: the same object in either response, whichever answered first. */
function creditsOf(parts: ReportParts): UsageCredits | null {
  return parts.counters.credits ?? parts.month.credits ?? null;
}

export function toUsageReport(parts: ReportParts): UsageReport {
  const { counters, month, quota } = parts;
  const catalogRings = parts.catalogRings ?? true;
  const credits = creditsOf(parts);
  // The credit pool is metered on the billing period, so the counters shown beside it are
  // labelled the same way; a month window keeps the old wording.
  const periodWindow = counters !== month;
  const windowName = periodWindow ? "this period" : "this month";
  const balances: UsageBalance[] = [];
  const details: UsageDetail[] = [];

  balances.push(...buildCreditBalances(credits));

  const total = counters.totals.total_tokens;
  if (typeof total === "number")
    balances.push({
      id: "window_tokens",
      label: `Tokens · ${windowName}`,
      used: total,
      unit: "tokens",
    });

  const requests = counters.totals.api_requests;
  if (typeof requests === "number")
    balances.push({
      id: "window_requests",
      label: `Requests · ${windowName}`,
      used: requests,
      unit: "requests",
    });

  if (counters.all_time && typeof counters.all_time.total_tokens === "number")
    balances.push({
      id: "all_time_tokens",
      label: "Tokens · all time",
      used: counters.all_time.total_tokens,
      unit: "tokens",
    });

  details.push({
    id: "window",
    label: periodWindow ? "Billing period (UTC)" : "Window (UTC)",
    value: `${counters.start_date} → ${counters.end_date}`,
  });

  const prompt = counters.totals.prompt_tokens;
  const completion = counters.totals.completion_tokens;
  if (typeof prompt === "number" && typeof completion === "number")
    details.push({
      id: "split",
      label: "In / Out",
      value: `${compactTokens(prompt)} / ${compactTokens(completion)}`,
    });

  const cached = positiveNumber(counters.totals.cached_tokens);
  if (cached !== undefined)
    details.push({ id: "cached", label: "Cached input", value: compactTokens(cached) });

  if (credits?.frozen === true)
    details.push({
      id: "frozen",
      label: "Subscription",
      value: "Frozen: credit-billed requests are refused until it is active",
      tone: "danger",
    });

  const seen = new Set<string>();
  const models = [...counters.totals.by_model].sort(
    (a, b) =>
      (b.credits ?? 0) - (a.credits ?? 0) ||
      (b.total_tokens ?? 0) - (a.total_tokens ?? 0) ||
      a.model.localeCompare(b.model),
  );
  for (const model of models) {
    let id = `model_${slugify(model.model)}`;
    if (seen.has(id)) id = `${id}_${seen.size}`;
    seen.add(id);
    const billed = positiveNumber(model.credits);
    const pieces = [
      // Credit-billed models only show a figure once it reaches the API's one decimal; the
      // no-counter ones show the mark instead, so a missing figure never reads as missing data.
      billed !== undefined ? `${formatCredits(billed)} cr` : UNMETERED_MODELS.has(model.model) ? "∞ unmetered" : null,
      `${compactTokens(model.total_tokens)} tok`,
      `${compactTokens(model.api_requests)} req`,
    ].filter((piece): piece is string => piece !== null);
    details.push({ id, label: model.model, value: pieces.join(" · ") });
  }

  const rolling = quota ? buildLiveWindows(quota, positiveNumber(credits?.allowance) !== undefined) : [];
  const images = catalogRings ? buildMonthlyWindows(month.totals.by_model) : [];

  return {
    status: "available",
    planLabel: planLabelFor(credits),
    // The credit pool is the account's single allowance; the image budget is the one
    // catalog counter left; rolling windows come from the live service when it answers.
    windows: [...buildCreditWindows(credits), ...images, ...rolling],
    balances,
    details,
  };
}

function usesDefaultHost(base: string): boolean {
  try {
    return new URL(base).host === "api.nan.builders";
  } catch {
    return false;
  }
}

/** A non-retryable answer that maps onto a Paseo unavailable report (rejected key, no identity). */
class UsageUnavailableError extends Error {
  readonly report: UsageReport;
  constructor(report: UsageReport) {
    super("nan usage unavailable");
    this.report = report;
  }
}

/**
 * One page of `/usage` over `start_date` → today. `totals` and `totals.by_model` cover the whole
 * requested window regardless of pagination, so `limit=1` keeps the page tiny, and `credits`
 * always describes the billing period whatever the window.
 */
async function fetchUsageWindow(
  base: string,
  startDate: string,
  apiKey: string,
  input: UsageInput,
  fetchApi: typeof fetch,
): Promise<UsageResponse> {
  const url = new URL("usage", base.endsWith("/") ? base : `${base}/`);
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("limit", "1");

  let res = await requestUsage(url.toString(), apiKey, fetchApi);
  if (res.status === 429) {
    // The usage endpoint allows 30 requests/min and the daemon caches reports for 5 min,
    // so a 429 means other tooling competed for the budget. Stay inside the daemon's
    // 20s fetch deadline; otherwise surface the error for the next refresh cycle.
    const retryIn = retryAfterSeconds(res);
    if (retryIn !== null && retryIn <= 8) {
      await sleep(retryIn * 1000);
      res = await requestUsage(url.toString(), apiKey, fetchApi);
    } else {
      throw new Error(`nan usage API rate limited (retry in ${retryIn ?? "unknown"}s)`);
    }
  }

  if (res.status === 401 || res.status === 403)
    // When the key lives in OpenCode's stores, say which CLI can refresh it.
    throw new UsageUnavailableError(
      unavailable({
        kind: "rejected",
        status: res.status,
        ...(input.store === "opencode" || input.store === "opencode_config" ? { refreshedBy: "opencode" } : {}),
      }),
    );
  if (res.status === 404)
    throw new UsageUnavailableError(
      unavailable({
        kind: "no_quota",
        detail:
          "This nan account has no usage identity yet: it needs an API key, a linked Discord account, or a handle.",
      }),
    );
  if (!res.ok) throw new Error(`nan usage API returned ${res.status}`);
  return UsageResponseSchema.parse(await res.json());
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const apiKey = await readApiKey(input);
  if (!apiKey) throw new Error("nan credential store no longer exists");

  const base = input.api_base ?? NAN_DEFAULT_API_BASE;
  const isDefaultHost = usesDefaultHost(base);
  // Kick the (undocumented) quota lookup off in parallel with the published endpoint;
  // fetchQuota swallows every failure, so it can only enrich the report, never break it.
  const quotaPromise = isDefaultHost ? fetchQuota(apiKey, fetchApi) : Promise.resolve(null);

  const monthStart = monthStartUtc();
  let month: UsageResponse;
  try {
    month = await fetchUsageWindow(base, monthStart, apiKey, input, fetchApi);
  } catch (error) {
    if (error instanceof UsageUnavailableError) return error.report;
    throw error;
  }

  // Credits renew on the member's Stripe date, almost never the 1st, so a month window would
  // show counters wider than the pool the ring reports. Ask for the period itself when it
  // started inside the month just fetched; any failure keeps the month counters, which are
  // still truthful, just over a different window than the credit ring.
  let counters = month;
  const periodStart = dayFromIso(month.credits?.period_start);
  if (periodStart && periodStart < monthStart) {
    try {
      counters = await fetchUsageWindow(base, periodStart, apiKey, input, fetchApi);
    } catch {
      counters = month;
    }
  }

  const quota = await quotaPromise;
  // Catalog quotas are published for api.nan.builders; a mirror host (e.g. Helmcode) may
  // meter differently, so its rings are limited to what its own API reports.
  return toUsageReport({ counters, month, quota, catalogRings: isDefaultHost });
}

export async function discover(): Promise<UsageAccount[]> {
  const candidates: Array<{ input: UsageInput; harness?: string }> = [
    ...ENV_KEY_LOCATORS.map((locator) => ({ input: { store: "env" as const, locator } })),
    ...fileKeyLocators().map((locator) => ({ input: { store: "file" as const, locator } })),
    // The login created with OpenCode's `/connect` flow; OpenCode owns refreshing it,
    // this source only reads. Disabled when NAN_USAGE_NO_OPENCODE=1.
    ...(openCodeStoreAllowed()
      ? OPENCODE_INTEGRATIONS.flatMap((locator) => [
          { input: { store: "opencode" as const, locator }, harness: "OpenCode" },
          { input: { store: "opencode_config" as const, locator }, harness: "OpenCode" },
        ])
      : []),
  ];
  const accounts: UsageAccount[] = [];
  // All logins share the "default" key, so Paseo groups them into one nan card and
  // prefers them in order (env, then files, then OpenCode). Never put the key itself in inputs.
  for (const candidate of candidates)
    if (await readApiKey(candidate.input))
      accounts.push({ key: "default", harness: candidate.harness, input: candidate.input });
  return accounts;
}
