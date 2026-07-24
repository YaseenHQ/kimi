---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kosong": patch
---

Preserve opaque OpenAI Responses compaction state across turns and automatically
use `/responses/compact` when the active provider exposes that capability,
falling back to Kimi's existing local summarizer when it does not.
