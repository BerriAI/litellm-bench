import type { BenchmarkResult } from "@litellm-bench/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  type BenchmarkRunner,
  DuplicateRunner,
  EnvironmentRequirementUnmet,
  failedBenchmarkResult,
  RunnerNotFound,
  RunnerRegistry,
  runnerRegistryLayer,
  runRegisteredBenchmark,
} from "../src/index.js";

const runner = (id: string): BenchmarkRunner => ({
  id,
  run: () => Effect.die("unused") as Effect.Effect<BenchmarkResult, never>,
});

describe("RunnerRegistry", () => {
  it("resolves registered runners", async () => {
    const resolved = await Effect.runPromise(
      RunnerRegistry.pipe(
        Effect.flatMap(({ get }) => get("sdk-import-time")),
        Effect.provide(runnerRegistryLayer(Effect.succeed([runner("sdk-import-time")]))),
      ),
    );

    expect(resolved.id).toBe("sdk-import-time");
  });

  it("models missing and duplicate registrations as typed failures", async () => {
    const missing = await Effect.runPromise(
      RunnerRegistry.pipe(
        Effect.flatMap(({ get }) => get("missing")),
        Effect.provide(runnerRegistryLayer(Effect.succeed([runner("sdk-import-time")]))),
        Effect.flip,
      ),
    );
    const duplicate = await Effect.runPromise(
      RunnerRegistry.pipe(
        Effect.provide(runnerRegistryLayer(Effect.succeed([runner("same"), runner("same")]))),
        Effect.flip,
      ),
    );

    expect(missing).toBeInstanceOf(RunnerNotFound);
    expect(duplicate).toBeInstanceOf(DuplicateRunner);
  });
});

const host = {
  platform: "macos",
  architecture: "arm64",
  host: "existing",
  node_version: "v24.0.0",
  ci: false,
} as const;

const context = {
  runId: "run",
  createdAt: "2026-09-13T00:00:00Z",
  artifactsDirectory: "/artifacts",
  host,
  spec: {
    case_id: "a".repeat(64),
    comparison_id: "b".repeat(64),
    benchmark: {
      id: "demo",
      label: "Demo",
      kind: "sdk",
      output_metrics: [],
      protocol: { question: "demo", scenarios: [], measurements: [], analyses: [] },
    },
    job: {
      id: "base",
      canonical: true,
      runner: "ubuntu-24.04",
      requirements: { platform: "linux", architecture: "x86_64" },
      config: {},
    },
    version: { version: "1.0.0", artifacts: {} },
    artifact: {},
  },
} as const;

it("rejects an incompatible host before acquiring the runner", async () => {
  let acquired = false;
  const candidate: BenchmarkRunner = {
    id: "demo",
    run: () =>
      Effect.sync(() => {
        acquired = true;
        return {} as BenchmarkResult;
      }),
  };
  const error = await Effect.runPromise(
    runRegisteredBenchmark(context).pipe(
      Effect.provide(runnerRegistryLayer(Effect.succeed([candidate]))),
      Effect.flip,
    ),
  );
  expect(error).toBeInstanceOf(EnvironmentRequirementUnmet);
  expect(acquired).toBe(false);
  expect(failedBenchmarkResult(context, error)).toMatchObject({
    apparatus: { host },
    error: {
      code: "environment_requirement_unmet",
      details: {
        required: { platform: "linux", architecture: "x86_64" },
        actual: host,
      },
    },
  });
});

it("records the observed host on a successful result", async () => {
  const compatibleHost = { ...host, platform: "linux", architecture: "x86_64" } as const;
  const candidate: BenchmarkRunner = {
    id: "demo",
    run: ({ spec, runId, createdAt }) =>
      Effect.succeed({
        run_id: runId,
        created_at: createdAt,
        case_id: spec.case_id,
        comparison_id: spec.comparison_id,
        benchmark: spec.benchmark,
        job: spec.job,
        version: spec.version.version,
        artifact: spec.artifact,
        apparatus: { harness: "test" },
        metrics: [],
        trials: [],
        analyses: [],
        status: "ok",
      }),
  };
  const result = await Effect.runPromise(
    runRegisteredBenchmark({ ...context, host: compatibleHost }).pipe(
      Effect.provide(runnerRegistryLayer(Effect.succeed([candidate]))),
    ),
  );

  expect(result.apparatus).toEqual({ harness: "test", host: compatibleHost });
});
