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
});

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
 * Documented per-member quotas, metered against the calendar month (per the 402 docs:
 * "the calendar month for the models counted per month"). nan's `/usage` endpoint does
 * not expose limits per account, so these come from the model catalog at
 * https://nan.builders/docs/models and are checked against the OpenAPI description.
 *
 * Deliberately absent: glm5.3's 3,000M allowance resets on the member's billing period
 * (not derivable from calendar rows) and its 400M cap is per rolling 4h (finer than the
 * daily granularity of /usage rows). Showing either would misstate the quota.
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
  { id: "deepseek-v4-flash", label: "deepseek-v4-flash", unit: "tokens", limit: 3e9, models: ["deepseek-v4-flash"] },
  { id: "mimo-v2.6-flash", label: "mimo-v2.6-flash", unit: "tokens", limit: 1e9, models: ["mimo-v2.6-flash"] },
  { id: "qwen3.8-flash", label: "qwen3.8-flash", unit: "tokens", limit: 5e8, models: ["qwen3.8-flash"] },
  { id: "glm5.3-flash", label: "glm5.3-flash", unit: "tokens", limit: 2e9, models: ["glm5.3-flash"] },
  // flux-2-klein and qwen-image-2.1 share one 100-requests/month pool ("shared with
  // flux-2-klein" in the catalog). The pool counts requests, not images.
  { id: "image-pool", label: "Images", unit: "requests", limit: 100, models: ["flux-2-klein", "qwen-image-2.1"] },
];

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
 * Rings from the live quota service. Periods use the endpoint's own vocabulary
 * (`periodEnd` per model; for glm5.3 that is the billing cycle, not a calendar month).
 * Rolling sub-windows come with a reported duration, so the SDK helper names them
 * ("4-hour"/"4h"). A model without an allowance or with cap 0 is unmetered: no ring.
 * Entries with zero usage show no ring either: the service lists the full model
 * catalog regardless of tier, so a 0% glm5.3 ring on a non-premium member would be
 * noise about a model the key cannot even call. Real usage implies reachability.
 */
export function buildLiveWindows(quota: QuotaResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const entry of quota.models) {
    const slug = slugify(entry.model);
    const allowance = positiveNumber(entry.fullCap) ?? positiveNumber(entry.cap);
    const used = typeof entry.tokensUsed === "number" && Number.isFinite(entry.tokensUsed) ? entry.tokensUsed : null;
    if (allowance !== undefined && used !== null && used > 0) {
      const pct = usedPctOf(used, allowance);
      windows.push(
        windowFromUsedPct({
          id: `${slug}:period`,
          label: `${entry.model} · Current period`,
          utilizationPct: pct,
          resetsAt: isoOrNull(entry.periodEnd ?? quota.periodEnd),
          summary: true,
          tone: toneFromUsedPct(pct),
        }),
      );
    }
    if (typeof entry.windowTokensUsed === "number" && entry.windowTokensUsed > 0) {
      const budget = positiveNumber(entry.fullWindowTokens) ?? positiveNumber(entry.windowTokens);
      if (budget !== undefined) {
        const hours = positiveNumber(entry.windowHours);
        windows.push(
          windowFromReportedDuration({
            durationSeconds: hours !== undefined ? hours * 3600 : null,
            scope: { id: slug, label: entry.model },
            unknown: { id: "rolling", label: "Rolling", shortLabel: "roll" },
            utilizationPct: (entry.windowTokensUsed / budget) * 100,
            resetsAt: isoOrNull(entry.windowResetsAt),
            summary: true,
            tone: toneFromUsedPct((entry.windowTokensUsed / budget) * 100),
          }),
        );
      }
    }
  }
  return windows;
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
 * Rings for the documented monthly quotas, built only for quotas the member touched
 * this month; a 0% ring for an unused model is noise. glm5.3 intentionally has no ring
 * (its period is the billing cycle, not the calendar month).
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

export function toUsageReport(
  resp: UsageResponse,
  quota?: QuotaResponse | null,
  catalogRings = true,
): UsageReport {
  const balances: UsageBalance[] = [];
  const details: UsageDetail[] = [];

  const monthTotal = resp.totals.total_tokens;
  if (typeof monthTotal === "number")
    balances.push({ id: "month_tokens", label: "Tokens · this month", used: monthTotal, unit: "tokens" });

  const monthRequests = resp.totals.api_requests;
  if (typeof monthRequests === "number")
    balances.push({ id: "month_requests", label: "Requests · this month", used: monthRequests, unit: "requests" });

  if (resp.all_time && typeof resp.all_time.total_tokens === "number")
    balances.push({
      id: "all_time_tokens",
      label: "Tokens · all time",
      used: resp.all_time.total_tokens,
      unit: "tokens",
    });

  details.push({
    id: "window",
    label: "Window (UTC)",
    value: `${resp.start_date} → ${resp.end_date}`,
  });

  const prompt = resp.totals.prompt_tokens;
  const completion = resp.totals.completion_tokens;
  if (typeof prompt === "number" && typeof completion === "number")
    details.push({
      id: "split",
      label: "In / Out",
      value: `${compactTokens(prompt)} / ${compactTokens(completion)}`,
    });

  const seen = new Set<string>();
  const models = [...resp.totals.by_model].sort(
    (a, b) => (b.total_tokens ?? 0) - (a.total_tokens ?? 0) || a.model.localeCompare(b.model),
  );
  for (const model of models) {
    let id = `model_${slugify(model.model)}`;
    if (seen.has(id)) id = `${id}_${seen.size}`;
    seen.add(id);
    details.push({
      id,
      label: model.model,
      value: `${compactTokens(model.total_tokens)} tok · ${compactTokens(model.api_requests)} req`,
    });
  }

  return {
    status: "available",
    planLabel: undefined,
    // Live quota rings when the dashboard service answered; documented catalog rings
    // otherwise; none when the counters themselves came from a mirror host.
    windows: quota
      ? buildLiveWindows(quota)
      : catalogRings
        ? buildMonthlyWindows(resp.totals.by_model)
        : [],
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

  const url = new URL("usage", base.endsWith("/") ? base : `${base}/`);
  // Month-to-date in UTC: exactly the window the documented monthly quotas count,
  // and `totals` / `totals.by_model` cover the full window regardless of pagination,
  // so `limit=1` keeps the page tiny. `all_time` is always present in the response.
  url.searchParams.set("start_date", monthStartUtc());
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
    return unavailable({
      kind: "rejected",
      status: res.status,
      ...(input.store === "opencode" || input.store === "opencode_config" ? { refreshedBy: "opencode" } : {}),
    });
  if (res.status === 404)
    return unavailable({
      kind: "no_quota",
      detail:
        "This nan account has no usage identity yet: it needs an API key, a linked Discord account, or a handle.",
    });
  if (!res.ok) throw new Error(`nan usage API returned ${res.status}`);

  const quota = await quotaPromise;
  // Catalog quotas are published for api.nan.builders; a mirror host (e.g. Helmcode) may
  // meter differently, so there neither live nor catalog rings are applied.
  return toUsageReport(UsageResponseSchema.parse(await res.json()), quota, isDefaultHost);
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
