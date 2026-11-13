import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCreditBalances,
  buildCreditWindows,
  buildLiveWindows,
  buildMonthlyWindows,
  discover,
  fetchUsage,
  monthStartUtc,
  nextMonthResetIso,
  planLabelFor,
  readApiKey,
  toUsageReport,
} from "./usage.js";

/** `2026-11-01` shifted by `days`, as an ISO instant: fixtures stay valid whenever they run. */
function monthOffsetIso(days: number): string {
  return new Date(Date.parse(`${monthStartUtc()}T00:00:00Z`) + days * 86_400_000).toISOString();
}

const MONTH_WINDOW = { start_date: monthStartUtc(), end_date: monthStartUtc() };

const TOTALS = {
  prompt_tokens: 2450000,
  completion_tokens: 890000,
  total_tokens: 3340000,
  api_requests: 12500,
  cached_tokens: 480000,
  credits: 82.8,
  by_model: [
    {
      model: "glm5.3",
      prompt_tokens: 1300000,
      completion_tokens: 440000,
      total_tokens: 1740000,
      api_requests: 8200,
      cached_tokens: 320000,
      credits: 51.3,
    },
    {
      model: "qwen3.8-flash",
      prompt_tokens: 1150000,
      completion_tokens: 450000,
      total_tokens: 1600000,
      api_requests: 4300,
      cached_tokens: 160000,
      credits: 31.5,
    },
    { model: "gemma4", prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, api_requests: 0, credits: 0 },
    { model: "flux-2-klein", prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, api_requests: 30 },
    { model: "qwen-image-2.1", prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, api_requests: 21 },
  ],
};

const ALL_TIME = {
  prompt_tokens: 9800000,
  completion_tokens: 3400000,
  total_tokens: 13200000,
  api_requests: 41250,
  cached_at: "2026-02-01T12:00:00Z",
};

/** Inference plan: 7,000 credits a period, this account has spent a fraction of them. */
const CREDITS = {
  period_start: monthOffsetIso(-3),
  period_end: monthOffsetIso(27),
  allowance: 7000,
  used: 82.8,
  remaining: 6917.2,
  pack_credits: 1000,
  pack_expires_at: monthOffsetIso(60),
  frozen: false,
};

function usageBody(over: Record<string, unknown> = {}) {
  return {
    object: "usage.report",
    ...MONTH_WINDOW,
    data: [],
    totals: TOTALS,
    all_time: ALL_TIME,
    has_more: false,
    next_cursor: null,
    credits: null,
    ...over,
  };
}

const SAMPLE_REPORT = usageBody();

// Fixture shaped like the real dashboard quota payload (per streamdeck-nan tests). It still
// carries the legacy per-model token caps; only the rolling window is rendered from it.
const QUOTA_SAMPLE = {
  periodStart: "2026-10-01",
  models: [
    {
      model: "deepseek-v4-flash",
      tokensUsed: 1218820529,
      cap: 3000000000,
      fullCap: 3000000000,
      periodEnd: "2026-11-01T00:00:00Z",
    },
    {
      model: "glm5.3",
      tokensUsed: 1740000,
      cap: 3000000000,
      periodEnd: monthOffsetIso(12),
      windowHours: 4,
      windowTokensUsed: 120000000,
      fullWindowTokens: 400000000,
      windowResetsAt: "2026-10-29T08:00:00Z",
    },
    { model: "qwen-image-2.1", tokensUsed: 5, cap: 0 },
  ],
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface Stub {
  body?: unknown;
  status?: number;
}

/**
 * Routes the three origins the plugin may call: the dashboard quota service, the month-to-date
 * usage page, and the billing-period page (any other `start_date`). A stub without `body`
 * reuses `SAMPLE_REPORT`.
 */
function nanFetch(
  routes: { month?: Stub; period?: Stub; quota?: Stub },
  calls: string[] = [],
): (input: Parameters<typeof fetch>[0]) => Promise<Response> {
  return (input: Parameters<typeof fetch>[0]) => {
    const text = String(input);
    calls.push(text);
    if (text.startsWith("https://cloud-api.nan.builders/"))
      return Promise.resolve(jsonResponse(routes.quota?.body ?? {}, routes.quota?.status ?? 200));
    const start = new URL(text).searchParams.get("start_date");
    const stub = start === monthStartUtc() ? routes.month : routes.period;
    if (stub === undefined && routes.period === undefined && start !== monthStartUtc())
      throw new Error(`unexpected usage request for start_date=${start}`);
    return Promise.resolve(jsonResponse(stub?.body ?? SAMPLE_REPORT, stub?.status ?? 200));
  };
}

const envInput = { store: "env" as const, locator: "NAN_API_KEY_TEST" };

describe("calendar helpers", () => {
  it("pins month start and reset to UTC", () => {
    const now = new Date("2026-02-15T10:00:00Z");
    expect(monthStartUtc(now)).toBe("2026-02-01");
    expect(nextMonthResetIso(now)).toBe("2026-03-01T00:00:00.000Z");
  });
});

describe("fetchUsage", () => {
  beforeEach(() => {
    process.env[envInput.locator] = "sk-test-key";
  });
  afterEach(() => {
    delete process.env[envInput.locator];
  });

  it("renders the credits ring and re-reads the counters over the billing period", async () => {
    const calls: string[] = [];
    const periodStart = monthOffsetIso(-3).slice(0, 10);
    const month = usageBody({ credits: CREDITS });
    const period = usageBody({
      start_date: periodStart,
      end_date: monthStartUtc(),
      credits: CREDITS,
      totals: { ...TOTALS, total_tokens: 5340000, api_requests: 19000 },
    });
    const report = await fetchUsage(
      envInput,
      nanFetch({ month: { body: month }, period: { body: period }, quota: { body: QUOTA_SAMPLE } }, calls),
    );
    expect(report.status).toBe("available");
    if (report.status !== "available") return;

    const usageDates = calls
      .filter((c) => c.startsWith("https://api.nan.builders/"))
      .map((c) => new URL(c).searchParams.get("start_date"));
    expect(usageDates).toEqual([monthStartUtc(), periodStart]);
    expect(calls.every((c) => new URL(c).searchParams.get("limit") === "1" || c.startsWith("https://cloud-api"))).toBe(
      true,
    );

    // One allowance ring for the whole account, the calendar image budget, and the rolling window.
    expect(report.windows.map((w) => w.id)).toEqual(["credits:period", "image-pool:monthly", "glm5.3:14400s"]);
    const credits = report.windows[0]!;
    expect(credits.label).toBe("Credits · Current period");
    expect(credits.usedPct).toBeCloseTo((82.8 / 7000) * 100, 5);
    expect(credits.resetsAt).toBe(new Date(CREDITS.period_end).toISOString());
    expect(credits.tone).toBe("ok");

    expect(report.planLabel).toBe("Inference");
    const balances = report.balances ?? [];
    expect(balances.map((b) => [b.id, b.unit])).toEqual([
      ["credits_period", "credits"],
      ["credits_packs", "credits"],
      ["window_tokens", "tokens"],
      ["window_requests", "requests"],
      ["all_time_tokens", "tokens"],
    ]);
    const creditBalance = balances.find((b) => b.id === "credits_period")!;
    expect(creditBalance.label).toBe("Credits · this period");
    expect(creditBalance.used).toBe(82.8);
    expect(creditBalance.remaining).toBe(6917.2);
    expect(creditBalance.limit).toBe(7000);
    // The counters beside the ring follow the period, not the calendar month.
    expect(balances.find((b) => b.id === "window_tokens")?.used).toBe(5340000);
    expect(balances.find((b) => b.id === "window_tokens")?.label).toBe("Tokens · this period");

    const details = report.details ?? [];
    expect(details.find((d) => d.id === "window")).toEqual({
      id: "window",
      label: "Billing period (UTC)",
      value: `${periodStart} → ${monthStartUtc()}`,
    });
    expect(details.find((d) => d.label === "glm5.3")?.value).toBe("51.3 cr · 1.74M tok · 8.2k req");
    // The credit-hungry models lead, and unmetered ones still show what they used.
    expect(details.filter((d) => d.id.startsWith("model_")).map((d) => d.label)).toEqual([
      "glm5.3",
      "qwen3.8-flash",
      "flux-2-klein",
      "gemma4",
      "qwen-image-2.1",
    ]);
  });

  it("keeps the month window when the billing period starts on the 1st", async () => {
    const calls: string[] = [];
    const credits = { ...CREDITS, period_start: `${monthStartUtc()}T00:00:00Z` };
    const report = await fetchUsage(
      envInput,
      nanFetch({ month: { body: usageBody({ credits }) }, quota: { body: QUOTA_SAMPLE } }, calls),
    );
    expect(calls.filter((c) => c.startsWith("https://api.nan.builders/")).length).toBe(1);
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    expect(report.details?.find((d) => d.id === "window")?.label).toBe("Window (UTC)");
    expect(report.balances?.find((b) => b.id === "window_tokens")?.label).toBe("Tokens · this month");
  });

  it("shows no credit ring for accounts the API does not bill in credits", async () => {
    const report = await fetchUsage(envInput, nanFetch({ month: { body: SAMPLE_REPORT }, quota: { body: {} } }));
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    expect(report.windows.map((w) => w.id)).toEqual(["image-pool:monthly"]);
    expect(report.planLabel).toBeUndefined();
    expect(report.balances?.map((b) => b.id)).toEqual([
      "window_tokens",
      "window_requests",
      "all_time_tokens",
    ]);
  });

  it("falls back to per-model quotas on a plan without credits, like Gentle", async () => {
    const report = await fetchUsage(
      envInput,
      nanFetch({ month: { body: SAMPLE_REPORT }, quota: { body: QUOTA_SAMPLE } }),
    );
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    // No credits block: the quota service's caps are this account's real allowance.
    expect(report.windows.map((w) => w.id)).toEqual([
      "image-pool:monthly",
      "deepseek-v4-flash:period",
      "glm5.3:14400s",
      "glm5.3:period",
    ]);
    expect(report.balances?.some((b) => b.unit === "credits")).toBe(false);
  });

  it("warns while the subscription is frozen", async () => {
    const credits = { ...CREDITS, period_start: `${monthStartUtc()}T00:00:00Z`, frozen: true };
    const report = await fetchUsage(
      envInput,
      nanFetch({ month: { body: usageBody({ credits }) }, quota: { body: {} } }),
    );
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    expect(report.windows[0]?.tone).toBe("danger");
    expect(report.balances?.find((b) => b.id === "credits_period")?.tone).toBe("danger");
    const frozen = report.details?.find((d) => d.id === "frozen");
    expect(frozen?.tone).toBe("danger");
    expect(frozen?.value).toMatch(/Frozen/);
  });

  it("falls back to the month counters when the period page fails", async () => {
    const calls: string[] = [];
    const report = await fetchUsage(
      envInput,
      nanFetch(
        { month: { body: usageBody({ credits: CREDITS }) }, period: { body: {}, status: 500 }, quota: { body: {} } },
        calls,
      ),
    );
    expect(calls.filter((c) => c.startsWith("https://api.nan.builders/")).length).toBe(2);
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    expect(report.windows.map((w) => w.id)).toEqual(["credits:period", "image-pool:monthly"]);
    expect(report.balances?.find((b) => b.id === "window_tokens")?.label).toBe("Tokens · this month");
  });

  it("ignores the legacy per-model token caps and keeps only the rolling window", async () => {
    const report = await fetchUsage(
      envInput,
      nanFetch({ month: { body: usageBody({ credits: CREDITS }) }, period: { body: usageBody({ credits: CREDITS }) }, quota: { body: QUOTA_SAMPLE } }),
    );
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    expect(report.windows.some((w) => w.id.endsWith(":period") && w.id !== "credits:period")).toBe(false);
    expect(report.windows.some((w) => w.id === "glm5.3:14400s")).toBe(true);
  });

  it("treats quota transport failures as absent, not fatal", async () => {
    const report = await fetchUsage(
      envInput,
      nanFetch({ month: { body: SAMPLE_REPORT }, quota: { body: { error: "boom" }, status: 503 } }),
    );
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    expect(report.windows.map((w) => w.id)).toEqual(["image-pool:monthly"]);
  });

  it("honors an api_base override: no quota call and no catalog rings", async () => {
    const calls: string[] = [];
    const credits = { ...CREDITS, period_start: `${monthStartUtc()}T00:00:00Z` };
    const report = await fetchUsage(
      { ...envInput, api_base: "https://api.helmcode.com/v1/" },
      nanFetch({ month: { body: usageBody({ credits }) }, quota: { body: QUOTA_SAMPLE } }, calls),
    );
    expect(calls.some((c) => c.startsWith("https://cloud-api.nan.builders/"))).toBe(false);
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    // What the mirror reports about itself still renders; the nan catalog does not.
    expect(report.windows.map((w) => w.id)).toEqual(["credits:period"]);
    expect((report.balances?.length ?? 0) > 0).toBe(true);
  });

  it("reports auth rejections as unavailable", async () => {
    const report = await fetchUsage(envInput, () => Promise.resolve(jsonResponse({}, 401)));
    expect(report).toEqual({ status: "unavailable", problem: { kind: "rejected", status: 401 } });
  });

  it("reports a missing usage identity as no_quota", async () => {
    const report = await fetchUsage(envInput, () => Promise.resolve(jsonResponse({}, 404)));
    expect(report.status).toBe("unavailable");
    if (report.status !== "unavailable") return;
    expect(report.problem.kind).toBe("no_quota");
  });

  it("surfaces a rate limit when Retry-After exceeds the fetch deadline", async () => {
    let calls = 0;
    await expect(
      fetchUsage(envInput, (input) => {
        if (String(input).startsWith("https://cloud-api")) return Promise.resolve(jsonResponse({}));
        calls += 1;
        return Promise.resolve(jsonResponse({}, 429, { "retry-after": "600" }));
      }),
    ).rejects.toThrow(/rate limited/);
    expect(calls).toBe(1);
  });

  it("retries once on a short Retry-After and succeeds", async () => {
    let calls = 0;
    const report = await fetchUsage(envInput, (input) => {
      if (String(input).startsWith("https://cloud-api")) return Promise.resolve(jsonResponse({})); // invalid: fallback
      calls += 1;
      return Promise.resolve(
        calls === 1 ? jsonResponse({}, 429, { "retry-after": "0" }) : jsonResponse(SAMPLE_REPORT),
      );
    });
    expect(calls).toBe(2);
    expect(report.status).toBe("available");
  });

  it("throws when the credential store disappeared after discovery", async () => {
    delete process.env[envInput.locator];
    await expect(
      fetchUsage(envInput, () => Promise.resolve(jsonResponse(SAMPLE_REPORT))),
    ).rejects.toThrow("nan credential store no longer exists");
  });
});

describe("buildCreditWindows", () => {
  it("meters the whole pool against the allowance and resets on the billing date", () => {
    const windows = buildCreditWindows(CREDITS);
    expect(windows.map((w) => w.id)).toEqual(["credits:period"]);
    expect(windows[0]?.usedPct).toBeCloseTo((82.8 / 7000) * 100, 5);
    expect(windows[0]?.resetsAt).toBe(new Date(CREDITS.period_end).toISOString());
  });

  it("reads danger while the subscription is frozen", () => {
    expect(buildCreditWindows({ ...CREDITS, frozen: true })[0]?.tone).toBe("danger");
  });

  it("shows no ring without an allowance: pack-only accounts have no percentage to draw", () => {
    expect(buildCreditWindows(null)).toEqual([]);
    expect(buildCreditWindows({ ...CREDITS, allowance: 0 })).toEqual([]);
    expect(buildCreditWindows({ ...CREDITS, used: undefined })).toEqual([]);
  });
});

describe("buildCreditBalances", () => {
  it("reports the allowance and the packs left", () => {
    const balances = buildCreditBalances(CREDITS);
    expect(balances.map((b) => b.id)).toEqual(["credits_period", "credits_packs"]);
    expect(balances[1]?.remaining).toBe(1000);
    expect(balances[1]?.resetsAt).toBe(new Date(CREDITS.pack_expires_at).toISOString());
  });

  it("derives the remainder when the API omits it", () => {
    const { remaining: _drop, ...rest } = CREDITS;
    expect(buildCreditBalances(rest)[0]?.remaining).toBeCloseTo(7000 - 82.8, 5);
  });

  it("skips empty packs and accounts with no allowance", () => {
    expect(buildCreditBalances({ ...CREDITS, allowance: 0 })[0]?.id).toBe("credits_packs");
    expect(buildCreditBalances({ ...CREDITS, pack_credits: 0 }).map((b) => b.id)).toEqual(["credits_period"]);
    expect(buildCreditBalances(null)).toEqual([]);
  });
});

describe("planLabelFor", () => {
  it("names the tier from its documented allowance", () => {
    expect(planLabelFor(CREDITS)).toBe("Inference");
    expect(planLabelFor({ ...CREDITS, allowance: 20000 })).toBe("Premium");
    expect(planLabelFor({ ...CREDITS, allowance: 1234 })).toBeUndefined();
    expect(planLabelFor(null)).toBeUndefined();
  });
});

describe("buildLiveWindows", () => {
  it("drops the per-model token caps on a credit-billed account: the pool is the allowance", () => {
    expect(
      buildLiveWindows(
        {
          models: [
            { model: "m", tokensUsed: 50, cap: 100, fullCap: 200 },
            { model: "free", tokensUsed: 7, cap: 0 },
            { model: "unmetered", tokensUsed: 9 },
          ],
        },
        true,
      ),
    ).toEqual([]);
  });

  it("keeps them for an account without credits: the Gentle plan still meters per model", () => {
    const windows = buildLiveWindows(
      {
        periodEnd: "2026-12-01T00:00:00Z",
        models: [
          { model: "m", tokensUsed: 50, cap: 100, fullCap: 200 },
          { model: "unused", tokensUsed: 0, cap: 100 },
          { model: "uncapped", tokensUsed: 12 },
        ],
      },
      false,
    );
    expect(windows.map((w) => w.id)).toEqual(["m:period"]);
    // fullCap wins over the prorated first-period cap, and the root periodEnd is the reset.
    expect(windows[0]?.usedPct).toBeCloseTo(25, 5);
    expect(windows[0]?.resetsAt).toBe("2026-12-01T00:00:00.000Z");
  });

  it("prefers a model's own periodEnd over the root one", () => {
    const windows = buildLiveWindows(
      {
        periodEnd: "2026-12-01T00:00:00Z",
        models: [{ model: "m", tokensUsed: 1, cap: 100, periodEnd: "2026-10-17T05:53:20Z" }],
      },
      false,
    );
    expect(windows[0]?.resetsAt).toBe("2026-10-17T05:53:20.000Z");
  });

  it("names a rolling sub-window from its reported duration", () => {
    const windows = buildLiveWindows(
      {
        models: [{ model: "glm5.3", windowHours: 4, windowTokensUsed: 360000000, fullWindowTokens: 400000000 }],
      },
      true,
    );
    expect(windows.map((w) => w.id)).toEqual(["glm5.3:14400s"]);
    expect(windows[0]?.label).toBe("glm5.3 · 4-hour");
    expect(windows[0]?.usedPct).toBeCloseTo(90, 5);
    expect(windows[0]?.tone).toBe("warning");
  });

  it("uses a neutral Rolling identity when the duration is not reported", () => {
    const windows = buildLiveWindows({ models: [{ model: "x", windowTokensUsed: 1, windowTokens: 2 }] }, true);
    expect(windows[0]?.id).toBe("x:rolling");
    expect(windows[0]?.label).toBe("x · Rolling");
  });

  it("skips empty rolling windows and models without a budget", () => {
    expect(
      buildLiveWindows(
        {
          models: [
            { model: "glm5.3", windowHours: 4, windowTokensUsed: 0, fullWindowTokens: 400000000 },
            { model: "glm5.2", windowHours: 4, windowTokensUsed: 5000 },
          ],
        },
        true,
      ),
    ).toEqual([]);
  });
});

describe("buildMonthlyWindows", () => {
  it("skips quotas without month usage", () => {
    expect(buildMonthlyWindows([])).toEqual([]);
    // Token-using chat models no longer have a catalog ring of their own: only images do.
    expect(
      buildMonthlyWindows([{ model: "qwen3.8-flash", total_tokens: 4.8e8, api_requests: 10 }]),
    ).toEqual([]);
  });

  it("counts the shared image pool and flags a spent budget", () => {
    const windows = buildMonthlyWindows([
      { model: "flux-2-klein", api_requests: 60 },
      { model: "qwen-image-2.1", api_requests: 40 },
    ]);
    expect(windows.map((w) => w.id)).toEqual(["image-pool:monthly"]);
    expect(windows[0]?.usedPct).toBeCloseTo(100, 5);
    expect(windows[0]?.tone).toBe("danger");
    expect(windows[0]?.resetsAt).toBe(nextMonthResetIso());
  });
});

// node:sqlite slice used by the opencode store; tests run on Node 22+ where it exists.
interface TestSqliteStatement {
  run(...params: unknown[]): void;
}
interface TestSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): TestSqliteStatement;
  close(): void;
}
async function loadSqlite(): Promise<{ DatabaseSync: new (path: string) => TestSqliteDatabase }> {
  const specifier: string = "node:sqlite";
  return (await import(specifier)) as unknown as { DatabaseSync: new (path: string) => TestSqliteDatabase };
}

interface CredentialSeed {
  id: string;
  integration: string;
  value: unknown;
  active?: boolean;
  updated?: number;
}

async function seedOpenCodeDb(opencodeDir: string, seeds: CredentialSeed[]): Promise<void> {
  await mkdir(opencodeDir, { recursive: true });
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(join(opencodeDir, "opencode.db"));
  db.exec(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT," +
      " connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)",
  );
  const insert = db.prepare(
    "INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  seeds.forEach((seed, index) => {
    insert.run(
      seed.id,
      seed.integration,
      seed.integration,
      JSON.stringify(seed.value),
      seed.active === false ? 0 : 1,
      index,
      seed.updated ?? index,
    );
  });
  db.close();
}

describe("readApiKey (opencode store)", () => {
  let dir = "";
  const previousXdg = process.env.XDG_DATA_HOME;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nan-opencode-test-"));
    process.env.XDG_DATA_HOME = dir;
  });
  afterEach(async () => {
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
    delete process.env.NAN_USAGE_NO_OPENCODE;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("still reads credentials by default and stops when NAN_USAGE_NO_OPENCODE=1 is set", async () => {
    await seedOpenCodeDb(join(dir, "opencode"), [
      { id: "c1", integration: "nan", value: { type: "key", key: "sk-guarded" } },
    ]);
    expect(await readApiKey({ store: "opencode", locator: "nan" })).toBe("sk-guarded");
    process.env.NAN_USAGE_NO_OPENCODE = "1";
    expect(await readApiKey({ store: "opencode", locator: "nan" })).toBeUndefined();
  });

  it("prefers the newest active key credential of the integration", async () => {
    await seedOpenCodeDb(join(dir, "opencode"), [
      { id: "c1", integration: "nan", value: { type: "key", key: "sk-active-old" }, updated: 1 },
      { id: "c2", integration: "nan", value: { type: "key", key: "sk-active-new" }, updated: 5 },
      { id: "c3", integration: "nan", value: { type: "key", key: "sk-inactive" }, active: false, updated: 9 },
      { id: "c4", integration: "other", value: { type: "key", key: "sk-other" }, updated: 7 },
    ]);
    expect(await readApiKey({ store: "opencode", locator: "nan" })).toBe("sk-active-new");
  });

  it("ignores oauth credentials: /usage needs the sk- API key", async () => {
    await seedOpenCodeDb(join(dir, "opencode"), [
      {
        id: "o1",
        integration: "nan",
        value: { type: "oauth", methodID: "m", refresh: "r", access: "a", expires: 123 },
      },
    ]);
    expect(await readApiKey({ store: "opencode", locator: "nan" })).toBeUndefined();
  });

  it("falls back to the v1 auth.json layout", async () => {
    await mkdir(join(dir, "opencode"), { recursive: true });
    await writeFile(
      join(dir, "opencode", "auth.json"),
      JSON.stringify({ nan: { type: "api", key: "sk-legacy" } }),
      "utf8",
    );
    expect(await readApiKey({ store: "opencode", locator: "nan" })).toBe("sk-legacy");
  });

  it("is undefined when OpenCode is not installed at all", async () => {
    expect(await readApiKey({ store: "opencode", locator: "nan" })).toBeUndefined();
  });

  it("is undefined when the database has no credential for the integration", async () => {
    await seedOpenCodeDb(join(dir, "opencode"), [
      { id: "c1", integration: "other", value: { type: "key", key: "sk-other" } },
    ]);
    expect(await readApiKey({ store: "opencode", locator: "nan" })).toBeUndefined();
  });

  it("names opencode as the credential refresher when the key is rejected", async () => {
    await seedOpenCodeDb(join(dir, "opencode"), [
      { id: "c1", integration: "nan", value: { type: "key", key: "sk-rejected" } },
    ]);
    const report = await fetchUsage({ store: "opencode", locator: "nan" }, () =>
      Promise.resolve(jsonResponse({}, 401)),
    );
    expect(report).toEqual({
      status: "unavailable",
      problem: { kind: "rejected", status: 401, refreshedBy: "opencode" },
    });
  });
});

describe("readApiKey (opencode_config store)", () => {
  let dir = "";
  let configDir = "";
  const previousXdgConfig = process.env.XDG_CONFIG_HOME;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nan-occonfig-test-"));
    process.env.XDG_CONFIG_HOME = dir;
    configDir = join(dir, "opencode");
    await mkdir(configDir, { recursive: true });
  });
  afterEach(async () => {
    if (previousXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfig;
    delete process.env.NAN_USAGE_NO_OPENCODE;
    delete process.env.NAN_TEST_ENV_KEY;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reads provider.nan.options.apiKey from the global opencode.json", async () => {
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        provider: {
          nan: {
            npm: "@ai-sdk/openai-compatible",
            name: "NaN",
            options: { baseURL: "https://api.nan.builders/v1", apiKey: "sk-config-key" },
          },
        },
      }),
      "utf8",
    );
    expect(await readApiKey({ store: "opencode_config", locator: "nan" })).toBe("sk-config-key");
  });

  it("accepts JSONC comments and trailing commas", async () => {
    await writeFile(
      join(configDir, "opencode.jsonc"),
      `{
  // NaN provider, from https://nan.builders/docs/opencode
  "provider": {
    "nan": {
      "options": {
        "apiKey": "sk-jsonc-key", /* inline */
      },
    },
  },
}`,
      "utf8",
    );
    expect(await readApiKey({ store: "opencode_config", locator: "nan" })).toBe("sk-jsonc-key");
  });

  it("substitutes {env:VAR} and {file:path} like OpenCode does", async () => {
    process.env.NAN_TEST_ENV_KEY = "sk-env-key";
    await writeFile(join(configDir, "nan.key"), "  sk-file-key\n", "utf8");
    await writeFile(
      join(configDir, "opencode.json"),
      '{"provider":{"nan":{"options":{"apiKey":"{env:NAN_TEST_ENV_KEY}"}}},' +
        '"note":"second file wins over nothing"}',
      "utf8",
    );
    expect(await readApiKey({ store: "opencode_config", locator: "nan" })).toBe("sk-env-key");
    await writeFile(
      join(configDir, "opencode.json"),
      '{"provider":{"nan":{"options":{"apiKey":"{file:nan.key}"}}}}',
      "utf8",
    );
    expect(await readApiKey({ store: "opencode_config", locator: "nan" })).toBe("sk-file-key");
  });

  it("returns undefined for missing configs, unknown providers and empty templates", async () => {
    expect(await readApiKey({ store: "opencode_config", locator: "nan" })).toBeUndefined();
    await writeFile(join(configDir, "opencode.json"), '{"provider":{"other":{"options":{"apiKey":"sk-x"}}}}', "utf8");
    expect(await readApiKey({ store: "opencode_config", locator: "nan" })).toBeUndefined();
    await writeFile(join(configDir, "opencode.json"), '{"provider":{"nan":{"options":{"apiKey":"{env:ABSENT_VAR}"}}}}', "utf8");
    expect(await readApiKey({ store: "opencode_config", locator: "nan" })).toBeUndefined();
  });

  it("is silenced by the same NAN_USAGE_NO_OPENCODE switch", async () => {
    await writeFile(
      join(configDir, "opencode.json"),
      '{"provider":{"nan":{"options":{"apiKey":"sk-guarded"}}}}',
      "utf8",
    );
    expect(await readApiKey({ store: "opencode_config", locator: "nan" })).toBe("sk-guarded");
    process.env.NAN_USAGE_NO_OPENCODE = "1";
    expect(await readApiKey({ store: "opencode_config", locator: "nan" })).toBeUndefined();
  });
});

describe("discover", () => {
  it("lists the NAN_API_KEY env store when it holds a key", async () => {
    const previous = process.env.NAN_API_KEY;
    process.env.NAN_API_KEY = "sk-discover-test";
    try {
      const accounts = await discover();
      const envAccount = accounts.find(
        (account) =>
          typeof account.input === "object" &&
          account.input !== null &&
          !Array.isArray(account.input) &&
          "locator" in account.input &&
          account.input.locator === "NAN_API_KEY",
      );
      expect(envAccount?.key).toBe("default");
    } finally {
      if (previous === undefined) delete process.env.NAN_API_KEY;
      else process.env.NAN_API_KEY = previous;
    }
  });

  it("includes the OpenCode /connect login tagged with its harness", async () => {
    const previousEnv = process.env.NAN_API_KEY;
    const previousXdg = process.env.XDG_DATA_HOME;
    const dir = await mkdtemp(join(tmpdir(), "nan-discover-opencode-"));
    process.env.XDG_DATA_HOME = dir;
    delete process.env.NAN_API_KEY;
    try {
      await seedOpenCodeDb(join(dir, "opencode"), [
        { id: "c1", integration: "nan", value: { type: "key", key: "sk-discovered" } },
      ]);
      const accounts = await discover();
      const account = accounts.find(
        (candidate) =>
          typeof candidate.input === "object" &&
          candidate.input !== null &&
          !Array.isArray(candidate.input) &&
          "store" in candidate.input &&
          candidate.input.store === "opencode",
      );
      expect(account?.key).toBe("default");
      expect(account?.harness).toBe("OpenCode");
    } finally {
      if (previousEnv === undefined) delete process.env.NAN_API_KEY;
      else process.env.NAN_API_KEY = previousEnv;
      if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdg;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("toUsageReport", () => {
  it("degrades gracefully when counters are missing", () => {
    const empty = { start_date: "2026-11-01", end_date: "2026-11-01", totals: { by_model: [] } };
    const report = toUsageReport({ counters: empty, month: empty });
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    expect(report.windows).toEqual([]);
    expect(report.balances).toEqual([]);
    expect(report.details?.map((d) => d.id)).toEqual(["window"]);
  });

  it("reports the image budget on the calendar month even when counters span the period", () => {
    const month = usageBody({ credits: CREDITS });
    const period = usageBody({
      start_date: monthOffsetIso(-3).slice(0, 10),
      credits: CREDITS,
      totals: { ...TOTALS, by_model: TOTALS.by_model.slice(0, 2) },
    });
    const report = toUsageReport({ counters: period, month });
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    // The period has no image rows at all: the ring still comes from the month response.
    expect(report.windows.map((w) => w.id)).toEqual(["credits:period", "image-pool:monthly"]);
    expect(report.windows[1]?.usedPct).toBeCloseTo(51, 5);
  });

  it("ignores a credits block the API did not send", () => {
    const report = toUsageReport({ counters: SAMPLE_REPORT, month: SAMPLE_REPORT, quota: null });
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    expect(report.windows.map((w) => w.id)).toEqual(["image-pool:monthly"]);
    expect(report.balances?.some((b) => b.unit === "credits")).toBe(false);
  });

  it("marks the no-counter models instead of leaving their credits blank", () => {
    const rows = [
      { model: "whisper", total_tokens: 40000, api_requests: 12, credits: 0 },
      { model: "qwen3-embedding", total_tokens: 724000, api_requests: 406 },
      { model: "glm5.3", total_tokens: 83, api_requests: 1, credits: 0 },
      { model: "flux-2-klein", total_tokens: 0, api_requests: 3 },
    ];
    const body = usageBody({ totals: { ...TOTALS, by_model: rows } });
    const report = toUsageReport({ counters: body, month: body });
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    const value = (label: string) => report.details?.find((d) => d.label === label)?.value;
    expect(value("whisper")).toBe("∞ unmetered · 40k tok · 12 req");
    expect(value("qwen3-embedding")).toBe("∞ unmetered · 724k tok · 406 req");
    // A credit-billed model whose spend rounds below 0.1 stays blank, and so does the image
    // pool: its budget is its own ring, not an unlimited counter.
    expect(value("glm5.3")).toBe("83 tok · 1 req");
    expect(value("flux-2-klein")).toBe("0 tok · 3 req");
  });
});
