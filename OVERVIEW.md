Adds nan (nan.builders) usage to the Paseo Usage modal.

nan is an OpenAI-compatible inference API for open models on a shared EU cluster. This plugin registers a Paseo usage source, so a nan card appears beside the built-in Claude, Codex, Cursor, and other cards, on every client connected to the daemon, including mobile.

## How it works

The plugin calls `GET https://api.nan.builders/v1/usage` from the daemon with your nan inference API key (`sk-...`) as a bearer token. Paseo renders a nan card with:

- One allowance ring for the credit pool every model draws from: percent used in the current billing period and its real renewal instant (the member's Stripe date, not the calendar 1st), red while the subscription is frozen. Accounts the API does not bill in credits show counters only
- The shared image pool (100 requests/month) and, when the quota service reports one, glm5.3's 400M-token rolling 4h window
- Credits used, left and allowance for the period, credit packs with their expiry, tokens and API requests over the same billing window, plus lifetime tokens
- A per-model breakdown with what each model billed in credits (`52.2 cr · 487.9M tok · 4.6k req`), led by the most expensive, plus the in/out split and cached input. Catalog models billed with no counter render `∞ unmetered` rather than a blank; a credit-priced model that rounds below 0.1 credits shows no figure

Since November 2026 the chat models have no token allowance of their own: each one spends the shared pool at its own price per token, so the plugin shows per-model credits instead of per-model rings. Accounts that carry no credits at all (the Gentle plan still meters a monthly quota per model) keep getting those rings from the quota service, and which one applies is decided by whether the API returned a credits block. Requests go only to the fixed origins `api.nan.builders` and `cloud-api.nan.builders`; a quota-service failure never hides the usage counters, and mirror hosts (custom `api_base`) show only what their own API reports.

## Setup

Paseo discovers the key from, in order of preference:

1. the `NAN_API_KEY` environment variable on the daemon machine
2. `~/.nan/credentials.json` or `~/.nan/config.json` (JSON with `api_key` / `apiKey`, or a plain-text key file)
3. the login OpenCode created through `/connect` for the `nan` integration: the `credential` table of OpenCode v2's `opencode.db` (read-only), with a fallback to v1's `auth.json`
4. the global `~/.config/opencode/opencode.json` / `.jsonc` (the setup the nan docs teach: `provider.nan.options.apiKey` in plain text), parsed JSONC-style with OpenCode's `{env:VAR}` and `{file:path}` substitutions; project configs are never scanned

Generate an inference API key under "API Keys" in your settings at cloud.nan.builders. Keep it out of repositories and shared configs: the plugin only stores a pointer to where the key lives, never the key itself. The OpenCode store reads a key OpenCode already keeps on disk; to exclude that store entirely, set `NAN_USAGE_NO_OPENCODE=1` in the daemon environment.

Reports refresh through Paseo's usage cache (5 minutes). The nan usage endpoint allows 30 requests per minute; a `429` is retried once when the `Retry-After` fits inside the fetch deadline.

Requires Paseo 0.11 or newer on the daemon and **Enable plugins** in the daemon's settings.
