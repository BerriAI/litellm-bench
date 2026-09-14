import { BenchmarkResult, RunSpec } from "@litellm-bench/contracts";
import {
  captureHostEnvironment,
  failedBenchmarkResult,
  type RunContext,
  RunMetadataGenerator,
  RunnerRegistry,
  runRegisteredBenchmark,
} from "@litellm-bench/harness";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  type CliResponder,
  CliResponse,
  errorResponse,
  ExitCode,
  successResponse,
} from "./model.js";

const decodeRunSpec = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RunSpec),
  { onExcessProperty: "error" },
);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const persistResult = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  specPath: string,
  outputDirectory: string,
  result: typeof BenchmarkResult.Type,
) => {
  const destination = path.join(outputDirectory, "benchmark-result.json");
  return Effect.gen(function*() {
    yield* fileSystem.makeDirectory(outputDirectory, { recursive: true });
    yield* Effect.all([
      fileSystem.copyFile(specPath, path.join(outputDirectory, "benchmark-spec.json")),
      fileSystem.writeFileString(destination, `${JSON.stringify(result, null, 2)}\n`),
    ], { concurrency: "unbounded", discard: true });
    return destination;
  });
};

const executeValidatedRun = (
  specPath: string,
  outputDirectory: string,
  spec: RunSpec,
) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const metadata = yield* RunMetadataGenerator.pipe(Effect.flatMap(({ make }) => make));
    const artifactsDirectory = path.join(outputDirectory, "benchmark-artifacts");
    const prepared = yield* fileSystem.makeDirectory(artifactsDirectory, { recursive: true }).pipe(
      Effect.result,
    );
    if (prepared._tag === "Failure") {
      return errorResponse(
        ExitCode.InternalError,
        `Cannot prepare benchmark output: ${errorMessage(prepared.failure)}\n`,
      );
    }
    const context: RunContext = {
      spec,
      runId: metadata.runId,
      createdAt: metadata.createdAt,
      artifactsDirectory,
      host: captureHostEnvironment(),
    };
    const benchmarkAnnotations = {
      benchmark_id: spec.benchmark.id,
      benchmark_job: spec.job.id,
      version: spec.version.version,
      run_id: metadata.runId,
    };
    const outcome = yield* Effect.logInfo("benchmark started").pipe(
      Effect.andThen(Effect.scoped(Effect.gen(function*() {
        yield* Effect.sleep("1 minute").pipe(
          Effect.andThen(Effect.logInfo("benchmark still running")),
          Effect.forever,
          Effect.forkScoped,
        );
        return yield* runRegisteredBenchmark(context);
      }))),
      Effect.tap(() => Effect.logInfo("benchmark completed")),
      Effect.tapError((error) => Effect.logError(`benchmark failed: ${error.message}`)),
      Effect.annotateLogs(benchmarkAnnotations),
      Effect.withLogSpan("benchmark"),
      Effect.result,
    );
    if (outcome._tag === "Failure") {
      if (outcome.failure._tag === "RunnerNotFound") {
        return errorResponse(
          ExitCode.NotFound,
          `Runner not found: ${outcome.failure.benchmarkId}\n`,
        );
      }
      const persisted = yield* persistResult(
        fileSystem,
        path,
        specPath,
        outputDirectory,
        failedBenchmarkResult(context, outcome.failure),
      ).pipe(Effect.result);
      if (persisted._tag === "Failure") {
        return errorResponse(
          ExitCode.InternalError,
          `Cannot persist benchmark result: ${errorMessage(persisted.failure)}\n`,
        );
      }
      return new CliResponse({
        exitCode: ExitCode.InternalError,
        stdout: `result=${persisted.success}\n`,
        stderr: `Benchmark failed: ${outcome.failure.message}\n`,
      });
    }
    const persisted = yield* persistResult(
      fileSystem,
      path,
      specPath,
      outputDirectory,
      outcome.success,
    ).pipe(Effect.result);
    if (persisted._tag === "Failure") {
      return errorResponse(
        ExitCode.InternalError,
        `Cannot persist benchmark result: ${errorMessage(persisted.failure)}\n`,
      );
    }
    if (outcome.success.status === "failed") {
      return new CliResponse({
        exitCode: ExitCode.InternalError,
        stdout: `result=${persisted.success}\n`,
        stderr: `Benchmark failed: ${outcome.success.error.message}\n`,
      });
    }
    return successResponse(`result=${persisted.success}\n`);
  });

export const executeRunSpec = (
  spec: RunSpec,
  outputDirectory: string,
) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const specPath = path.join(outputDirectory, "benchmark-spec.json");
    const written = yield* fileSystem.makeDirectory(outputDirectory, { recursive: true }).pipe(
      Effect.andThen(fileSystem.writeFileString(specPath, `${JSON.stringify(spec, null, 2)}\n`)),
      Effect.result,
    );
    if (written._tag === "Failure") {
      return errorResponse(
        ExitCode.InternalError,
        `Cannot persist benchmark specification: ${errorMessage(written.failure)}\n`,
      );
    }
    return yield* executeValidatedRun(specPath, outputDirectory, spec);
  });

const executeRun = (specPath: string, outputDirectory: string) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const loaded = yield* fileSystem.readFileString(specPath, "utf8").pipe(
      Effect.flatMap(decodeRunSpec),
      Effect.result,
    );
    if (loaded._tag === "Failure") {
      return errorResponse(
        ExitCode.UsageError,
        `Invalid run specification: ${errorMessage(loaded.failure)}\n`,
      );
    }
    return yield* executeValidatedRun(specPath, outputDirectory, loaded.success);
  });

export const makeRunCommand = (respond: CliResponder) =>
  Command.make(
    "run",
    {
      spec: Flag.String("spec"),
      output: Flag.String("output"),
    },
    ({ output, spec }) => Effect.flatMap(executeRun(spec, output), respond),
  ).pipe(Command.withDescription("Run a benchmark from a validated run specification"));
