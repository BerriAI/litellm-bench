import { expect, it } from "@effect/vitest";
import type { BenchmarkDefinition, JsonRecord, SdkBenchmarkSpec } from "@litellm-bench/contracts";
import type { RunContext } from "@litellm-bench/harness";
import {
  type PreparedEnvironment,
  PythonEnvironment,
  PythonEnvironmentError,
} from "@litellm-bench/python-environment";
import { Effect } from "effect";
import { decodePackageSizeSpec } from "../src/config.js";
import { PackageSizeProbe } from "../src/probe.js";
import { makePackageSizeRunner } from "../src/runner.js";

const measurements = {
  warmups: 0,
  samples: 1,
  timing: false,
  diagnostics: false,
  importtime: false,
  network: false,
  timeout_seconds: 120,
} as const;
const config = {
  workload: { name: "base-install", statement: "import litellm" },
  measurements,
};
const invalidConfigChanges: readonly JsonRecord[] = [
  { typo: true },
  { measurements: { ...measurements, samples: 2 } },
  { profile: "diagnostic" },
];
const benchmark = {
  id: "sdk-package-size",
  label: "Clean LiteLLM package size",
  kind: "sdk",
  output_metrics: [],
  protocol: { question: "size", scenarios: [], measurements: [], analyses: [] },
} satisfies Omit<BenchmarkDefinition, "artifact" | "jobs">;
const context: RunContext = {
  runId: "size-test",
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
    benchmark,
    job: {
      id: "base",
      canonical: true,
      runner: "test",
      requirements: { platform: "linux", architecture: "x86_64", python: "3.12" },
      config,
    },
    version: { version: "1.0.0", artifacts: {} },
    artifact: { requirement: "litellm==1", distribution: "litellm" },
  },
};
const prepared: PreparedEnvironment = {
  workspace: "/workspace",
  python: "/python",
  site_packages: ["/site"],
  installed_files: ["/site/litellm.py", "/bin/litellm"],
  downloads: "/downloads",
  pip_report: "/report",
  artifacts: [{ filename: "litellm.whl", bytes: 1_048_576, sha256: "a".repeat(64) }, {
    filename: "dependency.whl",
    bytes: 2_097_152,
    sha256: "b".repeat(64),
  }],
  package_artifact_bytes: 1_048_576,
  package_version: "1.0.0",
  python_metadata: { version: "3.12.10", implementation: "CPython" },
  uv_version: "uv",
  pip_version: "pip",
};

it.effect("strictly rejects unsupported and incompatible configuration", () =>
  Effect.gen(function*() {
    for (const changes of invalidConfigChanges) {
      const candidate = {
        ...context,
        spec: { ...context.spec, job: { ...context.spec.job, config: { ...config, ...changes } } },
      };
      const error = yield* Effect.flip(
        decodePackageSizeSpec(candidate),
      );
      expect(["InvalidRunnerConfig", "EnvironmentRequirementUnmet"]).toContain(error._tag);
    }
  }));

it.effect("projects exact package observations and releases the prepared environment", () =>
  Effect.gen(function*() {
    const events: string[] = [];
    let measuredPaths: readonly string[] = [];
    let preparation: unknown;
    const runner = yield* makePackageSizeRunner.pipe(
      Effect.provideService(PackageSizeProbe, {
        installedSize: (paths) =>
          Effect.sync(() => {
            events.push("measure");
            measuredPaths = paths;
            return { logical_bytes: 3_145_728, allocated_bytes: null };
          }),
      }),
      Effect.provideService(PythonEnvironment, {
        prepare: (spec) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              events.push("prepare");
              preparation = spec;
              return prepared;
            }),
            () =>
              Effect.sync(() => {
                events.push("release");
              }),
          ),
      }),
    );
    const result = yield* runner.run(context);
    expect(events).toEqual(["prepare", "measure", "release"]);
    expect(preparation).toMatchObject({
      expected_version: "1.0.0",
      timeout_seconds: 120,
      resolver: { binary_only: true },
    });
    expect(measuredPaths).toEqual(prepared.installed_files);
    expect(result.details?.resolution).toMatchObject({ policy: "same-campaign-wheel-closure-v1" });
    expect(result.metrics.map(({ id, value }) => [id, value])).toEqual([
      ["package.wheel", 1],
      ["package.download", 3],
      ["package.installed", 3],
      ["package.artifacts", 2],
    ]);
  }));

it.effect("requires wheels and rejects an installed version mismatch before observation", () =>
  Effect.gen(function*() {
    const nonBinary = {
      ...context,
      spec: {
        ...context.spec,
        job: {
          ...context.spec.job,
          config: {
            ...config,
            resolver: { extra_index_urls: [], find_links: [], binary_only: false },
          },
        },
      },
    };
    expect(
      (yield* Effect.flip(
        decodePackageSizeSpec(nonBinary),
      ))._tag,
    ).toBe("InvalidRunnerConfig");

    const runner = yield* makePackageSizeRunner.pipe(
      Effect.provideService(PackageSizeProbe, {
        installedSize: () => Effect.die("must not measure"),
      }),
      Effect.provideService(PythonEnvironment, {
        prepare: () => Effect.succeed({ ...prepared, package_version: "2.0.0" }),
      }),
    );
    expect(yield* Effect.flip(runner.run(context))).toMatchObject({
      _tag: "RunnerExecutionError",
      message: "Requested litellm 1.0.0, but installed 2.0.0",
    });
  }));

it.effect("keeps preparation and observation failures typed while releasing acquired resources", () =>
  Effect.gen(function*() {
    const events: string[] = [];
    const observationRunner = yield* makePackageSizeRunner.pipe(
      Effect.provideService(PackageSizeProbe, {
        installedSize: () =>
          Effect.fail({ _tag: "RunnerExecutionError", message: "unreadable" } as never),
      }),
      Effect.provideService(PythonEnvironment, {
        prepare: () =>
          Effect.acquireRelease(Effect.succeed(prepared), () =>
            Effect.sync(() => {
              events.push("release");
            })),
      }),
    );
    expect((yield* Effect.flip(observationRunner.run(context)))._tag).toBe("RunnerExecutionError");
    expect(events).toEqual(["release"]);
    const prepareRunner = yield* makePackageSizeRunner.pipe(
      Effect.provideService(PackageSizeProbe, { installedSize: () => Effect.die("unreachable") }),
      Effect.provideService(PythonEnvironment, {
        prepare: () =>
          Effect.fail(new PythonEnvironmentError({ operation: "prepare", message: "failed" })),
      }),
    );
    expect(yield* Effect.flip(prepareRunner.run(context))).toMatchObject({
      _tag: "RunnerExecutionError",
      message: "failed",
    });
  }));
