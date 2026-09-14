# Fresh-process LiteLLM import footprint

Stable ID: `sdk-import-footprint`. A clean environment runs one uninstrumented import to measure
generated-file growth, then a separate instrumented process measures peak RSS and newly loaded
modules. The processes are intentionally distinct because instrumentation changes the workload.

The implementation follows `strict config → scoped prepare → ImportFootprintProbe → validated
observation → pure projection → validated result`. The probe owns filesystem and subprocess work,
preserves structured Python failures, and requires all declared diagnostics. Public IDs stay stable.

Verify with:

```sh
pnpm --filter @litellm-bench/benchmark-sdk-import-footprint check
pnpm --filter @litellm-bench/benchmark-sdk-import-footprint test
```
