import {
  BenchmarkJob,
  type BenchmarkMatrix,
  buildBenchmarkMatrix,
  makeRunSpec,
  selectVersions,
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

const writeGithubPlan = (path: string, matrix: BenchmarkMatrix) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(
      path,
      [
        `matrix=${JSON.stringify({ include: matrix.include })}`,
        `versions=${JSON.stringify(matrix.versions)}`,
        `has_jobs=${matrix.include.length > 0 ? "true" : "false"}`,
        "",
      ].join("\n"),
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

export const planBenchmarks = (
  benchmarks: ReadonlyArray<CatalogBenchmark>,
  versions: string | undefined,
  backfillMonths: number | undefined,
  selection: string,
  githubOutput?: string,
): Effect.Effect<CliResponse, never, FileSystem.FileSystem> =>
  selectVersions(versions, backfillMonths).pipe(
    Effect.flatMap((selectedVersions) =>
      buildBenchmarkMatrix(benchmarks, selectedVersions, selection)
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
          message: "job output directory must be empty to avoid reusing stale results",
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

export const JobSummary = Schema.Struct({
  version: Schema.NonEmptyString,
  job_id: Schema.NonEmptyString,
  benchmark_id: Schema.NonEmptyString,
  benchmark_job: Schema.NonEmptyString,
  status: Schema.Literals(["ok", "failed"]),
  exit_code: Schema.Int,
  seconds: Schema.Number,
  trials: Schema.String,
  result: Schema.String,
});

export type JobSummary = typeof JobSummary.Type;

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

export const formatDuration = (seconds: number) => {
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
const plainText = (text: string) => text.replaceAll("|", "\\|").replaceAll(/\s+/g, " ").trim();
const truncate = (text: string, length: number) =>
  text.length <= length ? text : `${text.slice(0, length - 1)}…`;
const SUMMARY_METRICS = 6;

const summarizeJob = (
  plan: BenchmarkJob,
  jobOutput: string,
  response: CliResponse,
  seconds: number,
) =>
  Effect.gen(function*() {
    const path = yield* Path.Path;
    const digest = yield* readResultDigest(path.join(jobOutput, "benchmark-result.json"));
    const ok = response.exitCode === ExitCode.Success;
    const trials = Option.map(digest, ({ trials }) => {
      const valid = trials.filter(({ valid }) => valid).length;
      return `${valid}/${trials.length} valid`;
    }).pipe(Option.getOrElse(() => "-"));
    const result = ok
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
        ).pipe(Option.getOrUndefined)
          ?? (response.stderr.length === 0 ? `exit code ${response.exitCode}` : response.stderr),
        200,
      );
    const summary: JobSummary = {
      version: plan.version,
      job_id: plan.job_id,
      benchmark_id: plan.benchmark_id,
      benchmark_job: plan.benchmark_job,
      status: ok ? "ok" : "failed",
      exit_code: response.exitCode,
      seconds,
      trials,
      result: plainText(result),
    };
    return summary;
  });

export const renderJobSummaries = (summaries: ReadonlyArray<JobSummary>): string =>
  [
    "| Benchmark | Status | Duration | Trials | Result |",
    "| --- | --- | --- | --- | --- |",
    ...summaries.map((summary) =>
      `| ${summary.benchmark_id} / ${summary.benchmark_job} | ${summary.status} | ${
        formatDuration(summary.seconds)
      } | ${summary.trials} | ${summary.result} |`
    ),
    "",
  ].join("\n");

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

const decodeBenchmarkJob = Schema.decodeUnknownEffect(
  Schema.fromJsonString(BenchmarkJob),
  { onExcessProperty: "error" },
);

export const runJob = (
  benchmarks: ReadonlyArray<CatalogBenchmark>,
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
    const plan = yield* decodeBenchmarkJob(planJson).pipe(
      Effect.mapError((error) => new SuiteError({ message: `invalid job plan: ${error.message}` })),
    );
    const resolved = resolveVersion(plan.version);
    if (resolved._tag === "InvalidVersion") {
      return yield* Effect.fail(new SuiteError({ message: resolved.message }));
    }
    const benchmark = benchmarks.find(({ id }) => id === plan.benchmark_id);
    if (benchmark === undefined) {
      return yield* Effect.fail(
        new SuiteError({ message: `unknown benchmark: ${plan.benchmark_id}` }),
      );
    }
    const jobOutput = path.join(output, plan.job_id);
    yield* ensureEmptyOutput(jobOutput);
    yield* writeJson(path.join(jobOutput, "job-plan.json"), plan);
    const startedAt = Date.now();
    const response = yield* Effect.logInfo("job started").pipe(
      Effect.andThen(makeRunSpec(benchmark, plan.benchmark_job, resolved.release)),
      Effect.flatMap((spec) => executeRunSpec(spec, jobOutput)),
      Effect.catch((error) =>
        Effect.succeed(errorResponse(ExitCode.UsageError, `${error.message}\n`))
      ),
      Effect.tap((response) =>
        (response.exitCode === ExitCode.Success
          ? Effect.logInfo("job completed")
          : Effect.logError(`job failed with exit code ${response.exitCode}`)).pipe(
            Effect.annotateLogs({ job_seconds: Math.round((Date.now() - startedAt) / 1000) }),
          )
      ),
      Effect.annotateLogs({
        version: plan.version,
        job_id: plan.job_id,
        benchmark_id: plan.benchmark_id,
        benchmark_job: plan.benchmark_job,
      }),
      Effect.withLogSpan("job"),
    );
    const summary = yield* summarizeJob(
      plan,
      jobOutput,
      response,
      (Date.now() - startedAt) / 1000,
    );
    yield* writeJson(path.join(jobOutput, "job-summary.json"), summary);
    const report = [
      `### LiteLLM ${plan.version}: ${plan.benchmark_id} / ${plan.benchmark_job} ${summary.status} in ${
        formatDuration(summary.seconds)
      }`,
      "",
      renderJobSummaries([summary]),
    ].join("\n");
    yield* appendText(path.join(jobOutput, "job-summary.md"), report);
    if (githubStepSummary !== undefined) {
      yield* appendText(githubStepSummary, report);
    }
    return response;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(errorResponse(ExitCode.UsageError, `${error.message}\n`))
    ),
  );

const decodeJobSummary = Schema.decodeUnknownEffect(
  Schema.fromJsonString(JobSummary),
  { onExcessProperty: "error" },
);

const readJobSummaries = (input: string) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fileSystem.readDirectory(input);
    const summaries = yield* Effect.forEach(entries.toSorted(), (entry) => {
      const location = path.join(input, entry, "job-summary.json");
      return fileSystem.exists(location).pipe(
        Effect.flatMap((exists) =>
          exists
            ? Effect.map(
              Effect.flatMap(fileSystem.readFileString(location), decodeJobSummary),
              (summary) => [summary],
            )
            : Effect.succeed([])
        ),
      );
    });
    return summaries.flat();
  }).pipe(
    Effect.mapError((error) =>
      new SuiteError({
        message: `cannot read job summaries: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
    ),
  );

export const summarizeVersion = (
  version: string,
  input: string,
  githubOutput?: string,
  githubStepSummary?: string,
): Effect.Effect<CliResponse, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const summaries = yield* readJobSummaries(input);
    if (summaries.length === 0) {
      return yield* Effect.fail(new SuiteError({ message: `${input} contains no job summaries` }));
    }
    const foreign = summaries.filter((summary) => summary.version !== version);
    if (foreign.length > 0) {
      return yield* Effect.fail(
        new SuiteError({
          message: `job summaries belong to other versions: ${
            [...new Set(foreign.map(({ version }) => version))].join(", ")
          }`,
        }),
      );
    }
    const succeeded = summaries.filter(({ status }) => status === "ok").length;
    const failed = summaries.length - succeeded;
    const report = [
      `### LiteLLM ${version}: ${succeeded}/${summaries.length} benchmarks succeeded`,
      "",
      renderJobSummaries(summaries),
    ].join("\n");
    if (githubOutput !== undefined) {
      yield* appendText(
        githubOutput,
        `succeeded=${succeeded}\nfailed=${failed}\nreport<<LITELLM_BENCH_REPORT\n${report}LITELLM_BENCH_REPORT\n`,
      );
    }
    if (githubStepSummary !== undefined) {
      yield* appendText(githubStepSummary, report);
    }
    return successResponse(report);
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
    },
    ({ backfillMonths, githubOutput, selection, versions }) =>
      Effect.flatMap(BenchmarkCatalog, ({ benchmarks }) =>
        Effect.flatMap(
          planBenchmarks(
            benchmarks,
            Option.getOrUndefined(versions),
            Option.getOrUndefined(backfillMonths),
            selection,
            Option.getOrUndefined(githubOutput),
          ),
          respond,
        )),
  ).pipe(Command.withDescription("Build the benchmark workflow matrix"));

export const makeRunJobCommand = (respond: CliResponder) =>
  Command.make(
    "run-job",
    {
      planJson: Flag.String("plan-json").pipe(
        Flag.withDescription("One entry from the planned benchmark matrix, as JSON"),
      ),
      output: Flag.String("output"),
      githubStepSummary: Flag.String("github-step-summary").pipe(
        Flag.withDescription("Append a Markdown report to this GitHub step summary file"),
        Flag.optional,
      ),
    },
    ({ githubStepSummary, output, planJson }) =>
      Effect.flatMap(BenchmarkCatalog, ({ benchmarks }) =>
        Effect.flatMap(
          runJob(benchmarks, planJson, output, Option.getOrUndefined(githubStepSummary)),
          respond,
        )),
  ).pipe(Command.withDescription("Run one planned benchmark job for one LiteLLM version"));

export const makeSummarizeVersionCommand = (respond: CliResponder) =>
  Command.make(
    "summarize-version",
    {
      version: Flag.String("version"),
      input: Flag.String("input").pipe(
        Flag.withDescription("Directory holding the collected per-job output directories"),
      ),
      githubOutput: Flag.String("github-output").pipe(Flag.optional),
      githubStepSummary: Flag.String("github-step-summary").pipe(Flag.optional),
    },
    ({ githubOutput, githubStepSummary, input, version }) =>
      Effect.flatMap(
        summarizeVersion(
          version,
          input,
          Option.getOrUndefined(githubOutput),
          Option.getOrUndefined(githubStepSummary),
        ),
        respond,
      ),
  ).pipe(Command.withDescription("Summarize the collected benchmark jobs of one LiteLLM version"));
