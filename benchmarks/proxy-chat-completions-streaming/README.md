# LiteLLM proxy streaming chat-completions sustainable capacity

Stable ID: `proxy-chat-completions-streaming`. This is an open, fixed-arrival-rate saturation
sweep for `stream: true` chat completions. Seven independent rounds cover 10–80 offered streams
per second in shuffled order. The reported one-worker capacity is the highest contiguous rate for
which at least six rounds meet all SLO predicates. The sweep must contain a failing higher rate.

The deterministic upstream emits 31 SSE events: an assistant-role chunk, 27 content chunks, a stop
chunk, a usage-only chunk, and `[DONE]`. Content varies from single characters to an 8 KiB chunk and
includes line breaks, escaped JSON, Markdown, and multibyte Unicode. It waits 10 ms before the first
event and 1 ms between events, preserving the previous 40 ms nominal stream duration. Every response
is checked for SSE content type, event count, terminal marker, every content chunk, usage, and finish
reason. The client records p95 TTFB, p95 complete-stream duration, completed streams/s, validated
events/s, error rate, drops, and drain time. k6 exposes response TTFB and full-response timing, but not
each individual event's arrival timestamp, so this benchmark does not claim inter-event-gap latency.
The route contract, chunk data, and canonical SSE fixture are owned by
`@litellm-bench/provider-openai-chat-completions`.

The sustainable-rate SLO requires p95 TTFB at most 100 ms, p95 complete-stream duration at most
200 ms, zero window errors, no dropped arrivals, at least 98% achieved load, and stable warmup.
Every round also runs a 1.5x direct-to-mock calibration (120 streams/s) with CPU and throttling
headroom checks: mock and load-generator CPU below 85% and mock CFS throttling below 0.1% of wall
time. The sweep tops out at 80 streams/s because the single-CPU k6 load generator validates all 31
SSE events of every stream and saturates near 200 streams/s; a calibration that pins k6 at 100% CPU
cannot prove headroom, so the ceiling is chosen to keep the apparatus honest rather than to flatter
the proxy. k6 pre-allocates `ceil(rate × SLO × 4)` VUs (bounded to 16..512) so the
`constant-arrival-rate` executor never drops arrivals for lack of VUs while the proxy is within its
SLO; once it is not, dropped iterations are a real saturation signal.

A round (one trial per rate plus its calibration) is an independent experimental unit. If any trial
in a round loses measurement integrity (k6 failure, request-count mismatch, telemetry gap) or the
calibration fails headroom, the whole round is re-run with fresh containers, up to three attempts.
Every attempt's artifacts are retained under `attempt-N/`, the reasons are recorded in the raw
observation's `round_retries` metadata, and trials from different attempts are never mixed. SLO
misses at swept rates are data, not retry reasons.

Verify with:

```sh
pnpm --filter @litellm-bench/benchmark-proxy-chat-completions-streaming check
pnpm --filter @litellm-bench/benchmark-proxy-chat-completions-streaming test
pnpm --filter @litellm-bench/proxy test
pnpm --filter @litellm-bench/contracts test
```
