# LiteLLM proxy OCR throughput: Python vs Rust

This benchmark reports fixed-concurrency closed-loop completion throughput, not capacity. Scenario
order and adjacent Python/Rust treatment order are reproducibly randomized. A failed trial reruns
the whole paired round, and paired log-ratios include a deterministic bootstrap 95% confidence
interval. The mock validates the decoded PNG's complete structure, exact byte length, and SHA-256.

Warmup runs separately. CPU counters and `memory.peak` are bracketed/reset after warmup and before
the measured load-generator process starts; the retained telemetry labels that window explicitly.

Stable ID: `proxy-ocr`. Measures paired Python and Rust OCR request paths against a deterministic,
validating local upstream. Seeded scenario-treatment blocks keep each Python/Rust pair adjacent,
every trial uses a fresh proxy, and the published comparison pairs variants by scenario and round.
The upstream fixture explicitly declares zero response delay; there is no runtime timing override.

Configuration, schedule, multipart construction, experiment construction, raw-observation decoding,
artifact persistence, projection, result construction, and running have separate boundaries.
`ProxyEnvironment` owns Docker and k6 resources; `OcrArtifacts` owns publication files. Missing
telemetry, invalid request counts, incomplete matrices, and broken pairs are typed failures.

Verify with:

```sh
pnpm --filter @litellm-bench/benchmark-proxy-ocr check
pnpm --filter @litellm-bench/benchmark-proxy-ocr test
```
