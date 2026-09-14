import { expect, it } from "@effect/vitest";
import { type RunContext, RunnerExecutionError } from "@litellm-bench/harness";
import { type PreparedEnvironment, PythonEnvironment } from "@litellm-bench/python-environment";
import { Effect } from "effect";
import { decodeImportFootprintSpec } from "../src/config.js";
import { ImportFootprintProbe } from "../src/probe.js";
import { makeImportFootprintRunner } from "../src/runner.js";

const measurements = {
  warmups: 0,
  samples: 1,
  timing: false,
  diagnostics: true,
  importtime: false,
  network: false,
  timeout_seconds: 120,
} as const;
const config = {
  workload: { name: "root-import", statement: "import litellm" },
  measurements,
};
const context: RunContext = {
  runId: "footprint-test",
  createdAt: "2026-09-13T00:00:00Z",
  artifactsDirectory: "/artifacts",
  host: {
    platform: "linux",
    architecture: "x86_64",
    host: "existing",
    node_version: process.version,
    ci: false,
  },
  spec: {
    case_id: "a".repeat(64),
    comparison_id: "b".repeat(64),
    benchmark: {
      id: "sdk-import-footprint",
      label: "Fresh-process LiteLLM import footprint",
      kind: "sdk",
      output_metrics: [],
      protocol: { question: "footprint", scenarios: [], measurements: [], analyses: [] },
    },
    job: {
      id: "base",
      canonical: true,
      runner: "test",
      requirements: { platform: "linux", architecture: "x86_64", python: "3.12" },
      config,
    },
    version: { version: "1", artifacts: {} },
    artifact: { requirement: "litellm==1", distribution: "litellm" },
  },
};
const prepared: PreparedEnvironment = {
  workspace: "/workspace",
  python: "/python",
  site_packages: ["/site"],
  installed_files: [],
  downloads: "/downloads",
  pip_report: "/report",
  artifacts: [],
  package_version: "1",
  python_metadata: { version: "3.12.10", implementation: "CPython" },
  uv_version: "uv",
  pip_version: "pip",
};

it.effect("rejects unsupported instrumentation and unknown configuration", () =>
  Effect.gen(function*() {
    for (
      const changes of [{ typo: true }, { measurements: { ...measurements, diagnostics: false } }, {
        measurements: { ...measurements, network: true },
      }, { profile: "diagnostic" }]
    ) {
      const candidate = {
        ...context,
        spec: { ...context.spec, job: { ...context.spec.job, config: { ...config, ...changes } } },
      };
      expect(
        (yield* Effect.flip(
          decodeImportFootprintSpec(candidate),
        ))._tag,
      ).toBe("InvalidRunnerConfig");
    }
  }));

it.effect("keeps first import and diagnostics separate and releases resources", () =>
  Effect.gen(function*() {
    const events: string[] = [];
    let sizes = 0;
    let preparations = 0;
    const runner = yield* makeImportFootprintRunner.pipe(
      Effect.provideService(ImportFootprintProbe, {
        installedSize: () =>
          Effect.sync(() => {
            events.push("size");
            return { logical_bytes: sizes++ === 0 ? 100 : 1_048_676, allocated_bytes: null };
          }),
        runFirstImport: (environment) =>
          Effect.sync(() => {
            events.push(`first:${environment.workspace}`);
          }),
        collectDiagnostics: (environment) =>
          Effect.sync(() => {
            events.push(`diagnostic:${environment.workspace}`);
            return { import_only_seconds: 0.1, new_module_count: 12, peak_rss_bytes: 2_097_152 };
          }),
        collectPeakRss: (environment) =>
          Effect.sync(() => {
            events.push(`rss:${environment.workspace}`);
            return 2_097_152;
          }),
      }),
      Effect.provideService(PythonEnvironment, {
        prepare: () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              preparations += 1;
              events.push(`prepare:${preparations}`);
              return { ...prepared, workspace: `/workspace-${preparations}` };
            }),
            () =>
              Effect.sync(() => {
                events.push("release");
              }),
          ),
      }),
    );
    const result = yield* runner.run(context);
    expect(events).toEqual([
      "prepare:1",
      "prepare:2",
      "size",
      "first:/workspace-1",
      "size",
      "rss:/workspace-2",
      "diagnostic:/workspace-2",
      "release",
      "release",
    ]);
    expect(result.metrics.map(({ value }) => value)).toEqual([2, 12, 1]);
  }));

it.effect("releases the environment after probe failure", () =>
  Effect.gen(function*() {
    const events: string[] = [];
    const runner = yield* makeImportFootprintRunner.pipe(
      Effect.provideService(ImportFootprintProbe, {
        installedSize: () => Effect.succeed({ logical_bytes: 0, allocated_bytes: null }),
        runFirstImport: () => Effect.fail(new RunnerExecutionError({ message: "failed" })),
        collectDiagnostics: () => Effect.die("unreachable"),
        collectPeakRss: () => Effect.die("unreachable"),
      }),
      Effect.provideService(PythonEnvironment, {
        prepare: () =>
          Effect.acquireRelease(Effect.succeed(prepared), () =>
            Effect.sync(() => {
              events.push("release");
            })),
      }),
    );
    expect((yield* Effect.flip(runner.run(context)))._tag).toBe("RunnerExecutionError");
    expect(events).toEqual(["release", "release"]);
  }));
