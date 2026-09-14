# Mistral OCR provider route

Owns the mock contract for Mistral `POST /v1/ocr`. The package contains the canonical replay fixture
and a pure builder for synthetic fixtures. Both use the workspace's version 2 upstream fixture format,
so `apps/mock-provider` can validate and replay them without provider-specific server code.
The exported provider-route manifest records the fixture's purpose and provenance.

The canonical JSON fixture is exported as `@litellm-bench/provider-mistral-ocr/fixture` and its
filesystem location is available as `canonicalMistralOcrFixturePath`.

```sh
pnpm --filter @litellm-bench/provider-mistral-ocr test
```
