---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-oauth": patch
---

Suppress the `Skipped refreshing managed:kimi-code: ... requires login` warning when switching models. The refresh orchestrator now treats an unauthenticated managed provider as not-yet-logged-in rather than a refresh failure.
