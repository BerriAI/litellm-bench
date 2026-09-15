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

interface JobOutcome {
  readonly job_id: string;
  readonly exit_code: ExitCode;
  readonly error?: string;
}

interface JobReport extends JobOutcome {
  readonly benchmark_id: string;
  readonly benchmark_job: string;
  readonly seconds: number;
}

const ResultDigest = Schema.Struct({
  status: Schema.Literals(["ok", "failed"]),
  metrics: Schema.Array(Schema.Struct({
    label: Schema.String,
    value: Schema.Number,
    unit: Schema.String,
  })),
  trials: Schema.Array(Schema.Struct({ valid: Schema.Boolean })),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.String, message: Schema.String })),
});
const decodeResultDigest = Schema.decodeUnknownEffect(Schema.fromJsonString(ResultDigest));

const readResultDigest = (location: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFileString(location)).pipe(
    Effect.flatMap(decodeResultDigest),
    Effect.option,
  );

const formatDuration = (seconds: number) => {
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, "0")}m`
    : minutes > 0
    ? `${minutes}m ${String(rest).padStart(2, "0")}s`
    : `${rest}s`;
};
const formatValue = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toPrecision(4).replace(/\.?0+$/, "");
const markdownCell = (text: string) => text.replaceAll("|", "\\|").replaceAll(/\s+/g, " ").trim();
const truncate = (text: string, length: number) =>
  text.length <= length ? text : `${text.slice(0, length - 1)}…`;
const SUMMARY_METRICS = 6;

const renderVersionSummary = (
  version: string,
  output: string,
  reports: ReadonlyArray<JobReport>,
  totalSeconds: number,
) =>
  Effect.gen(function*() {
    const path = yield* Path.Path;
    const rows = yield* Effect.forEach(reports, (report, index) =>
      Effect.map(
        readResultDigest(path.join(output, report.job_id, "benchmark-result.json")),
        (digest) => {
          const ok = report.exit_code === ExitCode.Success;
          const trials = Option.map(digest, ({ trials }) => {
            const valid = trials.filter(({ valid }) => valid).length;
            return `${valid}/${trials.length} valid`;
          }).pipe(Option.getOrElse(() => "-"));
          const detail = ok
            ? Option.map(digest, ({ metrics }) => {
              const shown = metrics.slice(0, SUMMARY_METRICS).map(({ label, unit, value }) =>
                `${label}: ${formatValue(value)}${unit.length === 0 ? "" : ` ${unit}`}`
              );
              return metrics.length > SUMMARY_METRICS
                ? [...shown, `+${metrics.length - SUMMARY_METRICS} more`].join("; ")
                : shown.join("; ");
            }).pipe(Option.getOrElse(() => "-"))
            : truncate(
              Option.map(
                digest,
                ({ error }) => error === undefined ? undefined : `${error.code}: ${error.message}`,
              ).pipe(Option.getOrUndefined) ?? report.error ?? `exit code ${report.exit_code}`,
              200,
            );
          return `| ${index + 1} | ${report.benchmark_id} / ${report.benchmark_job} | ${
            ok ? "ok" : "failed"
          } | ${formatDuration(report.seconds)} | ${trials} | ${markdownCell(detail)} |`;
        },
      ), { concurrency: 1 });
    const succeeded = reports.filter(({ exit_code }) => exit_code === ExitCode.Success).length;
    return [
      `### LiteLLM ${version}: ${succeeded}/${reports.length} benchmarks succeeded in ${
        formatDuration(totalSeconds)
      }`,
      "",
      "| # | Benchmark | Status | Duration | Trials | Result |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows,
      "",
    ].join("\n");
  });

const appendText = (location: string, text: string) =>
  Effect.flatMap(
    FileSystem.FileSystem,
    (fileSystem) => fileSystem.writeFileString(location, text, { flag: "a" }),
  ).pipe(
    Effect.mapError((error) =>
      new SuiteError({
        message: `cannot write step summary: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
    ),
  );

export const runVersion = (
  benchmarks: ReadonlyArray<CatalogBenchmark>,
  version: string,
  planJson: string,
  output: string,
  githubStepSummary?: string,
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
    const runStartedAt = Date.now();
    const reports = yield* Effect.forEach(plan.jobs, (entry, index) =>
      Effect.suspend(() => {
        const startedAt = Date.now();
        const report = (outcome: JobOutcome): JobReport => ({
          ...outcome,
          benchmark_id: entry.benchmark_id,
          benchmark_job: entry.benchmark_job,
          seconds: (Date.now() - startedAt) / 1000,
        });
        const benchmark = benchmarks.find(({ id }) => id === entry.benchmark_id);
        if (benchmark === undefined) {
          return Effect.logError(`unknown benchmark: ${entry.benchmark_id}`).pipe(
            Effect.map(() =>
              report({
                job_id: entry.job_id,
                exit_code: ExitCode.NotFound,
                error: `unknown benchmark: ${entry.benchmark_id}`,
              })
            ),
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
        const jobProgress = () => ({
          job_seconds: Math.round((Date.now() - startedAt) / 1000),
          run_seconds: Math.round((Date.now() - runStartedAt) / 1000),
          remaining_jobs: plan.jobs.length - index - 1,
        });
        return Effect.logInfo("version job started").pipe(
          Effect.andThen(makeRunSpec(benchmark, entry.benchmark_job, resolved.release)),
          Effect.flatMap((spec) => executeRunSpec(spec, path.join(output, entry.job_id))),
          Effect.tap((response) =>
            (response.exitCode === ExitCode.Success
              ? Effect.logInfo("version job completed")
              : Effect.logError(`version job failed with exit code ${response.exitCode}`)).pipe(
                Effect.annotateLogs(jobProgress()),
              )
          ),
          Effect.map((response) =>
            report({
              job_id: entry.job_id,
              exit_code: response.exitCode,
              ...(response.stderr.length === 0 ? {} : { error: response.stderr.trim() }),
            })
          ),
          Effect.tapError((error) =>
            Effect.logError(`version job failed: ${error.message}`).pipe(
              Effect.annotateLogs(jobProgress()),
            )
          ),
          Effect.catch((error) =>
            Effect.succeed(report({
              job_id: entry.job_id,
              exit_code: ExitCode.UsageError,
              error: error.message,
            }))
          ),
          Effect.annotateLogs(annotations),
          Effect.withLogSpan("version_job"),
        );
      }), { concurrency: 1 });
    const outcomes: ReadonlyArray<JobOutcome> = reports.map(({ job_id, exit_code, error }) => ({
      job_id,
      exit_code,
      ...(error === undefined ? {} : { error }),
    }));
    yield* writeJson(path.join(output, "version-summary.json"), outcomes);
    const summary = yield* renderVersionSummary(
      version,
      output,
      reports,
      (Date.now() - runStartedAt) / 1000,
    );
    yield* appendText(path.join(output, "version-summary.md"), summary);
    if (githubStepSummary !== undefined) {
      yield* appendText(githubStepSummary, summary);
    }
    const failed = outcomes.filter(({ exit_code }) => exit_code !== ExitCode.Success);
    yield* Effect.logInfo("version run completed").pipe(Effect.annotateLogs({
      version,
      completed: outcomes.length - failed.length,
      failed: failed.length,
      run_seconds: Math.round((Date.now() - runStartedAt) / 1000),
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
      githubStepSummary: Flag.String("github-step-summary").pipe(
        Flag.withDescription("Append a Markdown progress report to this GitHub step summary file"),
        Flag.optional,
      ),
    },
    ({ githubStepSummary, output, planJson, version }) =>
      Effect.flatMap(BenchmarkCatalog, ({ benchmarks }) =>
        Effect.flatMap(
          runVersion(
            benchmarks,
            version,
            planJson,
            output,
            Option.getOrUndefined(githubStepSummary),
          ),
          respond,
        )),
  ).pipe(Command.withDescription("Run one version's planned benchmarks sequentially"));
