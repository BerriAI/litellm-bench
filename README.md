# LiteLLM Bench

Reproducible measurements of released LiteLLM SDK and proxy artifacts. Every result retains its run specification, apparatus, raw observations, trials, analyses, and chart metrics

| Path                           | Owns                                                            |
| ------------------------------ | --------------------------------------------------------------- |
| `apps/cli/`                    | Effect CLI, planning, execution, and persistence commands       |
| `apps/mock-provider/`          | Validating Node mock used by proxy experiments                  |
| `benchmarks/<id>/`             | Benchmark metadata, TS runner, projection, and runtime assets   |
| `packages/contracts/`          | Effect Schema contracts and generated JSON Schema               |
| `packages/harness/`            | Runner registry, process execution, failures, and run metadata  |
| `packages/python-environment/` | SDK environment service and minimal CPython probe assets        |
| `packages/proxy/`              | Docker lifecycle, k6 execution, and typed proxy observations    |
| `packages/result-store/`       | Validated transactional ingestion and index generation          |
| `data/`                        | Current-format records, annotations, migration audit, and index |
| `web/`                         | Static SvelteKit and Vega-Lite dashboard                        |

The six benchmark IDs are `sdk-import-time`, `sdk-import-footprint`, `sdk-package-size`, `proxy-chat-completions`, `proxy-chat-completions-streaming`, and `proxy-ocr`

## Requirements

Use Node 24+, pnpm 12.4.1, and `uv`. SDK runs use `uv` to resolve the requested CPython interpreter and install released wheels into clean environments. Proxy runs additionally require Docker with cgroup v2 and k6 2.2.0

Python is not an orchestration language in this repository. The only Python source files are the small assets under `packages/python-environment/assets/`. They execute inside CPython when the measurement requires CPython semantics:

- `timing.py` times fresh isolated interpreter processes with `time.perf_counter`
- `probe.py` measures in-process import time, loaded modules, peak RSS, and blocked network attempts

Everything around those probes, including planning, environment setup, process ownership, validation, projection, result writing, and ingestion, is TypeScript and Effect

## Install and build

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm check
```

`pnpm typecheck` runs type checking across every workspace package. `pnpm check`
includes the workspace typecheck and generated catalog validation.

Generate or verify the catalog and JSON schemas with:

```bash
pnpm catalog:generate
pnpm schema:generate
pnpm schema:check
```

## CLI

List and inspect benchmark definitions:

```bash
pnpm bench list
pnpm bench describe proxy-ocr
```

Build the same version matrix consumed by GitHub Actions:

```bash
pnpm bench plan \
  --versions 1.102.0rc1,1.100.1 \
  --selection all
```

Omit `--versions` to plan the latest stable LiteLLM release from PyPI, or use
`--backfill-months 3` to plan every non-yanked stable release uploaded in the
last three 30-day months. Explicit `--versions` are not restricted to stable
releases and may include RC, dev, or exact image-tag forms.

`selection` accepts `all`, `sdk`, `proxy`, or comma-separated benchmark IDs. One matrix entry represents one version VM; its selected benchmark jobs run sequentially on that host

Run one matrix entry locally:

```bash
matrix="$(pnpm --silent bench plan --versions 1.102.0rc1 --selection sdk)"
version_plan="$(printf '%s' "$matrix" | jq -c '.include[0]')"

pnpm bench run-version \
  --version 1.102.0rc1 \
  --plan-json "$version_plan" \
  --output data/runs/version-1.102.0rc1
```

Run an already materialized current-format specification:

```bash
pnpm bench run \
  --spec benchmark-spec.json \
  --output data/runs/one-case
```

Ingest validated results:

```bash
pnpm bench data ingest \
  --input data/runs/version-1.102.0rc1 \
  --data data \
  --mode replace-case-version
```

`data/runs/` is ignored working output. A version output directory must be empty before execution so stale result pairs cannot be ingested

## SDK apparatus

The SDK service creates separate resolver and target environments, downloads the exact wheel closure, installs offline, captures the pip report and artifact inventory, verifies the installed distribution version, and measures the site-packages tree

Import timing retains the previous apparatus: the timer surrounds CPython's `subprocess.run`, including interpreter startup and completion handling. First-ever, warmup, and measured fresh processes remain separate. Optional `-X importtime` capture is launched directly by the TS runner

Import footprint uses the shared CPython probe because `sys.modules`, `resource.getrusage`, and socket instrumentation must run inside the measured interpreter. Package size remains filesystem and resolver orchestration in TS

## Proxy apparatus

The proxy environment creates one Docker network per experiment and fresh mock/proxy containers per trial. It applies the declared CPU, memory, worker, and log settings; waits for readiness; runs the pinned k6 workload; captures cgroup v2 CPU and memory values; validates upstream request counts; retains logs and raw artifacts; and removes owned containers and networks on every exit path

The Node mock validates method, path, JSON subsets, optional fields, and OCR PNG payloads. Benchmarks declare typed HTTP requests and response checks in their TS runners; the shared plain-JavaScript engine executes those declarations in k6's runtime

OCR alternates Python-first and Rust-first paired rounds. Its deterministic PNG and multipart payload are now generated in TS. The current apparatus records the exact wire-body size, and current comparison identity is intentionally distinct from legacy Python-produced records

Failed or invalid trials remain in raw evidence and do not produce successful aggregate metrics

## Adding a benchmark

Add `benchmarks/<id>/benchmark.json`, a workspace package, and a TS runner implementing `BenchmarkRunner`. Register its runner at the CLI composition root in `apps/cli/src/bin.ts`

Keep measurement procedure and projection benchmark-owned. Put reusable environment or process capabilities behind Effect services in shared packages. Keep runtime-only assets beside their owning runtime:

- CPython-only probes in `packages/python-environment/assets/`
- k6 engine code in `packages/proxy/assets/`
- benchmark-owned typed k6 workload declarations in each proxy runner

A successful result must emit every declared output metric exactly once with matching unit and direction. Repeated experiments also emit every trial, auditable analyses, and raw details

## Identity and data

Current case and comparison IDs use RFC 8785 canonical JSON followed by full SHA-256. Case identity includes the target version and artifact. Comparison identity excludes those target fields while retaining the protocol and job configuration

The historical data conversion is recorded in `data/migration-manifest.json`. Runtime code reads only the current contracts; there is no permanent legacy reader

The result store validates the whole incoming batch before mutation, stages writes with a recovery journal, and supports append and explicit case/version replacement. The web pipeline derives its index from validated records during development and writes `dist/data/index.json` during production builds; `data/index.json` is not source data

## Workflows

`.github/workflows/benchmark.yml` invokes only the TS CLI for planning, version execution, and ingestion. Python and `uv` are installed in benchmark workers solely for SDK artifact setup and CPython probes. Proxy experiments use the TS Docker/k6 runtime and Node mock

The workflow uploads result and diagnostic directories even after a failed version suite. Pull-request persistence is the default; direct and artifact-only modes preserve the same validation and replacement semantics

GitHub Pages builds the current SvelteKit site from `web/` and `data/`
