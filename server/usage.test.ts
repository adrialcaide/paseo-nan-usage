import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildLiveWindows,
  buildMonthlyWindows,
  discover,
  fetchUsage,
  monthStartUtc,
  nextMonthResetIso,
  readApiKey,
  toUsageReport,
} from "./usage.js";

const SAMPLE_REPORT = {
  object: "usage.report",
  start_date: "2026-10-01",
  end_date: "2026-10-29",
  data: [],
  totals: {
    prompt_tokens: 2450000,
    completion_tokens: 890000,
    total_tokens: 3340000,
    api_requests: 12500,
    by_model: [
      {
        model: "glm5.3",
        prompt_tokens: 1300000,
        completion_tokens: 440000,
        total_tokens: 1740000,
        api_requests: 8200,
      },
      {
        model: "qwen3.8-flash",
        prompt_tokens: 1150000,
        completion_tokens: 450000,
        total_tokens: 1600000,
        api_requests: 4300,
      },
      { model: "flux-2-klein", prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, api_requests: 30 },
      { model: "qwen-image-2.1", prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, api_requests: 21 },
    ],
  },
  all_time: {
    prompt_tokens: 9800000,
    completion_tokens: 3400000,
    total_tokens: 13200000,
    api_requests: 41250,
    cached_at: "2026-02-01T12:00:00Z",
  },
  has_more: false,
  next_cursor: null,
};

// Fixture shaped like the real dashboard quota payload (per streamdeck-nan tests).
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
      periodEnd: "2026-10-17T05:53:20Z",
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

/** Routes the published usage endpoint and the dashboard quota service independently. */
function nanFetch(
  usage: { body: unknown; status?: number },
  quota: { body: unknown; status?: number } = { body: {} },
  calls: string[] = [],
) {
  return (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const text = String(input);
    calls.push(text);
    if (text.startsWith("https://cloud-api.nan.builders/"))
      return Promise.resolve(jsonResponse(quota.body, quota.status ?? 200));
    return Promise.resolve(jsonResponse(usage.body, usage.status ?? 200));
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

  it("requests usage month-to-date and renders live quota rings when the service answers", async () => {
    const calls: string[] = [];
    const report = await fetchUsage(envInput, nanFetch({ body: SAMPLE_REPORT }, { body: QUOTA_SAMPLE }, calls));
    expect(report.status).toBe("available");
    if (report.status !== "available") return;

    const usageUrl = new URL(calls.find((c) => c.startsWith("https://api.nan.builders/"))!);
    expect(usageUrl.pathname).toBe("/v1/usage");
    expect(usageUrl.searchParams.get("start_date")).toBe(monthStartUtc());
    expect(usageUrl.searchParams.get("limit")).toBe("1");
    expect(calls.some((c) => c === "https://cloud-api.nan.builders/api/usage/quota")).toBe(true);

    const ids = report.windows.map((w) => w.id);
    expect(ids).toEqual([
      "deepseek-v4-flash:period",
      "glm5.3:period",
      "glm5.3:14400s", // windowFromReportedDuration derived identity for the rolling 4h
    ]);
    const deepseek = report.windows[0]!;
    expect(deepseek.usedPct).toBeCloseTo((1218820529 / 3e9) * 100, 5);
    expect(deepseek.resetsAt).toBe("2026-11-01T00:00:00.000Z");
    const glmRolling = report.windows.find((w) => w.id === "glm5.3:14400s")!;
    expect(glmRolling.label).toBe("glm5.3 · 4-hour");
    // windowFromReportedDuration prefixes the scope label into the short label.
    expect(glmRolling.shortLabel).toBe("glm5.3 4h");
    expect(glmRolling.usedPct).toBeCloseTo(30, 5);
    expect(glmRolling.resetsAt).toBe("2026-10-29T08:00:00.000Z");
    // The billing period ring uses glm5.3's own periodEnd, not the calendar month.
    expect(report.windows.find((w) => w.id === "glm5.3:period")?.resetsAt).toBe(
      "2026-10-17T05:53:20.000Z",
    );
    // Catalog rings are superseded entirely by live data.
    expect(ids.some((id) => id.endsWith(":monthly"))).toBe(false);

    const balances = report.balances ?? [];
    expect(balances.map((b) => [b.id, b.unit, b.used])).toEqual([
      ["month_tokens", "tokens", 3340000],
      ["month_requests", "requests", 12500],
      ["all_time_tokens", "tokens", 13200000],
    ]);
    const details = report.details ?? [];
    expect(details.find((d) => d.id === "window")?.value).toBe("2026-10-01 → 2026-10-29");
    expect(details.find((d) => d.label === "glm5.3")?.value).toBe("1.74M tok · 8.2k req");
  });

  it("falls back to catalog rings when the quota service returns nothing usable", async () => {
    const report = await fetchUsage(envInput, nanFetch({ body: SAMPLE_REPORT }, { body: {} }));
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    const ids = report.windows.map((w) => w.id);
    expect(ids).toContain("qwen3.8-flash:monthly");
    expect(ids).toContain("image-pool:monthly");
    expect(ids).not.toContain("glm5.3:period");
  });

  it("treats quota transport failures as absent, not fatal", async () => {
    const report = await fetchUsage(
      envInput,
      nanFetch({ body: SAMPLE_REPORT }, { body: { error: "boom" }, status: 503 }),
    );
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    expect(report.windows.some((w) => w.id.endsWith(":monthly"))).toBe(true);
  });

  it("honors an api_base override and drops quota rings and the quota call on mirror hosts", async () => {
    const calls: string[] = [];
    const report = await fetchUsage(
      { ...envInput, api_base: "https://api.helmcode.com/v1/" },
      nanFetch({ body: SAMPLE_REPORT }, { body: QUOTA_SAMPLE }, calls),
    );
    expect(calls.some((c) => c.startsWith("https://cloud-api.nan.builders/"))).toBe(false);
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    expect(report.windows).toEqual([]);
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

describe("buildLiveWindows", () => {
  it("prefers fullCap over a prorated first-period cap", () => {
    const windows = buildLiveWindows({
      models: [{ model: "m", tokensUsed: 50, cap: 100, fullCap: 200 }],
    });
    expect(windows[0]?.usedPct).toBeCloseTo(25, 5);
  });

  it("skips unmetered models: cap 0 or no allowance at all", () => {
    const windows = buildLiveWindows({
      models: [
        { model: "free", tokensUsed: 7, cap: 0 },
        { model: "unmetered", tokensUsed: 9 },
      ],
    });
    expect(windows).toEqual([]);
  });

  it("shows no ring for catalog models the key has not used (e.g. glm5.3 on a non-premium tier)", () => {
    const windows = buildLiveWindows({
      models: [
        { model: "glm5.3", tokensUsed: 0, cap: 3e9, windowHours: 4, windowTokensUsed: 0, fullWindowTokens: 4e8 },
        { model: "deepseek-v4-flash", tokensUsed: 1200, cap: 3e9 },
      ],
    });
    expect(windows.map((w) => w.id)).toEqual(["deepseek-v4-flash:period"]);
  });

  it("names a rolling sub-window from its reported duration", () => {
    const windows = buildLiveWindows({
      models: [
        {
          model: "glm5.3",
          tokensUsed: 0,
          cap: 3e9,
          windowHours: 4,
          windowTokensUsed: 360000000,
          fullWindowTokens: 400000000,
        },
      ],
    });
    const rolling = windows.find((w) => w.id === "glm5.3:14400s");
    expect(rolling?.label).toBe("glm5.3 · 4-hour");
    expect(rolling?.usedPct).toBeCloseTo(90, 5);
    expect(rolling?.tone).toBe("warning");
  });

  it("uses a neutral Rolling identity when the duration is not reported", () => {
    const windows = buildLiveWindows({
      models: [{ model: "x", tokensUsed: 1, windowTokensUsed: 1, windowTokens: 2 }],
    });
    expect(windows[0]?.id).toBe("x:rolling");
    expect(windows[0]?.label).toBe("x · Rolling");
  });

  it("falls back to the root periodEnd for the model reset", () => {
    const windows = buildLiveWindows({
      periodEnd: "2026-11-01T00:00:00Z",
      models: [{ model: "m", tokensUsed: 1, cap: 100 }],
    });
    expect(windows[0]?.resetsAt).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("buildMonthlyWindows", () => {
  it("skips quotas without month usage", () => {
    expect(buildMonthlyWindows([])).toEqual([]);
  });

  it("flags near-exhausted quotas with the danger tone", () => {
    const windows = buildMonthlyWindows([
      { model: "qwen3.8-flash", total_tokens: 4.8e8, api_requests: 10 },
    ]);
    expect(windows[0]?.tone).toBe("danger");
    expect(windows[0]?.usedPct).toBeCloseTo(96, 5);
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
    const report = toUsageReport({
      start_date: "2026-10-01",
      end_date: "2026-10-01",
      totals: { by_model: [] },
    });
    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    expect(report.balances).toEqual([]);
    expect(report.windows).toEqual([]);
  });
});
