# nan usage · Paseo plugin

A [Paseo](https://github.com/getpaseo/paseo) usage-source plugin that adds a **nan**
([nan.builders](https://nan.builders)) card to the Usage modal: the credit pool left in your
billing period, counters and per-model credits for that same window, lifetime tokens and the
image request budget — on desktop, web, iOS and Android, on every client connected to the
daemon where the plugin is installed.

![The nan card in Paseo's Usage modal: the credits ring, billing-period balances and a per-model breakdown](./docs/usage-card.png)

*Real account data; your numbers will differ.*

## Requirements

You need all of these before installing:

- **Paseo 0.11 or newer** — usage sources don't exist on older daemons (the plugin is
  rejected with a clear error, nothing breaks; check Settings → About or `paseo --version`)
- **Plugins enabled** on the daemon you install into: Settings → Plugins → *Enable plugins*
  (one global switch; every installed plugin runs unsandboxed as your user, so install
  what you trust)
- A **nan inference API key** (`sk-…`) from [cloud.nan.builders](https://cloud.nan.builders/)
  → Settings → API Keys. Keys need credits: the `nan_member` plan (7,000 credits per billing
  period) or Premium (20,000) include them, and the Community plan or no membership can create
  one once a credit pack is bought. Platform tokens (`nan_pat_`) cannot read usage
- Your nan login discoverable by the plugin — in practice, either you use OpenCode with
  nan (nothing to do, we read that store) or you set `NAN_API_KEY` /
  `~/.nan/credentials.json` once; see [Where the key is read from](#where-the-key-is-read-from)

## What the card shows

- **Credits ring** — nan bills every credit-priced model against one pool per billing period
  (7,000 credits on Inference, 20,000 on Premium), so the card has a single allowance ring:
  percent of that pool used, resetting on your own billing date (Stripe), which is almost
  never the 1st. A frozen subscription reads danger even at a low percentage. Accounts the
  API does not bill in credits show counters only, never an invented percentage.
- **Image budget ring** — the one counter still metered on the calendar month and outside
  credits: the shared 100 requests/month pool (flux-2-klein + qwen-image-2.1).
- **Rolling window** — glm5.3's 400M tokens per rolling 4 hours, a speed limit separate from
  credits, taken from nan's live quota data when it reports one.
- **Balances** — credits used and left in the period, credit packs with their expiry, then
  tokens and API requests over the same billing window, plus lifetime tokens.
- **Details** — the billing period, the in/out split, cached input, and a per-model breakdown
  with what each model billed, e.g. `52.2 cr · 487.9M tok · 4.6k req`, credit-hungry first.
  Models the catalog bills with no counter (gemma4, qwen3.6, qwen3-embedding, rerank, kokoro,
  whisper) show `∞ unmetered` instead of a blank, since for them zero credits is the design, not
  a rounding artefact. A credit-priced model whose spend rounds below 0.1 shows no figure.

Per-model token allowances are gone for credit-billed plans: every chat model now spends the
shared pool at its own price per token, so the plugin shows per-model *credits* instead of
per-model rings. It keeps reading the per-model caps from nan's quota service for the accounts
that still have them — the Gentle plan carries no credits and meters a monthly quota per model
(`402 monthly_cap_reached`) — and decides which one applies from whether the API returned a
credits block at all.

Reports are cached by the daemon for five minutes.

## Install

From a local checkout:

```bash
git clone https://github.com/adrialcaide/paseo-nan-usage && cd paseo-nan-usage
npm install && npm run typecheck     # optional, dev deps are for checking only
paseo plugin install "$(pwd)"
```

`paseo plugin add adrialcaide/paseo-nan-usage` (or paste the same into
Settings → Plugins → Plugin source). You can also paste the `owner/repo` form after
publishing to the Paseo registry.

Then open the **Usage** modal — the nan card appears next to Claude, Codex, Cursor and
the rest, already filled.

## Where the key is read from

The plugin never stores your key: what Paseo keeps is only a pointer to a store, and the
key is re-read from disk on every report refresh. Stores are tried in this order, and
all found logins group into the single nan card:

1. `NAN_API_KEY` environment variable of the daemon process
2. `~/.nan/credentials.json` or `~/.nan/config.json` — JSON with `api_key`/`apiKey`
   (or a plain-text key file)
3. **OpenCode**: the login created with `/connect` for the `nan` integration
   (OpenCode ≥ v2 stores it in its SQLite database; a v1 `auth.json` is supported too)
4. **OpenCode config**: `~/.config/opencode/opencode.json[cm]` —
   `provider.nan.options.apiKey`, the setup shown in [nan's OpenCode guide](https://nan.builders/docs/opencode).
   Parsed JSONC-style with OpenCode's `{env:VAR}` / `{file:path}` substitutions.
   Only the global config is read; project directories are never scanned.

If you prefer the plugin not to touch OpenCode's stores at all, set
`NAN_USAGE_NO_OPENCODE=1` in the daemon environment; it then uses stores 1–2 only.

## Privacy & endpoints

All requests go to two fixed HTTPS origins with `Authorization: Bearer <key>`:

| Endpoint | Purpose | Notes |
| --- | --- | --- |
| `GET https://api.nan.builders/v1/usage` | published usage API: counters, per-model breakdown and the credits block | one request month-to-date, plus one more over the billing period when the credits window started before this month, so the counters and the credit pool cover the same window |
| `GET https://cloud-api.nan.builders/api/usage/quota` | glm5.3's rolling 4h window | undocumented dashboard service: if it does not answer, the card simply loses that one ring |

- No telemetry, no third-party hosts, redirects are never followed.
- Credential stores are opened read-only (SQLite connections as well); the plugin never
  writes to them and never refreshes tokens — `opencode`/your CLI owns rotation.
- A custom `api_base` (e.g. the Helmcode mirror) skips the quota endpoint and the catalog
  rings: it renders only what that host reports about itself, credits included.

## Development

```bash
npm install
npm run typecheck
npm test
```

Iterating against a running daemon that already installed this folder:

```bash
paseo plugin reload nan-usage-source
paseo plugin logs nan-usage-source
```

The plugin ships no UI of its own: it is a *usage source* (`server.registerUsageSource`)
rendered by Paseo's built-in components. The icon is nan's hexagon-and-infinity mark
taken from [the official badge](https://nan.builders/badge/built-with-nan-light.svg),
stroked in `currentColor` so it follows your Paseo theme.

## License

MIT — see [LICENSE](./LICENSE).

Built against the [Paseo](https://github.com/getpaseo/paseo) plugin SDK (Apache-2.0);
the design follows Paseo's official usage-source plugins, and the icon is nan's brand
mark from [their official badge](https://nan.builders/badge/built-with-nan-light.svg).

---

<p align="center">
  <a href="https://nan.builders/?ref=built-with-nan">
    <img src="https://nan.builders/badge/built-with-nan-dark.svg" alt="Built with NaN" width="266" height="104">
  </a>
</p>
