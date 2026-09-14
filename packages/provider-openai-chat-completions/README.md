# OpenAI Chat Completions provider route

Owns the mock contract for OpenAI-compatible `POST /v1/chat/completions`. The package contains
canonical JSON and SSE replay fixtures plus a pure builder for synthetic fixtures. Both use the
workspace's version 2 upstream fixture format, so `apps/mock-provider` stays provider-agnostic.
Response-shape conformance is a separate generated fixture, and the exported manifest records each
fixture's capacity/conformance purpose and provenance.

Both canonical fixtures carry the same response of about 8 KiB, with escaped content, Markdown,
Unicode, and line breaks. The stream splits it into varied short chunks and one 8 KiB chunk, then
adds a usage-only event, the finish event, and `[DONE]`. Each semantic SSE event is emitted in
deterministic writes of at most 64 bytes to exercise cross-write parsing. Fixture generation is
deterministic; run `pnpm fixtures:generate` after changing the canonical source.

The fixtures are exported as `@litellm-bench/provider-openai-chat-completions/fixture` and
`@litellm-bench/provider-openai-chat-completions/fixture-streaming`.
