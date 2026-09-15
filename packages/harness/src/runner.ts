import type { BenchmarkResult, JsonRecord, ResultFailure, RunSpec } from "@litellm-bench/contracts";
import { Context, Data, Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import {
  captureHostEnvironment,
  checkHostRequirements,
  type HostEnvironmentSnapshot,
} from "./host.js";

export interface RunContext {
  readonly spec: RunSpec;
  readonly runId: string;
  readonly createdAt: string;
  readonly artifactsDirectory: string;
  readonly host?: HostEnvironmentSnapshot;
}

export class InvalidRunnerConfig extends Data.TaggedError("InvalidRunnerConfig")<{
  readonly message: string;
}> {}

export class InvalidObservation extends Data.TaggedError("InvalidObservation")<{
  readonly message: string;
}> {}

export class RunnerExecutionError extends Data.TaggedError("RunnerExecutionError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly details?: JsonRecord;
}> {}

export class EnvironmentRequirementUnmet extends Data.TaggedError("EnvironmentRequirementUnmet")<{
  readonly message: string;
  readonly required?: JsonRecord;
  readonly actual?: JsonRecord;
}> {}

export type RunnerError =
  | EnvironmentRequirementUnmet
  | InvalidRunnerConfig
  | InvalidObservation
  | RunnerExecutionError;

export interface BenchmarkRunner {
  readonly id: string;
  readonly run: (context: RunContext) => Effect.Effect<BenchmarkResult, RunnerError>;
}

export class RunnerNotFound extends Data.TaggedError("RunnerNotFound")<{
  readonly benchmarkId: string;
}> {}

export class DuplicateRunner extends Data.TaggedError("DuplicateRunner")<{
  readonly benchmarkId: string;
}> {}

export interface RunnerRegistryShape {
  readonly get: (benchmarkId: string) => Effect.Effect<BenchmarkRunner, RunnerNotFound>;
}

export class RunnerRegistry extends Context.Service<RunnerRegistry, RunnerRegistryShape>()(
  "@litellm-bench/harness/RunnerRegistry",
) {}

export interface RunMetadata {
  readonly runId: string;
  readonly createdAt: string;
}

export interface RunMetadataGeneratorShape {
  readonly make: Effect.Effect<RunMetadata>;
}

export class RunMetadataGenerator
  extends Context.Service<RunMetadataGenerator, RunMetadataGeneratorShape>()(
    "@litellm-bench/harness/RunMetadataGenerator",
  )
{}

export const RunMetadataGeneratorLive = Layer.succeed(RunMetadataGenerator, {
  make: Effect.sync(() => ({ runId: randomUUID(), createdAt: new Date().toISOString() })),
});

const makeRegistry = (
  runners: ReadonlyArray<BenchmarkRunner>,
): Effect.Effect<RunnerRegistryShape, DuplicateRunner> => {
  const duplicate = runners.find(({ id }, index) =>
    runners.findIndex((runner) => runner.id === id) !== index
  );
  if (duplicate !== undefined) {
    return Effect.fail(new DuplicateRunner({ benchmarkId: duplicate.id }));
  }
  const byId = new Map(runners.map((runner) => [runner.id, runner] as const));
  return Effect.succeed({
    get: (benchmarkId) => {
      const runner = byId.get(benchmarkId);
      return runner === undefined
        ? Effect.fail(new RunnerNotFound({ benchmarkId }))
        : Effect.succeed(runner);
    },
  });
};

export const runnerRegistryLayer = <E, R>(
  runners: Effect.Effect<ReadonlyArray<BenchmarkRunner>, E, R>,
): Layer.Layer<RunnerRegistry, E | DuplicateRunner, Exclude<R, import("effect").Scope.Scope>> =>
  Layer.effect(RunnerRegistry, Effect.flatMap(runners, makeRegistry));

export const runRegisteredBenchmark = (
  context: RunContext,
): Effect.Effect<BenchmarkResult, RunnerNotFound | RunnerError, RunnerRegistry> =>
  Effect.gen(function*() {
    const host = context.host ?? captureHostEnvironment();
    const requirementError = checkHostRequirements(context.spec.job.requirements, host);
    if (requirementError !== undefined) {
      return yield* new EnvironmentRequirementUnmet(requirementError);
    }
    const registry = yield* RunnerRegistry;
    const runner = yield* registry.get(context.spec.benchmark.id);
    const result = yield* runner.run({ ...context, host });
    const runnerHost = typeof result.apparatus.host === "object"
        && result.apparatus.host !== null
        && !Array.isArray(result.apparatus.host)
      ? result.apparatus.host
      : {};
    return { ...result, apparatus: { ...result.apparatus, host: { ...host, ...runnerHost } } };
  });

const resultFailure = (error: RunnerError): ResultFailure => {
  switch (error._tag) {
    case "EnvironmentRequirementUnmet":
      return {
        code: "environment_requirement_unmet",
        message: error.message,
        ...(
          error.required === undefined && error.actual === undefined ? {} : {
            details: {
              ...(error.required === undefined ? {} : { required: error.required }),
              ...(error.actual === undefined ? {} : { actual: error.actual }),
            },
          }
        ),
      };
    case "InvalidRunnerConfig":
      return { code: "invalid_config", message: error.message };
    case "InvalidObservation":
      return { code: "invalid_observation", message: error.message };
    case "RunnerExecutionError":
      return {
        code: "process_failed",
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
  }
};

export const failedBenchmarkResult = (
  context: RunContext,
  error: RunnerError,
): BenchmarkResult => ({
  run_id: context.runId,
  created_at: context.createdAt,
  case_id: context.spec.case_id,
  comparison_id: context.spec.comparison_id,
  benchmark: context.spec.benchmark,
  job: context.spec.job,
  version: context.spec.version.version,
  artifact: context.spec.artifact,
  apparatus: context.host === undefined ? {} : { host: { ...context.host } },
  metrics: [],
  trials: [],
  analyses: [],
  status: "failed",
  error: resultFailure(error),
});
