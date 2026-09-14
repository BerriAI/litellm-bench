# GitHub automation

- `workflows/ci.yml`: workspace checks and workflow script regression tests.
- `workflows/benchmark.yml`: plan, run versions sequentially on one VM, retain diagnostics, and
  publish each version's records. Failed benchmarks still produce artifacts; setup failures and
  cancelled campaigns do not start publication jobs.
- `workflows/pages.yml`: build and deploy the benchmark site.

Shared actions own setup. `setup-node-workspace` reads the pnpm version from `package.json`;
`build-cli: "false"` lets CI and Pages control their own builds. `setup-benchmark-runtime` always sets
up Python 3.12.10, uv, and k6, and verifies Python, Docker, and k6 before measurements start. Python
3.12.10 satisfies every SDK benchmark's Python requirement. Keep this pin aligned with the benchmark
manifests when changing Python versions. Docker preflight uses the same adapter as the benchmarks.

Scripts own campaign handling. `campaign-plan.mjs` validates the plan; `run-campaign.mjs` preserves the
supplied order, retains each version's output directory, and continues after benchmark failures while
returning a failing status for the campaign. The workflow passes dispatch notes to the process that
creates the records.

Run workflow script tests with `node --test .github/scripts/*.test.mjs` and lint workflows with
`actionlint` from the repository root.
