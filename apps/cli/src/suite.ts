import {
  buildVersionMatrix,
  makeRunSpec,
  selectVersions,
  VersionJob,
  type VersionMatrix,
} from "@litellm-bench/suite";
import { resolveVersion } from "@litellm-bench/versions";
import { Data, Effect, FileSystem, Option, Path, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  BenchmarkCatalog,
  type CatalogBenchmark,
  type CliResponder,
  CliResponse,
  errorResponse,
  ExitCode,
  successResponse,
} from "./model.js";
import { executeRunSpec } from "./runs.js";

class SuiteError extends Data.TaggedError("SuiteError")<{
  readonly message: string;
}> {}

const writeGithubPlan = (path: string, matrix: VersionMatrix) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(
      path,
      `matrix=${JSON.stringify(matrix)}\nhas_jobs=${
        matrix.include.length > 0 ? "true" : "false"
      }\n`,
      { flag: "a" },
    );
  }).pipe(
    Effect.mapError((error) =>
      new SuiteError({
        message: `cannot write GitHub output: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
    ),
  );

export const planVersions = (
  benchmarks: ReadonlyArray<CatalogBenchmark>,
  versions: string | undefined,
  backfillMonths: number | undefined,
  selection: string,
  githubOutput?: string,
  orderSeed = "local",
): Effect.Effect<CliResponse, never, FileSystem.FileSystem> =>
  selectVersions(versions, backfillMonths).pipe(
    Effect.flatMap((selectedVersions) =>
      buildVersionMatrix(benchmarks, selectedVersions, selection, orderSeed)
    ),
    Effect.flatMap((matrix) =>
      githubOutput === undefined
        ? Effect.succeed(successResponse(`${JSON.stringify(matrix, null, 2)}\n`))
        : writeGithubPlan(githubOutput, matrix).pipe(
          Effect.as(successResponse(`${JSON.stringify(matrix)}\n`)),
        )
    ),
    Effect.catch((error) =>
      Effect.succeed(errorResponse(ExitCode.UsageError, `${error.message}\n`))
    ),
  );

const ensureEmptyOutput = (output: string) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(output, { recursive: true });
    if ((yield* fileSystem.readDirectory(output)).length > 0) {
      return yield* Effect.fail(
        new SuiteError({
          message: "version output directory must be empty to avoid reusing stale results",
        }),
      );
    }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SuiteError
        ? error
        : new SuiteError({ message: error instanceof Error ? error.message : String(error) })
    ),
  );

const writeJson = (path: string, value: unknown) =>
  Effect.flatMap(
    FileSystem.FileSystem,
    (fileSystem) => fileSystem.writeFileString(path, `${JSON.stringify(value, null, 2)}\n`),
  ).pipe(
    Effect.mapError((error) =>
      new SuiteError({ message: error instanceof Error ? error.message : String(error) })
    ),
  );

export const runVersion = (
  benchmarks: ReadonlyArray<CatalogBenchmark>,
  version: string,
  planJson: string,
  output: string,
): Effect.Effect<
  CliResponse,
  never,
  | import("@litellm-bench/harness").RunnerRegistry
  | import("@litellm-bench/harness").RunMetadataGenerator
  | import("effect").FileSystem.FileSystem
  | import("effect").Path.Path
> =>
  Effect.gen(function*() {
    const path = yield* Path.Path;
    const plan = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(VersionJob),
      { onExcessProperty: "error" },
    )(planJson).pipe(
      Effect.mapError((error) =>
        new SuiteError({ message: `invalid version plan: ${error.message}` })
      ),
    );
    if (plan.version !== version) {
      return yield* Effect.fail(
        new SuiteError({
          message: `version plan contains ${plan.version}, expected ${version}`,
        }),
      );
    }
    const resolved = resolveVersion(version);
    if (resolved._tag === "InvalidVersion") {
      return yield* Effect.fail(new SuiteError({ message: resolved.message }));
    }
    yield* ensureEmptyOutput(output);
    yield* writeJson(path.join(output, "version-plan.json"), plan);
    yield* Effect.logInfo("version run started").pipe(Effect.annotateLogs({
      version,
      jobs: plan.jobs.length,
    }));
    const outcomes = yield* Effect.forEach(plan.jobs, (entry, index) => {
      const benchmark = benchmarks.find(({ id }) => id === entry.benchmark_id);
      if (benchmark === undefined) {
        return Effect.logError(`unknown benchmark: ${entry.benchmark_id}`).pipe(
          Effect.as({
            job_id: entry.job_id,
            exit_code: ExitCode.NotFound,
            error: `unknown benchmark: ${entry.benchmark_id}`,
          }),
          Effect.annotateLogs({
            version,
            job_id: entry.job_id,
            job: index + 1,
            jobs: plan.jobs.length,
          }),
        );
      }
      const annotations = {
        version,
        job_id: entry.job_id,
        benchmark_id: entry.benchmark_id,
        benchmark_job: entry.benchmark_job,
        job: index + 1,
        jobs: plan.jobs.length,
      };
      return Effect.logInfo("version job started").pipe(
        Effect.andThen(makeRunSpec(benchmark, entry.benchmark_job, resolved.release)),
        Effect.flatMap((spec) => executeRunSpec(spec, path.join(output, entry.job_id))),
        Effect.tap((response) =>
          response.exitCode === ExitCode.Success
            ? Effect.logInfo("version job completed")
            : Effect.logError(`version job failed with exit code ${response.exitCode}`)
        ),
        Effect.map((response) => ({
          job_id: entry.job_id,
          exit_code: response.exitCode,
          ...(response.stderr.length === 0 ? {} : { error: response.stderr.trim() }),
        })),
        Effect.tapError((error) => Effect.logError(`version job failed: ${error.message}`)),
        Effect.catch((error) =>
          Effect.succeed({
            job_id: entry.job_id,
            exit_code: ExitCode.UsageError,
            error: error.message,
          })
        ),
        Effect.annotateLogs(annotations),
        Effect.withLogSpan("version_job"),
      );
    }, { concurrency: 1 });
    yield* writeJson(path.join(output, "version-summary.json"), outcomes);
    const failed = outcomes.filter(({ exit_code }) => exit_code !== ExitCode.Success);
    yield* Effect.logInfo("version run completed").pipe(Effect.annotateLogs({
      version,
      completed: outcomes.length - failed.length,
      failed: failed.length,
    }));
    return failed.length === 0
      ? successResponse(`completed=${outcomes.length}\n`)
      : new CliResponse({
        exitCode: ExitCode.InternalError,
        stdout: `completed=${outcomes.length - failed.length}\nfailed=${failed.length}\n`,
        stderr: `${
          failed.map(({ job_id, error }) => `${job_id}: ${error ?? "failed"}`).join("\n")
        }\n`,
      });
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(errorResponse(ExitCode.UsageError, `${error.message}\n`))
    ),
  );

export const makePlanCommand = (respond: CliResponder) =>
  Command.make(
    "plan",
    {
      versions: Flag.String("versions").pipe(
        Flag.withDescription("Exact comma-separated versions; may include RC/dev releases"),
        Flag.optional,
      ),
      backfillMonths: Flag.Int("backfill-months").pipe(
        Flag.withDescription("Discover stable releases uploaded in the last N 30-day months"),
        Flag.optional,
      ),
      selection: Flag.String("selection").pipe(Flag.withDefault("all")),
      githubOutput: Flag.String("github-output").pipe(Flag.optional),
      orderSeed: Flag.String("order-seed").pipe(Flag.withDefault("local")),
    },
    ({ backfillMonths, githubOutput, orderSeed, selection, versions }) =>
      Effect.flatMap(BenchmarkCatalog, ({ benchmarks }) =>
        Effect.flatMap(
          planVersions(
            benchmarks,
            Option.getOrUndefined(versions),
            Option.getOrUndefined(backfillMonths),
            selection,
            Option.getOrUndefined(githubOutput),
            orderSeed,
          ),
          respond,
        )),
  ).pipe(Command.withDescription("Build the benchmark workflow matrix"));

export const makeRunVersionCommand = (respond: CliResponder) =>
  Command.make(
    "run-version",
    {
      version: Flag.String("version"),
      planJson: Flag.String("plan-json"),
      output: Flag.String("output"),
    },
    ({ output, planJson, version }) =>
      Effect.flatMap(BenchmarkCatalog, ({ benchmarks }) =>
        Effect.flatMap(runVersion(benchmarks, version, planJson, output), respond)),
  ).pipe(Command.withDescription("Run one version's planned benchmarks sequentially"));
