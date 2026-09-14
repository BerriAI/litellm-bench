# GitHub automation

- `workflows/ci.yml`: workspace checks.
- `workflows/benchmark.yml`: validate inputs and expand the plan with `fromJSON` into one independent
  workflow invocation per LiteLLM version. `fail-fast: false` keeps other versions running when one
  fails; concurrency groups include the version so matrix jobs cannot cancel each other.
- `workflows/benchmark-version.yml`: run one version's benchmarks on its own Ubuntu VM, upload a
  version-specific artifact, and publish its results from a separate job. Publication waits only for
  that version's run. Failed measurements still publish evidence; setup failures and cancellation
  skip publication.
- `workflows/pages.yml`: build and deploy the benchmark site.

Shared actions own setup. `setup-node-workspace` reads the pnpm version from `package.json`;
`build-cli: "false"` lets CI and Pages control their own builds. `setup-benchmark-runtime` always sets
up Python 3.12.10, uv, and k6, and verifies Python, Docker, and k6 before measurements start. Python
3.12.10 satisfies every SDK benchmark's Python requirement. Keep this pin aligned with the benchmark
manifests when changing Python versions. Docker preflight uses the same adapter as the benchmarks.

The matrix passes each version's plan through `toJSON(matrix)` directly to `pnpm bench run-version`.
The CLI validates the plan and runs that version's benchmarks sequentially. GitHub schedules different
versions independently; positions in the plan do not guarantee execution order. Dispatch notes reach
the process that creates the records.

Lint workflows with `actionlint` from the repository root.
