# @moonshot-ai/kimi-code-oauth

## 0.3.0

### Minor Changes

- [#1](https://github.com/YaseenHQ/kimi/pull/1) [`02606aa`](https://github.com/YaseenHQ/kimi/commit/02606aa7218b4b01a26a28889d025fd3b6c5afee) Thanks [@YaseenHQ](https://github.com/YaseenHQ)! - Add unified account (OAuth) and API-key login routes with Kimi Code, xAI, OpenAI Codex, known catalog providers, and custom registries. Browser and device-code login methods are available for the supported OAuth providers. `/logout` supports individual and clearly described credential bundles plus separately confirmed provider-configuration removal; the redundant `/provider` slash command is removed.

### Patch Changes

- [#1](https://github.com/YaseenHQ/kimi/pull/1) [`d92ccad`](https://github.com/YaseenHQ/kimi/commit/d92ccad95aa6310c2ad9143213a61529a3c2b4a4) Thanks [@YaseenHQ](https://github.com/YaseenHQ)! - Suppress the `Skipped refreshing managed:kimi-code: ... requires login` warning when switching models. The refresh orchestrator now treats an unauthenticated managed provider as not-yet-logged-in rather than a refresh failure.

- [#1](https://github.com/YaseenHQ/kimi/pull/1) [`1889925`](https://github.com/YaseenHQ/kimi/commit/188992554ca1d500d8bb67792e68d29da41a5303) Thanks [@YaseenHQ](https://github.com/YaseenHQ)! - Listen for OAuth browser callbacks on both IPv4 (`127.0.0.1`) and IPv6 (`::1`) loopback addresses while keeping the `localhost` redirect URI. This fixes browser login failures on systems where `localhost` resolves to `::1` first (e.g., Codex and Anthropic PKCE flows).

- [#7](https://github.com/YaseenHQ/kimi/pull/7) [`cf99ad9`](https://github.com/YaseenHQ/kimi/commit/cf99ad9a76c306226a0420c292de57a7154483b0) Thanks [@YaseenHQ](https://github.com/YaseenHQ)! - Derive the /usage plan usage window labels and reset hints from structured usage data instead of preformatted text.

## 0.2.2

### Patch Changes

- [#399](https://github.com/MoonshotAI/kimi-code/pull/399) [`232ed87`](https://github.com/MoonshotAI/kimi-code/commit/232ed874d41de777e6ff9c539ac22d830d0b5c3a) - Keep managed OAuth credentials scoped to their configured authentication and API endpoints.

## 0.2.1

### Patch Changes

- [#335](https://github.com/MoonshotAI/kimi-code/pull/335) [`7284f30`](https://github.com/MoonshotAI/kimi-code/commit/7284f30479142fd66b1e8a731fd00198b1e8684f) - Fix custom registry provider handling during re-import. Prevent loss of multi-provider entries and remove stale providers along with their model aliases and default model references.

## 0.2.0

### Minor Changes

- [#264](https://github.com/MoonshotAI/kimi-code/pull/264) [`42bb914`](https://github.com/MoonshotAI/kimi-code/commit/42bb9141d8ee7023639f943dd4c6a0f6c8fa8945) - Add `/provider` command for managing AI providers, support custom registry imports, and introduce a tabbed model selector.

### Patch Changes

- [#274](https://github.com/MoonshotAI/kimi-code/pull/274) [`a1dfbfe`](https://github.com/MoonshotAI/kimi-code/commit/a1dfbfeb16bcad0c2c8faa232d6d1ce4a2681d57) - Clarify Kimi Platform API key login labels and prompt details.

## 0.1.2

### Patch Changes

- [#52](https://github.com/MoonshotAI/kimi-code/pull/52) [`064343a`](https://github.com/MoonshotAI/kimi-code/commit/064343a6e565a525fbf38b3a1f70f7ff0235a5ed) - Correct the `X-Msh-Platform` header value to `kimi_code_cli`.

- [#11](https://github.com/MoonshotAI/kimi-code/pull/11) [`15b018f`](https://github.com/MoonshotAI/kimi-code/commit/15b018fc84a36a9ebde598970e5b44bebe5d68c6) - Surface API-provided error messages during feedback, usage, login, and model setup failures.
