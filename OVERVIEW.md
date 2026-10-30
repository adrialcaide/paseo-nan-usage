Adds nan (nan.builders) usage to the Paseo Usage modal.

nan is an OpenAI-compatible inference API for open models on a shared EU cluster. This plugin registers a Paseo usage source, so a nan card appears beside the built-in Claude, Codex, Cursor, and other cards, on every client connected to the daemon, including mobile.

## How it works

The plugin calls `GET https://api.nan.builders/v1/usage` from the daemon with your nan inference API key (`sk-...`) as a bearer token, month-to-date in UTC. Paseo renders a nan card with:

- Live quota rings (`used/cap` per model, each model's real reset time, and glm5.3's rolling 4h window when reported). When the quota service does not answer, the plugin falls back to the published monthly catalog quotas (deepseek-v4-flash 3B, mimo-v2.6-flash 1B, qwen3.8-flash 500M, glm5.3-flash 2B, shared image pool 100 req) computed from the daily usage rows
- Tokens and API requests so far this month, plus lifetime tokens
- A per-model breakdown (tokens and requests for each model)

Requests go only to the fixed origins `api.nan.builders` and `cloud-api.nan.builders`; a quota-service failure never hides the usage counters, and mirror hosts (custom `api_base`) show counters without rings.

## Setup

Paseo discovers the key from, in order of preference:

1. the `NAN_API_KEY` environment variable on the daemon machine
2. `~/.nan/credentials.json` or `~/.nan/config.json` (JSON with `api_key` / `apiKey`, or a plain-text key file)
3. the login OpenCode created through `/connect` for the `nan` integration: the `credential` table of OpenCode v2's `opencode.db` (read-only), with a fallback to v1's `auth.json`
4. the global `~/.config/opencode/opencode.json` / `.jsonc` (the setup the nan docs teach: `provider.nan.options.apiKey` in plain text), parsed JSONC-style with OpenCode's `{env:VAR}` and `{file:path}` substitutions; project configs are never scanned

Generate an inference API key under "API Keys" in your settings at cloud.nan.builders. Keep it out of repositories and shared configs: the plugin only stores a pointer to where the key lives, never the key itself. The OpenCode store reads a key OpenCode already keeps on disk; to exclude that store entirely, set `NAN_USAGE_NO_OPENCODE=1` in the daemon environment.

Reports refresh through Paseo's usage cache (5 minutes). The nan usage endpoint allows 30 requests per minute; a `429` is retried once when the `Retry-After` fits inside the fetch deadline.

Requires Paseo 0.11 or newer on the daemon and **Enable plugins** in the daemon's settings.
