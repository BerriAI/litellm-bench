# OpenAI Chat Completions provider route

Owns the mock contract for OpenAI-compatible `POST /v1/chat/completions`. The package contains
canonical JSON and SSE replay fixtures plus a pure builder for synthetic fixtures. Both use the
workspace's version 2 upstream fixture format, so `apps/mock-provider` stays provider-agnostic.

Both canonical fixtures carry the same response of about 8 KiB, with escaped content, Markdown,
Unicode, and line breaks. The stream splits it into varied short chunks and one 8 KiB chunk, then
adds a usage-only event, the finish event, and `[DONE]`. Fixture generation is deterministic; run
`pnpm fixtures:generate` after changing the canonical source.

The fixtures are exported as `@litellm-bench/provider-openai-chat-completions/fixture` and
`@litellm-bench/provider-openai-chat-completions/fixture-streaming`.
