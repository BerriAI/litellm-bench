# OpenAI Responses provider route

Owns deterministic JSON and SSE fixtures plus the pure builder for OpenAI-compatible
`POST /v1/responses`. Its manifest records fixture purpose and provenance; the mock-provider app
only composes and serves these operations.
