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
        runner: "ubuntu-24.04",
        jobs: [{
          job_id: "sdk-import-time-1-80-0-base",
          benchmark_id: "sdk-import-time",
          benchmark_job: "base",
          runner: "ubuntu-24.04",
        }],
        needs_proxy: false,
        comparison_order: {
          method: "seeded-fisher-yates",
          position: 1,
          total: 1,
          seed_sha256: "25bf8e1a2393f1108d37029b3df5593236c755742ec93465bbafa9b290bddcf6",
        },
      }],
    });
  });

  it("seed-shuffles version jobs and records the reproducible serial order", async () => {
    const args = [
      "plan",
      "--versions",
      "1.80.0,1.81.0,1.82.0",
      "--selection",
      "sdk-import-time",
      "--order-seed",
      "workflow-42",
    ];
    const first = JSON.parse((await invoke(args)).stdout);
    const second = JSON.parse((await invoke(args)).stdout);
    expect(first).toEqual(second);
    expect(first.include.map((entry: any) => entry.version).toSorted()).toEqual([
      "1.80.0",
      "1.81.0",
      "1.82.0",
    ]);
    expect(first.include.map((entry: any) => entry.comparison_order.position)).toEqual([1, 2, 3]);
    expect(
      first.include.every((entry: any) =>
        entry.comparison_order.method === "seeded-fisher-yates"
        && entry.comparison_order.total === 3
        && /^[a-f0-9]{64}$/.test(entry.comparison_order.seed_sha256)
      ),
    ).toBe(true);
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

  it("runs a planned version through the registered TS runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "litellm-bench-cli-version-"));
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
      runner: "ubuntu-24.04",
      jobs: [{
        job_id: "sdk-import-time-1-0-0-base",
        benchmark_id: "sdk-import-time",
        benchmark_job: "base",
        runner: "ubuntu-24.04",
      }],
      needs_proxy: false,
      comparison_order: {
        method: "seeded-fisher-yates",
        position: 1,
        total: 1,
        seed_sha256: "25bf8e1a2393f1108d37029b3df5593236c755742ec93465bbafa9b290bddcf6",
      },
    };
    const logMessages: Array<string> = [];

    try {
      const response = await invokeWithRunners(
        [
          "run-version",
          "--version",
          "1.0.0",
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
      const summary = JSON.parse(
        await readFile(join(output, "version-summary.json"), "utf8"),
      );
      const report = await readFile(join(output, "version-summary.md"), "utf8");
      const stepSummary = await readFile(join(root, "step-summary.md"), "utf8");
      const spec = JSON.parse(
        await readFile(
          join(output, plan.jobs[0].job_id, "benchmark-spec.json"),
          "utf8",
        ),
      );

      expect(response).toMatchObject({ exitCode: ExitCode.Success, stdout: "completed=1\n" });
      expect(logMessages).toEqual([
        "version run started",
        "version job started",
        "benchmark started",
        "benchmark completed",
        "version job completed",
        "version run completed",
      ]);
      expect(summary).toEqual([{ job_id: plan.jobs[0].job_id, exit_code: 0 }]);
      expect(report).toContain("### LiteLLM 1.0.0: 1/1 benchmarks succeeded in ");
      expect(report).toContain("| 1 | sdk-import-time / base | ok | ");
      expect(report).toContain("| 0/0 valid | Median: 100 ms |");
      expect(stepSummary).toBe(report);
      expect(spec.case_id).toMatch(/^[a-f0-9]{64}$/);
      expect(spec.comparison_id).toMatch(/^[a-f0-9]{64}$/);
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
