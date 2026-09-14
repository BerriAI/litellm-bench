# LiteLLM proxy chat-completions sustainable capacity

Stable ID: `proxy-chat-completions`. This is an open, fixed-arrival-rate saturation sweep—not a
closed-loop throughput test. Seven independent rounds cover 25–450 offered RPS in shuffled order.
The upstream fixture explicitly declares zero response delay; there is no runtime timing override.
The reported one-worker capacity is the highest contiguous rate for which at least six rounds meet
all of these predicates: p95 latency at most 100 ms, zero window errors, no dropped arrivals, at
least 98% achieved load, and stable warmup. The sweep must contain a failing higher rate, otherwise
it is unbracketed and fails closed.

Warmup uses the identical k6 executor, VU limits, HTTP path, payload, and semantic response checks
as measurement. Its final three five-second completion windows must have CV at most 5%. Measurement
then uses a fixed 30-second window. Throughput counts only successful completions timestamped inside
that window and divides by exactly 30 seconds; tail completions and drain duration are separate.

Every round also sends 1.5× the maximum offered rate directly to a fresh validating mock. This
calibration must achieve its offered rate without drops/errors while mock and pinned load-generator
CPU stay below 85% and mock cgroup throttling stays zero. Proxy, mock, and load generator use
disjoint CPU sets. Complete raw artifacts retain image references and effective IDs, cgroup
quota/cpuset/throttling, utilization, host pressure, CPU/kernel/topology/governor, runner identity,
and configuration/fixture/payload hashes.

The mock requires `stream: false`, the exact allowlisted translated body, and normalized
`content-type` plus exact upstream authorization. Responses are semantically checked on every
request. This benchmark excludes provider inference and streaming.

Verify with:

```sh
pnpm --filter @litellm-bench/benchmark-proxy-chat-completions check
pnpm --filter @litellm-bench/benchmark-proxy-chat-completions test
pnpm --filter @litellm-bench/proxy test
pnpm --filter @litellm-bench/contracts test
```
