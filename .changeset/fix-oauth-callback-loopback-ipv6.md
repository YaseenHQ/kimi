---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-oauth": patch
---

Listen for OAuth browser callbacks on both IPv4 (`127.0.0.1`) and IPv6 (`::1`) loopback addresses while keeping the `localhost` redirect URI. This fixes browser login failures on systems where `localhost` resolves to `::1` first (e.g., Codex and Anthropic PKCE flows).
