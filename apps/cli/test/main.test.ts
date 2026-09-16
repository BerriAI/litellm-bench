import { NodeServices } from "@effect/platform-node";
import {
  type BenchmarkRunner,
  RunMetadataGenerator,
  runnerRegistryLayer,
} from "@litellm-bench/harness";
import { Effect, FileSystem, Layer, Logger, Path } from "effect";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { type CatalogBenchmark, catalogLayer, ExitCode, runCli } from "../src/main.js";

const platform = await Effect.runPromise(
  Effect.all({ fs: FileSystem.FileSystem, path: Path.Path }).pipe(
    Effect.provide(NodeServices.layer),
  ),
);
const { dirname, join, resolve } = platform.path;
const mkdtemp = (prefix: string) =>
  Effect.runPromise(platform.fs.makeTempDirectory({
    directory: platform.path.dirname(prefix),
    prefix: platform.path.basename(prefix),
  }));
const readFile = (location: string, _encoding: "utf8") =>
  Effect.runPromise(platform.fs.readFileString(location));
const rm = (location: string, options: { recursive: boolean; force: boolean }) =>
  Effect.runPromise(platform.fs.remove(location, options));
const writeFile = (location: string, contents: string) =>
  Effect.runPromise(platform.fs.writeFileString(location, contents));

const benchmarks: ReadonlyArray<CatalogBenchmark> = [
  {
    id: "sdk-import-time",
    label: "Python import time",
    kind: "sdk",
    artifact: "sdk",
    canonicalJob: "base",
    canonicalRunner: "ubuntu-24.04",
    metrics: { "import.median": { unit: "ms", better: "lower" } },
    definition: {
      id: "sdk-import-time",
      label: "Python import time",
      kind: "sdk",
      artifact: "sdk",
      output_metrics: [{ id: "import.median", unit: "ms", better: "lower" }],
      protocol: {
        question: "How long does import take?",
        scenarios: [{ id: "root-import", label: "import litellm", dimensions: {} }],
        measurements: [{
          id: "import_duration_ms",
          label: "Import",
          unit: "ms",
          role: "primary",
        }],
        analyses: [],
      },
      jobs: [{
        id: "base",
        canonical: true,
        runner: "ubuntu-24.04",
        config: { python: "3.12" },
      }],
    },
  },
];

const invokeWithRunners = (
  args: ReadonlyArray<string>,
  runners: ReadonlyArray<BenchmarkRunner>,
  logMessages?: Array<string>,
) => {
  const program = runCli(args).pipe(Effect.provide(Layer.mergeAll(
    NodeServices.layer,
    catalogLayer(benchmarks),
    runnerRegistryLayer(Effect.succeed(runners)),
    Layer.succeed(RunMetadataGenerator, {
      make: Effect.succeed({ runId: "test-run", createdAt: "2026-09-13T12:00:00Z" }),
    }),
  )));
  return Effect.runPromise(
    logMessages === undefined
      ? program
      : program.pipe(Effect.provide(Logger.layer([
        Logger.make(({ message }) => logMessages.push(String(message))),
      ]))),
  );
};

const invoke = (args: ReadonlyArray<string>) => invokeWithRunners(args, []);

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("runCli", () => {
  it("keeps the documented process exit codes stable", () => {
    expect(ExitCode).toEqual({ Success: 0, InternalError: 1, UsageError: 2, NotFound: 3 });
  });

  it("lists catalog entries", async () => {
    await expect(invoke(["list"])).resolves.toEqual({
      exitCode: ExitCode.Success,
      stdout: "sdk-import-time\tPython import time\n",
      stderr: "",
    });
  });

  it("describes a catalog entry", async () => {
    const response = await invoke(["describe", "sdk-import-time"]);

    expect(response.exitCode).toBe(ExitCode.Success);
    expect(JSON.parse(response.stdout)).toEqual(benchmarks[0]);
  });

  it("builds the workflow matrix from the catalog", async () => {
    const response = await invoke([
      "plan",
      "--versions",
      "1.80.0",
      "--selection",
      "sdk-import-time",
    ]);

    expect(response.exitCode).toBe(ExitCode.Success);
    expect(JSON.parse(response.stdout)).toEqual({
      include: [{
        version: "1.80.0",
        job_id: "sdk-import-time-1-80-0-base",
        benchmark_id: "sdk-import-time",
        benchmark_job: "base",
        runner: "ubuntu-24.04",
        needs_proxy: false,
      }],
      versions: ["1.80.0"],
    });
  });

  it("fans out one matrix entry per version and benchmark job", async () => {
    const root = await mkdtemp(join(tmpdir(), "litellm-bench-cli-plan-"));
    const githubOutput = join(root, "github-output");
    try {
      const response = await invoke([
        "plan",
        "--versions",
        "1.80.0,1.81.0",
        "--selection",
        "sdk-import-time",
        "--github-output",
        githubOutput,
      ]);
      expect(response.exitCode).toBe(ExitCode.Success);
      const written = await readFile(githubOutput, "utf8");
      const outputs = Object.fromEntries(
        written.trimEnd().split("\n").map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
      );
      expect(JSON.parse(outputs.matrix).include.map((entry: any) => entry.job_id)).toEqual([
        "sdk-import-time-1-80-0-base",
        "sdk-import-time-1-81-0-base",
      ]);
      expect(JSON.parse(outputs.versions)).toEqual(["1.80.0", "1.81.0"]);
      expect(outputs.has_jobs).toBe("true");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers the latest stable release and date-window stable backfills", async () => {
    const uploaded = (daysAgo: number) =>
      new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1_000).toISOString();
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          releases: {
            "1.77.0": [{ upload_time_iso_8601: uploaded(100), yanked: false }],
            "1.78.0": [{ upload_time_iso_8601: uploaded(40), yanked: false }],
            "1.79.0rc1": [{ upload_time_iso_8601: uploaded(2), yanked: false }],
            "1.79.0": [{ upload_time_iso_8601: uploaded(1), yanked: false }],
          },
        }),
        { status: 200 },
      )
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const latest = await invoke(["plan"]);
      expect(latest.exitCode).toBe(ExitCode.Success);
      expect(JSON.parse(latest.stdout).include.map((entry: any) => entry.version)).toEqual([
        "1.79.0",
      ]);

      const backfill = await invoke(["plan", "--backfill-months", "2"]);
      expect(backfill.exitCode).toBe(ExitCode.Success);
      expect(
        JSON.parse(backfill.stdout).include.map((entry: any) => entry.version).toSorted(),
      ).toEqual(["1.78.0", "1.79.0"]);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("allows explicit prereleases and rejects ambiguous version selection", async () => {
    const explicit = await invoke(["plan", "--versions", "1.80.0rc1"]);
    expect(explicit.exitCode).toBe(ExitCode.Success);
    expect(JSON.parse(explicit.stdout).include[0].version).toBe("1.80.0rc1");

    const ambiguous = await invoke([
      "plan",
      "--versions",
      "1.80.0",
      "--backfill-months",
      "3",
    ]);
    expect(ambiguous.exitCode).toBe(ExitCode.UsageError);
    expect(ambiguous.stderr).toBe("versions and backfill-months cannot be used together\n");
  });

  it("uses exit code 2 for invalid arguments", async () => {
    const response = await invoke(["run", "sdk-import-time"]);

    expect(response.exitCode).toBe(ExitCode.UsageError);
    expect(response.stderr).toMatch(/^Usage:/);
  });

  it("runs a registered benchmark and persists its result", async () => {
    const root = await mkdtemp(join(tmpdir(), "litellm-bench-cli-run-"));
    const specPath = join(root, "input-spec.json");
    const output = join(root, "output");
    const spec = {
      case_id: "a".repeat(64),
      comparison_id: "b".repeat(64),
      benchmark: {
        id: "sdk-import-time",
        label: "Python import time",
        kind: "sdk",
        output_metrics: [{ id: "import.median", unit: "ms", better: "lower" }],
        protocol: {
          question: "How long does import take?",
          scenarios: [{ id: "root-import", label: "import litellm", dimensions: {} }],
          measurements: [{
            id: "import_duration_ms",
            label: "Import",
            unit: "ms",
            role: "primary",
          }],
          analyses: [],
        },
      },
      job: { id: "base", canonical: true, runner: "ubuntu-24.04", config: {} },
      version: { version: "1.0.0", artifacts: {} },
      artifact: {},
    } as const;
    await writeFile(specPath, JSON.stringify(spec));
    const runner: BenchmarkRunner = {
      id: "sdk-import-time",
      run: (context) =>
        Effect.succeed({
          run_id: context.runId,
          created_at: context.createdAt,
          case_id: context.spec.case_id,
          comparison_id: context.spec.comparison_id,
          benchmark: context.spec.benchmark,
          job: context.spec.job,
          version: context.spec.version.version,
          artifact: context.spec.artifact,
          apparatus: {},
          metrics: [{
            id: "import.median",
            label: "Median",
            value: 100,
            unit: "ms",
            better: "lower",
          }],
          trials: [],
          analyses: [],
          status: "ok",
        }),
    };

    try {
      const response = await invokeWithRunners([
        "run",
        "--spec",
        specPath,
        "--output",
        output,
      ], [runner]);
      const result = JSON.parse(await readFile(join(output, "benchmark-result.json"), "utf8")) as {
        readonly run_id: string;
      };

      expect(response).toEqual({
        exitCode: ExitCode.Success,
        stdout: `result=${join(output, "benchmark-result.json")}\n`,
        stderr: "",
      });
      expect(result.run_id).toBe("test-run");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs a planned job through the registered TS runner and summarizes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "litellm-bench-cli-job-"));
    const output = join(root, "output");
    const runner: BenchmarkRunner = {
      id: "sdk-import-time",
      run: (context) =>
        Effect.succeed({
          run_id: context.runId,
          created_at: context.createdAt,
          case_id: context.spec.case_id,
          comparison_id: context.spec.comparison_id,
          benchmark: context.spec.benchmark,
          job: context.spec.job,
          version: context.spec.version.version,
          artifact: context.spec.artifact,
          apparatus: {},
          metrics: [{
            id: "import.median",
            label: "Median",
            value: 100,
            unit: "ms",
            better: "lower",
          }],
          trials: [],
          analyses: [],
          status: "ok",
        }),
    };
    const plan = {
      version: "1.0.0",
      job_id: "sdk-import-time-1-0-0-base",
      benchmark_id: "sdk-import-time",
      benchmark_job: "base",
      runner: "ubuntu-24.04",
      needs_proxy: false,
    };
    const logMessages: Array<string> = [];

    try {
      const response = await invokeWithRunners(
        [
          "run-job",
          "--plan-json",
          JSON.stringify(plan),
          "--output",
          output,
          "--github-step-summary",
          join(root, "step-summary.md"),
        ],
        [runner],
        logMessages,
      );
      const jobOutput = join(output, plan.job_id);
      const summary = JSON.parse(await readFile(join(jobOutput, "job-summary.json"), "utf8"));
      const report = await readFile(join(jobOutput, "job-summary.md"), "utf8");
      const stepSummary = await readFile(join(root, "step-summary.md"), "utf8");
      const spec = JSON.parse(await readFile(join(jobOutput, "benchmark-spec.json"), "utf8"));

      expect(response).toMatchObject({
        exitCode: ExitCode.Success,
        stdout: `result=${join(jobOutput, "benchmark-result.json")}\n`,
      });
      expect(logMessages).toEqual([
        "job started",
        "benchmark started",
        "benchmark completed",
        "job completed",
      ]);
      expect(summary).toMatchObject({
        version: plan.version,
        job_id: plan.job_id,
        benchmark_id: plan.benchmark_id,
        benchmark_job: plan.benchmark_job,
        status: "ok",
        exit_code: 0,
        trials: "0/0 valid",
        result: "Median: 100 ms",
      });
      expect(report).toContain("### LiteLLM 1.0.0: sdk-import-time / base ok in ");
      expect(report).toContain("| sdk-import-time / base | ok | ");
      expect(report).toContain("| 0/0 valid | Median: 100 ms |");
      expect(stepSummary).toBe(report);
      expect(spec.case_id).toMatch(/^[a-f0-9]{64}$/);
      expect(spec.comparison_id).toMatch(/^[a-f0-9]{64}$/);

      const githubOutput = join(root, "github-output");
      const versionSummary = await invoke([
        "summarize-version",
        "--version",
        "1.0.0",
        "--input",
        output,
        "--github-output",
        githubOutput,
      ]);
      expect(versionSummary.exitCode).toBe(ExitCode.Success);
      expect(versionSummary.stdout).toContain("### LiteLLM 1.0.0: 1/1 benchmarks succeeded");
      expect(versionSummary.stdout).toContain("| sdk-import-time / base | ok | ");
      const outputs = await readFile(githubOutput, "utf8");
      expect(outputs).toContain("succeeded=1\nfailed=0\nreport<<LITELLM_BENCH_REPORT\n");
      expect(outputs.endsWith("LITELLM_BENCH_REPORT\n")).toBe(true);

      await expect(invoke(["summarize-version", "--version", "2.0.0", "--input", output]))
        .resolves.toMatchObject({
          exitCode: ExitCode.UsageError,
          stderr: "job summaries belong to other versions: 1.0.0\n",
        });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates write modes with Schema", async () => {
    await expect(invoke([
      "data",
      "ingest",
      "--input",
      "input",
      "--data",
      "data",
      "--mode",
      "overwrite",
    ])).resolves.toEqual({
      exitCode: ExitCode.UsageError,
      stdout: "",
      stderr: "unsupported write mode: overwrite\n",
    });
  });

  it("uses exit code 3 for unknown catalog selections", async () => {
    await expect(invoke(["describe", "missing"])).resolves.toEqual({
      exitCode: ExitCode.NotFound,
      stdout: "",
      stderr: "Benchmark not found: missing\n",
    });
    const missing = await invoke([
      "plan",
      "--versions",
      "1.0.0",
      "--selection",
      "missing",
    ]);
    expect(missing.exitCode).toBe(ExitCode.UsageError);
    expect(missing.stderr).toBe("unknown benchmark ids: missing\n");
  });

  it("validates current documents and checks generated schemas", async () => {
    const output = await mkdtemp(join(tmpdir(), "litellm-bench-schemas-"));
    await expect(invoke([
      "validate",
      join(repository, "benchmarks/sdk-import-time/benchmark.json"),
    ])).resolves.toMatchObject({ exitCode: ExitCode.Success, stdout: "valid=benchmark\n" });
    const generated = await invoke(["schema", "generate", "--output", output]);
    expect(generated).toMatchObject({ exitCode: ExitCode.Success });
    const count = Number.parseInt(generated.stdout.slice("generated=".length), 10);
    await expect(invoke([
      "schema",
      "check",
      "--output",
      output,
    ])).resolves.toMatchObject({
      exitCode: ExitCode.Success,
      stdout: `checked=${count}\n`,
    });
  });
});
