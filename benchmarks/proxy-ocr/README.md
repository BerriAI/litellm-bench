# LiteLLM proxy OCR throughput: Python vs Rust

This benchmark reports fixed-concurrency closed-loop completion throughput, not capacity. Scenario
order and adjacent Python/Rust treatment order are reproducibly randomized. A failed trial reruns
the whole paired round, and paired log-ratios include a deterministic bootstrap 95% confidence
interval. The mock validates the decoded PNG's complete structure, exact byte length, and SHA-256.

Warmup runs separately. CPU counters and `memory.current` are bracketed after warmup and before the
measured load-generator process starts; the retained telemetry labels that window explicitly.
`memory.peak` is read, never written: Docker mounts the container cgroup read-only, so the peak
spans the fresh container's whole lifetime (warmup plus measurement of the same workload) and is
therefore an upper bound. The result reports proxy CPU milliseconds per successful request in
addition to throughput. Memory is reported both as absolute footprint and as growth above the
post-warm-up baseline, so footprint and load-attributable growth are not conflated.

The comparison fails closed unless the single-CPU proxy is saturated (at least 90% average CPU),
the one-CPU mock remains below 80%, and the two-CPU load generator remains below 160%. These gates
prevent an upstream validator or client-side generator bottleneck from becoming a published proxy
speedup. The raw observation retains their telemetry for inspection.

Stable ID: `proxy-ocr`. Measures paired Python and Rust OCR request paths against a deterministic,
validating local upstream. Seeded scenario-treatment blocks keep each Python/Rust pair adjacent,
every trial uses a fresh proxy, and the published comparison pairs variants by scenario and round.
The upstream fixture explicitly declares zero response delay; there is no runtime timing override.
The Mistral `/v1/ocr` contract and canonical fixture are owned by
`@litellm-bench/provider-mistral-ocr`; this benchmark selects that fixture rather than defining a
provider response itself.

Configuration, schedule, multipart construction, experiment construction, raw-observation decoding,
artifact persistence, projection, result construction, and running have separate boundaries.
`ProxyEnvironment` owns Docker and k6 resources; `OcrArtifacts` owns publication files. Missing
telemetry, invalid request counts, incomplete matrices, and broken pairs are typed failures.

Verify with:

```sh
pnpm --filter @litellm-bench/benchmark-proxy-ocr check
pnpm --filter @litellm-bench/benchmark-proxy-ocr test
```
