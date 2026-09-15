# Fresh-process LiteLLM import time

Stable ID: `sdk-import-time`. Measures wall time from spawning `python -I -c 'import litellm'`
until that process exits. Interpreter startup and shutdown are included. This is not import-only
execution time, application startup, or a cold operating-system cache benchmark.

The first process runs in a newly prepared environment. Warmups and measured samples also use
fresh processes, but reuse that installation and its filesystem caches. The first process and
warmups are excluded from the reported distribution. Every measured sample is retained in execution
order; p95 uses nearest rank. Optional `-X importtime` runs in a separate process after timing.

Every timed process runs with `LITELLM_LOCAL_MODEL_COST_MAP=True`. Without it, `import litellm`
resolves DNS and fetches the live model cost map over HTTPS inside the timed region, so the sample
would include network latency and could change when the remote file changes. The protocol's
`network: false` therefore describes the measured process, not just the instrumentation. Twenty
fresh-process samples per version keep the run-to-run coefficient of variation of `import.median`
near 2%; `import.first` is a single sample by construction and should be read as indicative.
The runner records kernel release, CPU model and count, total memory, and one-minute load average in
`apparatus.host` so cross-run drift can be attributed. A sample that fails keeps the completed
samples and the failing index in the failure `details`, and the run stays `status: failed`.

## Implementation pattern

- `config.ts`: decode the submitted job with Schema, reject unknown or unsupported options, and
  check the host before acquiring resources. Runtime facts are explicit inputs to validation.
- `probe.ts`: the `ImportTimeProbe` service owns external measurement operations. Its live layer
  captures `ProcessExecutor` and Effect `FileSystem`; service methods have no leaked construction
  dependencies. Validate Python JSON, successful exits, exact sample counts, and positive finite
  durations before returning samples. Preserve structured Python failures on nonzero exit.
- `measurement.ts`: compose probe operations sequentially: size → first → size → warmups → samples
  → optional diagnostic. Keep statistics separate from I/O and timing free of diagnostic instrumentation.
- `result.ts`: project observations into metrics, trials, and analyses with explicit seconds-to-ms
  conversion, then validate the result envelope. Stable metric and trial IDs preserve consumers.
- `runner.ts`: capture dependencies once, then open a fresh scope **per run**. Decode → prepare →
  measure → project. The Python environment is released on success, expected failure, defects, and
  interruption. No nested runtimes, Promise orchestration, or live-layer provisioning in domain code.
- `index.ts`: expose only the production runner. Benchmark-specific probe layers stay internal.

This follows Effect v4's [services](https://effect.website/docs/v4/requirements-management/services),
[layers](https://effect.website/docs/v4/requirements-management/layers),
[FileSystem](https://effect.website/docs/v4/platform/file-system), and
[typed error handling](https://effect.website/docs/v4/error-management/expected-errors).
`Effect.fn` names effectful operation boundaries for tracing. Pure projection stays a plain function.

The service is a meaningful test boundary, not one service per helper. The other benchmarks use this
lifecycle while retaining their own measurement phases and domain types; shared code is limited to
real infrastructure such as Python environments, Docker, k6, and trial-count validation.

## Verification

```sh
pnpm --filter @litellm-bench/benchmark-sdk-import-time check
pnpm --filter @litellm-bench/benchmark-sdk-import-time test
```

Tests use `@effect/vitest`, injected services, and real isolated `python3` processes. They cover config
validation, ordered trials and unit conversion, zero warmups, optional diagnostics, malformed or
partial responses, process errors and timeouts, and scoped cleanup including interruption. No package
downloads are needed. Vitest explicitly selects `test/` to exclude stale compiled tests in `dist/`.

## Boundaries retained

Environment installation and installed-size accounting remain in `@litellm-bench/python-environment`.
Installed-size inspection uses Effect `FileSystem` and fails when any path cannot be inspected. Those
ancillary size fields are not timing metrics. This reference pattern is the TypeScript implementation
used by the CLI.
