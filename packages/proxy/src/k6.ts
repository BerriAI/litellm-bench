import {
  decodeStrict,
  ProxyLoadObservation,
  validateProxyLoadObservation,
} from "@litellm-bench/contracts";
import {
  type CommandOutput,
  type ProcessError,
  ProcessExecutor,
  ProcessFailure,
} from "@litellm-bench/harness";
import { Context, Data, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type K6Artifacts,
  type K6Measurement,
  type K6Run,
  K6WorkloadDefinition,
} from "./models.js";

export const K6_VERSION = "2.2.0";
const timeMarker = "LITELLM_BENCH_TIME";
const loadScriptUrl = new URL("./assets/load.js", import.meta.url);
const responseScriptUrl = new URL("./assets/response.js", import.meta.url);

export class K6Error extends Data.TaggedError("K6Error")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface K6Shape {
  readonly verify: Effect.Effect<string, K6Error | ProcessError>;
  readonly run: (
    run: K6Run,
    verifiedVersion: string,
  ) => Effect.Effect<K6Measurement, K6Error | ProcessError>;
}

export class K6 extends Context.Service<K6, K6Shape>()("@litellm-bench/proxy/K6") {}

const commandOutput = (
  effect: Effect.Effect<CommandOutput, ProcessError>,
): Effect.Effect<CommandOutput, Exclude<ProcessError, ProcessFailure>> =>
  Effect.catchTag(effect, "ProcessFailure", (error) => Effect.succeed(error.output));

export const verifyK6 = (cwd: string) =>
  Effect.gen(function*() {
    const executor = yield* ProcessExecutor;
    const output = yield* executor.execute({
      executable: "k6",
      args: ["version"],
      cwd,
      timeoutMs: 30_000,
    });
    const version = output.stdout.trim();
    if (!version.startsWith(`k6 v${K6_VERSION} `)) {
      return yield* new K6Error({ message: `expected k6 ${K6_VERSION}, found ${version}` });
    }
    return version;
  });

const gcd = (left: number, right: number): number => right === 0 ? left : gcd(right, left % right);

export const rateParts = (rate: number): readonly [number, string] => {
  const value = String(rate);
  if (!value.includes(".")) return [rate, "1s"];
  const [whole, fraction] = value.split(".") as [string, string];
  const denominator = 10 ** fraction.length;
  const numerator = Number(`${whole}${fraction}`);
  const divisor = gcd(numerator, denominator);
  return [numerator / divisor, `${denominator / divisor}s`];
};

const writeArtifacts = (run: K6Run) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.resolve(run.artifactsDirectory);
    yield* fs.makeDirectory(directory, { recursive: true });
    const payload = path.join(directory, "body.bin");
    const configuration = path.join(directory, "config.json");
    const summary = path.join(directory, "k6-summary.json");
    const engine = path.join(directory, "load.js");
    const response = path.join(directory, "response.js");
    const entry = path.join(directory, "entry.js");
    const [arrivalRate, arrivalTimeUnit] = run.load.mode === "fixed"
      ? rateParts(run.load.rate)
      : [1, "1s"] as const;
    yield* fs.writeFile(payload, run.workload.body);
    yield* Effect.all([
      fs.copyFile(fileURLToPath(loadScriptUrl), engine),
      fs.copyFile(fileURLToPath(responseScriptUrl), response),
    ], { concurrency: "unbounded", discard: true });
    yield* fs.writeFileString(
      configuration,
      JSON.stringify({
        url: run.url,
        payload_path: payload,
        payload_sha256: createHash("sha256").update(run.workload.body).digest("hex"),
        load: run.load,
        workload: {
          request: run.workload.request,
          response: run.workload.response,
        },
        arrival_rate: arrivalRate,
        arrival_time_unit: arrivalTimeUnit,
        summary_path: summary,
      }),
    );
    yield* fs.writeFileString(
      entry,
      `import { createTest } from ${JSON.stringify(engine)};\n`
        + "const test = createTest();\n"
        + "export const options = test.options;\n"
        + "export const setup = test.setup;\n"
        + "export default test.run;\n"
        + "export const handleSummary = test.handleSummary;\n",
    );
    return {
      artifacts: {
        result: path.join(directory, "client.json"),
        log: path.join(directory, "client.log"),
        summary,
        configuration,
        payload,
      } satisfies K6Artifacts,
      entry,
      configuration,
    };
  }).pipe(Effect.mapError((cause) =>
    new K6Error({ message: `could not prepare k6 artifacts: ${String(cause)}`, cause })
  ));

const parseResult = (stdout: string) => {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const normalized = parsed.latency === null
      ? Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "latency"))
      : parsed;
    const result = decodeStrict(ProxyLoadObservation)(normalized);
    if (!validateProxyLoadObservation(result)) {
      throw new Error("inconsistent request or latency counts");
    }
    return { result } as const;
  } catch (cause) {
    return { error: String(cause) } as const;
  }
};

export const parseTimeTelemetry = (stderr: string, cpuSet?: string) => {
  const match = stderr.match(
    new RegExp(
      `${timeMarker} cpu_percent=([0-9.]+)% user_seconds=([0-9.]+) system_seconds=([0-9.]+) max_rss_kib=([0-9]+)`,
    ),
  );
  if (match === null) return undefined;
  return {
    cpuPercent: Number(match[1]),
    userSeconds: Number(match[2]),
    systemSeconds: Number(match[3]),
    maxRssKib: Number(match[4]),
    ...(cpuSet === undefined ? {} : { cpuSet }),
  };
};

export const runK6 = (
  run: K6Run,
  verifiedVersion?: string,
): Effect.Effect<
  K6Measurement,
  K6Error | ProcessError,
  ProcessExecutor | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    yield* Schema.decodeUnknownEffect(K6WorkloadDefinition, { onExcessProperty: "error" })({
      request: run.workload.request,
      response: run.workload.response,
    }).pipe(Effect.mapError((cause) =>
      new K6Error({
        message: `invalid k6 workload: ${String(cause)}`,
        cause,
      })
    ));
    const engine = verifiedVersion ?? (yield* verifyK6(run.cwd));
    const prepared = yield* writeArtifacts(run);
    const executor = yield* ProcessExecutor;
    const k6Args = [
      "run",
      "--quiet",
      "--no-usage-report",
      "--new-machine-readable-summary=false",
      "--env",
      `BENCH_CONFIG=${prepared.configuration}`,
      prepared.entry,
    ];
    const command = run.cpuSet === undefined
      ? { executable: "k6", args: k6Args }
      : {
        executable: "/usr/bin/time",
        args: [
          "-f",
          `${timeMarker} cpu_percent=%P user_seconds=%U system_seconds=%S max_rss_kib=%M`,
          "taskset",
          "-c",
          run.cpuSet,
          "k6",
          ...k6Args,
        ],
      };
    const output = yield* commandOutput(executor.execute({
      ...command,
      cwd: run.cwd,
      timeoutMs: Math.ceil(
        (run.load.warmup_seconds + run.load.duration_seconds) * 1_000 + 120_000,
      ),
    }));
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.all([
      fs.writeFileString(prepared.artifacts.result, output.stdout),
      fs.writeFileString(prepared.artifacts.log, output.stderr),
    ], { concurrency: "unbounded", discard: true }).pipe(
      Effect.mapError((cause) =>
        new K6Error({ message: `could not retain k6 output: ${String(cause)}`, cause })
      ),
    );
    const parsed = parseResult(output.stdout);
    const telemetry = parseTimeTelemetry(output.stderr, run.cpuSet);
    return {
      engine,
      exitCode: output.exitCode,
      ...("result" in parsed ? { result: parsed.result } : { error: parsed.error }),
      ...(output.exitCode === 0 || "error" in parsed
        ? {}
        : { error: `k6 exited ${output.exitCode}` }),
      artifacts: prepared.artifacts,
      ...(telemetry === undefined ? {} : { telemetry }),
    };
  });

export const K6Live = Layer.effect(
  K6,
  Effect.gen(function*() {
    const executor = yield* ProcessExecutor;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = process.cwd();
    return {
      verify: verifyK6(cwd).pipe(Effect.provideService(ProcessExecutor, executor)),
      run: (run: K6Run, verifiedVersion: string) =>
        runK6(run, verifiedVersion).pipe(
          Effect.provideService(ProcessExecutor, executor),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
    };
  }),
);
