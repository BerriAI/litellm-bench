import {
  decodeStrict,
  decodeUpstreamFixture,
  MockStats,
  ProxyRawObservation,
  type ProxyRawObservation as ProxyRawObservationType,
} from "@litellm-bench/contracts";
import { Clock, Context, Data, Effect, FileSystem, Layer, Path, Schema, type Scope } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  availableParallelism,
  cpus,
  freemem,
  loadavg,
  platform,
  release,
  totalmem,
  uptime,
} from "node:os";

import {
  type DockerContainer,
  DockerEngine,
  type DockerEngineShape,
  type DockerError,
} from "./docker.js";
import { K6, type K6Shape } from "./k6.js";
import {
  type K6Measurement,
  type ProxyExperiment,
  ProxyExperimentSchema,
  type ProxyTrialPlan,
  type TelemetryWindow,
} from "./models.js";

const mockAlias = "bench-upstream";

export class ProxyRuntimeError extends Data.TaggedError("ProxyRuntimeError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ProxyEnvironmentShape {
  readonly run: (
    experiment: ProxyExperiment,
  ) => Effect.Effect<ProxyRawObservationType, ProxyRuntimeError>;
}

export class ProxyEnvironment extends Context.Service<ProxyEnvironment, ProxyEnvironmentShape>()(
  "@litellm-bench/proxy/ProxyEnvironment",
) {}

export interface ProxyRuntimeOptions {
  readonly cwd?: string;
  readonly mockServerPath?: string;
  readonly networkName?: () => string;
  readonly readinessRequest?: (
    url: string,
    signal: AbortSignal,
  ) => Promise<{ readonly ok: boolean; readonly status: number }>;
  readonly proxyReadinessAttempts?: number;
  readonly proxyReadinessDelayMs?: number;
  readonly readinessRequestTimeoutMs?: number;
  readonly mockReadinessAttempts?: number;
  readonly mockReadinessDelayMs?: number;
  readonly host?: { readonly platform: string; readonly architecture: string };
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const runtimeError = (operation: string, cause: unknown) =>
  new ProxyRuntimeError({ operation, message: errorMessage(cause), cause });
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const retry = <A>(
  attempts: number,
  delayMilliseconds: number,
  operation: () => Effect.Effect<A, ProxyRuntimeError>,
): Effect.Effect<A, ProxyRuntimeError> =>
  operation().pipe(Effect.catch((error) =>
    attempts <= 1
      ? Effect.fail(error)
      : Effect.sleep(delayMilliseconds).pipe(
        Effect.andThen(retry(attempts - 1, delayMilliseconds, operation)),
      )
  ));

const validateFixture = (
  path: string,
): Effect.Effect<void, ProxyRuntimeError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    const value: unknown = yield* fs.readFileString(path).pipe(Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (cause) => runtimeError(`validate fixture ${path}`, cause),
      })
    ));
    yield* Effect.try({
      try: () => {
        decodeUpstreamFixture(value);
      },
      catch: (cause) => runtimeError(`validate fixture ${path}`, cause),
    });
  }).pipe(Effect.mapError((cause) =>
    cause instanceof ProxyRuntimeError
      ? cause
      : runtimeError(`validate fixture ${path}`, cause)
  ));

const cpuSetIds = (set: string): readonly number[] =>
  set.split(",").flatMap((part) => {
    const [startText, endText] = part.split("-");
    const start = Number(startText);
    const end = Number(endText ?? startText);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  });

export const validateExperiment = (
  experiment: ProxyExperiment,
): Effect.Effect<void, ProxyRuntimeError> => {
  try {
    Schema.decodeUnknownSync(ProxyExperimentSchema, { onExcessProperty: "error" })(experiment);
  } catch (cause) {
    return Effect.fail(
      new ProxyRuntimeError({
        operation: "validate experiment",
        message: errorMessage(cause),
        cause,
      }),
    );
  }
  if (experiment.trials.length === 0) {
    return Effect.fail(
      new ProxyRuntimeError({
        operation: "validate experiment",
        message: "experiment has no trials",
      }),
    );
  }
  const ids = experiment.trials.map(({ id }) => id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) {
    return Effect.fail(
      new ProxyRuntimeError({
        operation: "validate experiment",
        message: `duplicate trial ID: ${duplicate}`,
      }),
    );
  }
  const unsafe = ids.find((id) =>
    id.length === 0 || id === "." || id === ".."
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
  );
  if (unsafe !== undefined) {
    return Effect.fail(
      new ProxyRuntimeError({
        operation: "validate experiment",
        message: `trial ID must be a simple directory name: ${JSON.stringify(unsafe)}`,
      }),
    );
  }
  const firstPort = experiment.port ?? 4020;
  if (!Number.isSafeInteger(firstPort) || firstPort < 1 || firstPort > 65_535) {
    return Effect.fail(
      new ProxyRuntimeError({
        operation: "validate experiment",
        message: `invalid host port: ${firstPort}`,
      }),
    );
  }
  const sets = [
    experiment.resources.proxyCpuSet,
    experiment.resources.mockCpuSet,
    experiment.resources.loadGeneratorCpuSet,
  ].filter((value): value is string => value !== undefined);
  if (sets.some((set) => cpuSetIds(set).some((cpu) => cpu >= availableParallelism()))) {
    return Effect.fail(
      new ProxyRuntimeError({
        operation: "validate experiment",
        message: `configured CPU set exceeds ${availableParallelism()} available logical CPUs`,
      }),
    );
  }
  if (
    experiment.resources.proxyCpuSet !== undefined
    && experiment.resources.cpus > cpuSetIds(experiment.resources.proxyCpuSet).length
  ) {
    return Effect.fail(
      new ProxyRuntimeError({
        operation: "validate experiment",
        message: "proxy CPU quota exceeds its pinned CPU set",
      }),
    );
  }
  if (
    experiment.resources.mockCpuSet !== undefined
    && experiment.resources.mockCpus !== undefined
    && experiment.resources.mockCpus > cpuSetIds(experiment.resources.mockCpuSet).length
  ) {
    return Effect.fail(
      new ProxyRuntimeError({
        operation: "validate experiment",
        message: "mock CPU quota exceeds its pinned CPU set",
      }),
    );
  }
  return Effect.void;
};

const waitForMock = (container: DockerContainer, options: ProxyRuntimeOptions) =>
  retry(
    options.mockReadinessAttempts ?? 30,
    options.mockReadinessDelayMs ?? 200,
    () =>
      container.exec([
        "node",
        "-e",
        "require('net').connect(8080,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))",
      ], { timeoutMs: 2_000, allowFailure: true }).pipe(
        Effect.flatMap((output) =>
          output.exitCode === 0
            ? Effect.void
            : Effect.fail(new Error(`probe exited ${output.exitCode}`))
        ),
        Effect.mapError((cause) => runtimeError("wait for mock", cause)),
      ),
  );

const waitForProxy = (port: number, path: string, options: ProxyRuntimeOptions) => {
  const request = options.readinessRequest
    ?? ((url: string, signal: AbortSignal) => fetch(url, { signal }));
  return retry(
    options.proxyReadinessAttempts ?? 90,
    options.proxyReadinessDelayMs ?? 1_000,
    () =>
      Effect.tryPromise({
        try: async () => {
          const response = await request(
            `http://127.0.0.1:${port}${path}`,
            AbortSignal.timeout(options.readinessRequestTimeoutMs ?? 1_000),
          );
          if (!response.ok) throw new Error(`readiness returned ${response.status}`);
        },
        catch: (cause) => runtimeError("wait for proxy", cause),
      }),
  );
};

export const parseCgroupValue = (
  output: string,
  filename: string,
  field?: string,
): Effect.Effect<number, ProxyRuntimeError> => {
  const value = field === undefined
    ? output.trim()
    : Object.fromEntries(
      output.trim().split("\n").map((line) => line.trim().split(/\s+/, 2)),
    )[field];
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Effect.succeed(parsed)
    : Effect.fail(
      new ProxyRuntimeError({
        operation: "read cgroup",
        message: `invalid cgroup value for ${filename}${field === undefined ? "" : `.${field}`}`,
      }),
    );
};

const dockerText = (container: DockerContainer, filename: string) =>
  container.exec(["cat", `/sys/fs/cgroup/${filename}`], { timeoutMs: 5_000 }).pipe(
    Effect.mapError((cause) => runtimeError(`read cgroup ${filename}`, cause)),
    Effect.map(({ stdout }) => stdout.trim()),
  );
const dockerStat = (container: DockerContainer, filename: string, field?: string) =>
  dockerText(container, filename).pipe(
    Effect.flatMap((output) => parseCgroupValue(output, filename, field)),
  );

interface CgroupSnapshot {
  readonly memory: number;
  readonly anon: number;
  readonly usage: number;
  readonly nrPeriods: number;
  readonly nrThrottled: number;
  readonly throttledUsec: number;
  readonly cpuMax: string;
  readonly cpuSet: string;
}

const cgroupSnapshot = (
  container: DockerContainer,
): Effect.Effect<CgroupSnapshot, ProxyRuntimeError> =>
  Effect.all({
    memory: dockerStat(container, "memory.current"),
    anon: dockerStat(container, "memory.stat", "anon"),
    usage: dockerStat(container, "cpu.stat", "usage_usec"),
    nrPeriods: dockerStat(container, "cpu.stat", "nr_periods"),
    nrThrottled: dockerStat(container, "cpu.stat", "nr_throttled"),
    throttledUsec: dockerStat(container, "cpu.stat", "throttled_usec"),
    cpuMax: dockerText(container, "cpu.max"),
    cpuSet: dockerText(container, "cpuset.cpus.effective"),
  }, { concurrency: "unbounded" });

const isolatedWindow: TelemetryWindow =
  "post-warmup measurement process and drain; memory.peak spans the container lifetime because Docker mounts the container cgroup read-only";

const containerTelemetry = (
  container: DockerContainer,
  imageId: string,
  before: CgroupSnapshot,
  after: CgroupSnapshot,
  wallSeconds: number,
  window: TelemetryWindow = "k6 process: warmup, fixed measurement window, and drain",
) =>
  Effect.gen(function*() {
    return {
      image_id: imageId,
      baseline_memory_bytes: before.memory,
      baseline_anon_bytes: before.anon,
      peak_memory_bytes: yield* dockerStat(container, "memory.peak"),
      loaded_memory_bytes: after.memory,
      loaded_anon_bytes: after.anon,
      idle_memory_bytes: yield* dockerStat(container, "memory.current"),
      idle_anon_bytes: yield* dockerStat(container, "memory.stat", "anon"),
      cpu_before_usec: before.usage,
      cpu_after_usec: after.usage,
      cpu_nr_periods_before: before.nrPeriods,
      cpu_nr_periods_after: after.nrPeriods,
      cpu_nr_throttled_before: before.nrThrottled,
      cpu_nr_throttled_after: after.nrThrottled,
      cpu_throttled_usec_before: before.throttledUsec,
      cpu_throttled_usec_after: after.throttledUsec,
      cpu_max: before.cpuMax,
      cpuset_cpus_effective: before.cpuSet,
      wall_seconds: wallSeconds,
      window,
    };
  });

const mockStats = (container: DockerContainer) =>
  container.exec([
    "node",
    "-e",
    "fetch('http://127.0.0.1:8080/__stats').then(r=>r.text()).then(console.log)",
  ], { timeoutMs: 5_000 }).pipe(
    Effect.mapError((cause) => runtimeError("read mock stats", cause)),
    Effect.flatMap(({ stdout }) =>
      Effect.try({
        try: () => decodeStrict(MockStats)(JSON.parse(stdout) as unknown),
        catch: (cause) => runtimeError("parse mock stats", cause),
      })
    ),
  );

const startMock = (
  path: Path.Path,
  docker: DockerEngineShape,
  experiment: ProxyExperiment,
  trial: ProxyTrialPlan,
  imageId: string,
  network: string,
  name: string,
  directory: string,
  mockServerPath: string,
  port: number,
): Effect.Effect<DockerContainer, DockerError, Scope.Scope> =>
  docker.container({
    name,
    network,
    networkAliases: [mockAlias],
    image: imageId,
    ...(experiment.resources.mockCpus === undefined ? {} : { cpus: experiment.resources.mockCpus }),
    ...(experiment.resources.mockCpuSet === undefined
      ? {}
      : { cpuSet: experiment.resources.mockCpuSet }),
    ...(experiment.resources.mockMemory === undefined
      ? {}
      : { memory: experiment.resources.mockMemory }),
    logDriver: experiment.resources.logDriver,
    ...(trial.bypassProxy === true ? { ports: [{ hostPort: port, containerPort: 8080 }] } : {}),
    environment: {
      MOCK_FIXTURE: "/fixture.json",
      ...(trial.mockEnvironment ?? {}),
    },
    mounts: [
      { source: path.dirname(mockServerPath), target: "/app", readOnly: true },
      { source: path.resolve(trial.fixturePath), target: "/fixture.json", readOnly: true },
    ],
    command: ["node", `/app/${path.basename(mockServerPath)}`],
    logPath: path.join(directory, "mock.log"),
  });

const startProxy = (
  path: Path.Path,
  docker: DockerEngineShape,
  experiment: ProxyExperiment,
  trial: ProxyTrialPlan,
  imageId: string,
  network: string,
  name: string,
  port: number,
  directory: string,
): Effect.Effect<DockerContainer, DockerError, Scope.Scope> =>
  docker.container({
    name,
    network,
    image: imageId,
    cpus: experiment.resources.cpus,
    ...(experiment.resources.proxyCpuSet === undefined
      ? {}
      : { cpuSet: experiment.resources.proxyCpuSet }),
    memory: experiment.resources.memory,
    logDriver: experiment.resources.logDriver,
    ports: [{ hostPort: port, containerPort: 4000 }],
    environment: {
      ...(trial.environment ?? {}),
      LITELLM_BENCH_UPSTREAM_API_BASE: `http://${mockAlias}:8080/v1`,
    },
    mounts: [{
      source: path.resolve(trial.proxyConfigPath),
      target: "/app/config.yaml",
      readOnly: true,
    }],
    command: [
      "--config",
      "/app/config.yaml",
      "--port",
      "4000",
      "--num_workers",
      String(experiment.resources.workers),
    ],
    logPath: path.join(directory, "proxy.log"),
  });

const preflightKey = (trial: ProxyTrialPlan): string =>
  sha256(JSON.stringify({
    proxy_config: sha256(readFileSync(trial.proxyConfigPath)),
    fixture: sha256(readFileSync(trial.fixturePath)),
    request: trial.workload.request,
    response: trial.workload.response,
    payload: sha256(trial.workload.body),
    environment: trial.environment ?? {},
    mock_environment: trial.mockEnvironment ?? {},
  }));

const distinctPreflightTrials = (trials: readonly ProxyTrialPlan[]): readonly ProxyTrialPlan[] => {
  const keys = new Set<string>();
  return trials.filter((trial) => {
    if (trial.bypassProxy === true) return false;
    const key = preflightKey(trial);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
};

const preflightIssue = (
  client: K6Measurement,
  upstream: typeof MockStats.Type,
): string | undefined => {
  const result = client.result;
  if (client.exitCode !== 0) return client.error ?? `k6 exited ${client.exitCode}`;
  if (result === undefined) return client.error ?? "missing k6 result";
  if (result.started < 1) return "probe sent no requests";
  if (upstream.failures !== 0) {
    return `upstream rejected ${upstream.failures} request(s): ${
      JSON.stringify(upstream.last_mismatch ?? upstream.errors)
    }`;
  }
  if (result.failed !== 0 || result.dropped !== 0 || result.interrupted !== 0) {
    return `probe observed failed=${result.failed}, dropped=${result.dropped}, interrupted=${result.interrupted}, errors=${
      JSON.stringify(result.errors)
    }`;
  }
  if (upstream.requests !== result.started) {
    return `request-count mismatch: proxy started ${result.started}, upstream received ${upstream.requests}`;
  }
  const streams = upstream.streams;
  if (
    streams !== undefined && (
      streams.failed !== 0 || streams.cancelled !== 0 || streams.started !== streams.completed
    )
  ) {
    return `upstream streams failed, cancelled, or incomplete: ${JSON.stringify(streams)}`;
  }
  return undefined;
};

const preflightTrial = (
  docker: DockerEngineShape,
  k6: K6Shape,
  k6Version: string,
  experiment: ProxyExperiment,
  trial: ProxyTrialPlan,
  network: string,
  position: number,
  options: ProxyRuntimeOptions,
  proxyImageId: string,
  mockImageId: string,
) =>
  Effect.scoped(Effect.gen(function*() {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const directory = path.join(experiment.artifactsDirectory, "preflight", trial.id);
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(
      Effect.mapError((cause) => runtimeError("create preflight artifacts", cause)),
    );
    yield* validateFixture(trial.fixturePath);
    const readableExperiment: ProxyExperiment = {
      ...experiment,
      resources: { ...experiment.resources, logDriver: "local", idleSeconds: 0 },
    };
    const suffix = `${network}-preflight-${position}`;
    const port = experiment.port ?? 4020;
    const mock = yield* startMock(
      path,
      docker,
      readableExperiment,
      trial,
      mockImageId,
      network,
      `${suffix}-mock`,
      directory,
      options.mockServerPath ?? path.resolve("apps/mock-provider/dist/main.js"),
      port,
    );
    yield* waitForMock(mock, options);
    yield* startProxy(
      path,
      docker,
      readableExperiment,
      trial,
      proxyImageId,
      network,
      `${suffix}-proxy`,
      port,
      directory,
    );
    yield* waitForProxy(port, experiment.readinessPath ?? "/health/liveliness", options);
    const client = yield* k6.run({
      workload: trial.workload,
      load: { mode: "closed", concurrency: 1, duration_seconds: 1, warmup_seconds: 0 },
      url: `http://127.0.0.1:${port}`,
      artifactsDirectory: path.join(directory, "client"),
      cwd: options.cwd ?? process.cwd(),
      ...(experiment.resources.loadGeneratorCpuSet === undefined
        ? {}
        : { cpuSet: experiment.resources.loadGeneratorCpuSet }),
    }, k6Version).pipe(Effect.mapError((cause) => runtimeError("run preflight probe", cause)));
    const upstream = yield* mockStats(mock);
    const issue = preflightIssue(client, upstream);
    if (issue !== undefined) {
      return yield* new ProxyRuntimeError({
        operation: `preflight ${trial.id}`,
        message: `${issue}; diagnostics: ${directory}`,
      });
    }
  }));

const retainPlan = (trial: ProxyTrialPlan, directory: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(directory, { recursive: true });
    const [proxyConfig, fixture] = yield* Effect.all([
      fs.readFile(trial.proxyConfigPath),
      fs.readFile(trial.fixturePath),
    ], { concurrency: "unbounded" });
    yield* Effect.all([
      fs.copyFile(trial.proxyConfigPath, path.join(directory, "proxy_config.yaml")),
      fs.copyFile(trial.fixturePath, path.join(directory, "upstream-fixture.json")),
      fs.writeFileString(
        path.join(directory, "plan.json"),
        `${
          JSON.stringify(
            {
              id: trial.id,
              scenario: trial.scenario,
              variant: trial.variant,
              round: trial.round,
              load: trial.load,
              environment: trial.environment ?? {},
              dimensions: trial.dimensions,
              mock_image: trial.mockImage,
              mock_environment: trial.mockEnvironment ?? {},
              bypass_proxy: trial.bypassProxy ?? false,
              hashes: {
                proxy_config_sha256: sha256(proxyConfig),
                upstream_fixture_sha256: sha256(fixture),
                payload_sha256: sha256(trial.workload.body),
              },
            },
            null,
            2,
          )
        }\n`,
      ),
    ], { concurrency: "unbounded", discard: true });
  }).pipe(Effect.mapError((cause) => runtimeError("retain trial plan", cause)));

const measureTrial = (
  docker: DockerEngineShape,
  k6: K6Shape,
  k6Version: string,
  experiment: ProxyExperiment,
  trial: ProxyTrialPlan,
  network: string,
  position: number,
  options: ProxyRuntimeOptions,
  proxyImageId: string,
  mockImageId: string,
) => {
  const suffix = `${network}-${position}`;
  const port = experiment.port ?? 4020;
  const base = {
    id: trial.id,
    scenario: trial.scenario,
    variant: trial.variant,
    round: trial.round,
    load: trial.load,
    dimensions: trial.dimensions,
  };
  return Effect.scoped(Effect.gen(function*() {
    const path = yield* Path.Path;
    const directory = path.join(experiment.artifactsDirectory, trial.id);
    yield* retainPlan(trial, directory);
    yield* validateFixture(trial.fixturePath);
    const mock = yield* startMock(
      path,
      docker,
      experiment,
      trial,
      mockImageId,
      network,
      `${suffix}-mock`,
      directory,
      options.mockServerPath ?? path.resolve("apps/mock-provider/dist/main.js"),
      port,
    );
    yield* waitForMock(mock, options);
    let proxy: DockerContainer | undefined;
    if (trial.bypassProxy !== true) {
      proxy = yield* startProxy(
        path,
        docker,
        experiment,
        trial,
        proxyImageId,
        network,
        `${suffix}-proxy`,
        port,
        directory,
      );
      yield* waitForProxy(port, experiment.readinessPath ?? "/health/liveliness", options);
    }
    const runLoad = (load: ProxyTrialPlan["load"], artifactsDirectory: string) =>
      k6.run({
        workload: trial.workload,
        load,
        url: `http://127.0.0.1:${port}`,
        artifactsDirectory,
        cwd: options.cwd ?? process.cwd(),
        ...(experiment.resources.loadGeneratorCpuSet === undefined
          ? {}
          : { cpuSet: experiment.resources.loadGeneratorCpuSet }),
      }, k6Version).pipe(Effect.mapError((cause) => runtimeError("run k6", cause)));
    const isolated = trial.isolateMeasurementWindow === true && trial.load.warmup_seconds > 0;
    const warmup = isolated
      ? yield* runLoad(
        {
          ...trial.load,
          duration_seconds: trial.load.warmup_seconds,
          warmup_seconds: 0,
        },
        path.join(directory, "warmup"),
      )
      : undefined;
    if (warmup !== undefined && (warmup.exitCode !== 0 || warmup.result === undefined)) {
      return yield* new ProxyRuntimeError({
        operation: "warm up proxy",
        message: warmup.error ?? `k6 exited ${warmup.exitCode}`,
      });
    }
    const mockBefore = yield* cgroupSnapshot(mock);
    const proxyBefore = proxy === undefined ? undefined : yield* cgroupSnapshot(proxy);
    const started = yield* Clock.currentTimeNanos;
    const client = yield* runLoad(
      isolated ? { ...trial.load, warmup_seconds: 0 } : trial.load,
      directory,
    );
    const wallSeconds = Number((yield* Clock.currentTimeNanos) - started) / 1_000_000_000;
    const mockAfter = yield* cgroupSnapshot(mock);
    const proxyAfter = proxy === undefined ? undefined : yield* cgroupSnapshot(proxy);
    yield* Effect.sleep(experiment.resources.idleSeconds * 1_000);
    const upstream = yield* mockStats(mock);
    const mockTelemetry = yield* containerTelemetry(
      mock,
      mockImageId,
      mockBefore,
      mockAfter,
      wallSeconds,
      isolated ? isolatedWindow : undefined,
    );
    const proxyTelemetry =
      proxy === undefined || proxyBefore === undefined || proxyAfter === undefined
        ? undefined
        : yield* containerTelemetry(
          proxy,
          proxyImageId,
          proxyBefore,
          proxyAfter,
          wallSeconds,
          isolated ? isolatedWindow : undefined,
        );
    const result = client.result === undefined
      ? undefined
      : warmup?.result === undefined
      ? client.result
      : {
        ...client.result,
        warmup_requests: warmup.result.started,
        warmup_failed: warmup.result.failed + warmup.result.dropped + warmup.result.interrupted,
      };
    return {
      ...base,
      client: {
        engine: client.engine,
        exit_code: client.exitCode,
        ...(result === undefined ? {} : { result }),
        ...(client.error === undefined ? {} : { error: client.error }),
        artifacts: client.artifacts,
      },
      ...(proxyTelemetry === undefined ? {} : { telemetry: proxyTelemetry }),
      mock_telemetry: mockTelemetry,
      ...(client.telemetry === undefined
        ? {}
        : {
          load_generator_telemetry: {
            cpu_percent: client.telemetry.cpuPercent,
            user_seconds: client.telemetry.userSeconds,
            system_seconds: client.telemetry.systemSeconds,
            max_rss_kib: client.telemetry.maxRssKib,
            ...(client.telemetry.cpuSet === undefined
              ? {}
              : { cpuset_cpus: client.telemetry.cpuSet }),
          },
        }),
      upstream,
    };
  })).pipe(Effect.catch((error) => Effect.succeed({ ...base, error: error.message })));
};

const trialOutcomeAnnotations = (measured: {
  readonly error?: string;
  readonly client?: {
    readonly exit_code: number;
    readonly error?: string;
    readonly result?: {
      readonly completed: number;
      readonly failed: number;
      readonly dropped: number;
      readonly error_rate: number;
      readonly completion_rps: number;
      readonly latency?: { readonly p50_ms: number; readonly p95_ms: number };
    };
  };
}): Record<string, unknown> => {
  if (measured.client === undefined) return {};
  const { exit_code, error, result } = measured.client;
  return {
    exit_code,
    ...(error === undefined ? {} : { client_error: error }),
    ...(result === undefined ? {} : {
      completed: result.completed,
      failed: result.failed + result.dropped,
      error_rate: Number(result.error_rate.toFixed(4)),
      completion_rps: Number(result.completion_rps.toFixed(2)),
      ...(result.latency === undefined ? {} : {
        p50_ms: Math.round(result.latency.p50_ms),
        p95_ms: Math.round(result.latency.p95_ms),
      }),
    }),
  };
};

const optionalFile = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
};
const hostPressure = () => {
  const cpuPressure = optionalFile("/proc/pressure/cpu");
  const memoryPressure = optionalFile("/proc/pressure/memory");
  const ioPressure = optionalFile("/proc/pressure/io");
  const procStat = optionalFile("/proc/stat");
  return {
    load_average: loadavg(),
    free_memory_bytes: freemem(),
    total_memory_bytes: totalmem(),
    uptime_seconds: uptime(),
    ...(cpuPressure === undefined ? {} : { cpu_pressure: cpuPressure }),
    ...(memoryPressure === undefined ? {} : { memory_pressure: memoryPressure }),
    ...(ioPressure === undefined ? {} : { io_pressure: ioPressure }),
    ...(procStat === undefined ? {} : { proc_stat: procStat }),
  };
};

const hostCpuPercent = (before?: string, after?: string): number | undefined => {
  const values = (text?: string) => text?.split("\n")[0]?.trim().split(/\s+/).slice(1).map(Number);
  const left = values(before);
  const right = values(after);
  if (
    left === undefined || right === undefined || left.length < 5 || right.length !== left.length
  ) return undefined;
  const totalBefore = left.reduce((sum, value) => sum + value, 0);
  const totalAfter = right.reduce((sum, value) => sum + value, 0);
  const idleBefore = left[3]! + (left[4] ?? 0);
  const idleAfter = right[3]! + (right[4] ?? 0);
  const totalDelta = totalAfter - totalBefore;
  return totalDelta <= 0 ? undefined : (1 - (idleAfter - idleBefore) / totalDelta) * 100;
};

export const runProxyExperiment = (
  docker: DockerEngineShape,
  k6: K6Shape,
  experiment: ProxyExperiment,
  options: ProxyRuntimeOptions = {},
): Effect.Effect<
  ProxyRawObservationType,
  ProxyRuntimeError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* validateExperiment(experiment);
    const executionPlatform = options.host?.platform ?? process.platform;
    if (
      executionPlatform !== "linux"
      && (
        experiment.resources.proxyCpuSet !== undefined
        || experiment.resources.mockCpuSet !== undefined
        || experiment.resources.loadGeneratorCpuSet !== undefined
      )
    ) {
      return yield* new ProxyRuntimeError({
        operation: "validate experiment",
        message: `CPU-pinned proxy experiments require a Linux host; found ${executionPlatform}`,
      });
    }
    const dockerMetadata = yield* docker.verify.pipe(
      Effect.mapError((cause) => runtimeError("verify Docker", cause)),
    );
    const k6Version = yield* k6.verify.pipe(
      Effect.mapError((cause) => runtimeError("verify k6", cause)),
    );
    const proxyImageId = yield* docker.inspectImage(experiment.image).pipe(
      Effect.mapError((cause) => runtimeError("resolve immutable proxy image", cause)),
    );
    const mockImages = new Map<string, string>();
    for (const image of new Set(experiment.trials.map(({ mockImage }) => mockImage))) {
      mockImages.set(
        image,
        yield* docker.inspectImage(image).pipe(
          Effect.mapError((cause) => runtimeError("resolve immutable mock image", cause)),
        ),
      );
    }
    yield* fs.makeDirectory(experiment.artifactsDirectory, { recursive: true }).pipe(
      Effect.andThen(
        fs.writeFileString(path.join(experiment.artifactsDirectory, "trials.jsonl"), ""),
      ),
      Effect.mapError((cause) => runtimeError("create experiment artifacts", cause)),
    );
    const network = yield* docker.network(
      options.networkName?.() ?? `litellm-bench-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    ).pipe(Effect.mapError((cause) => runtimeError("create Docker network", cause)));
    const preflights = distinctPreflightTrials(experiment.trials);
    yield* Effect.logInfo("proxy contract preflight started").pipe(Effect.annotateLogs({
      contracts: preflights.length,
    }));
    yield* Effect.forEach(
      preflights,
      (trial, index) =>
        preflightTrial(
          docker,
          k6,
          k6Version,
          experiment,
          trial,
          network,
          index,
          options,
          proxyImageId,
          mockImages.get(trial.mockImage)!,
        ),
      { concurrency: 1, discard: true },
    );
    yield* Effect.logInfo("proxy contract preflight completed").pipe(Effect.annotateLogs({
      contracts: preflights.length,
    }));
    const pressureBefore = hostPressure();
    const experimentStartedAt = Date.now();
    const trials = yield* Effect.forEach(
      experiment.trials,
      (trial, index) =>
        Effect.gen(function*() {
          const startedAt = Date.now();
          yield* Effect.logInfo("proxy trial started");
          const measured = yield* measureTrial(
            docker,
            k6,
            k6Version,
            experiment,
            trial,
            network,
            index,
            options,
            proxyImageId,
            mockImages.get(trial.mockImage)!,
          );
          yield* fs.writeFileString(
            path.join(experiment.artifactsDirectory, "trials.jsonl"),
            `${JSON.stringify(measured)}\n`,
            { flag: "a" },
          ).pipe(Effect.mapError((cause) => runtimeError("record trial", cause)));
          const now = Date.now();
          const remaining = experiment.trials.length - index - 1;
          const averageMs = (now - experimentStartedAt) / (index + 1);
          const failure = "error" in measured ? measured.error : undefined;
          yield* (failure === undefined
            ? Effect.logInfo("proxy trial completed")
            : Effect.logWarning(`proxy trial failed: ${failure}`)).pipe(
              Effect.annotateLogs({
                trial_seconds: Math.round((now - startedAt) / 1000),
                remaining_trials: remaining,
                estimated_remaining_seconds: Math.round(remaining * averageMs / 1000),
                ...trialOutcomeAnnotations(measured),
              }),
            );
          return measured;
        }).pipe(Effect.annotateLogs({
          trial: index + 1,
          trials: experiment.trials.length,
          trial_id: trial.id,
          round: trial.round,
          scenario: trial.scenario,
          variant: trial.variant,
          load: trial.load.mode === "fixed"
            ? `${trial.load.rate} rps`
            : `${trial.load.concurrency} vus`,
          measurement_seconds: trial.load.duration_seconds,
          warmup_seconds: trial.load.warmup_seconds,
        })),
      { concurrency: 1 },
    );
    const processor = cpus();
    const pressureAfter = hostPressure();
    const hostUtilization = hostCpuPercent(pressureBefore.proc_stat, pressureAfter.proc_stat);
    const raw = yield* Effect.try({
      try: () =>
        decodeStrict(ProxyRawObservation)({
          trials,
          metadata: {
            host: {
              ...(options.host ?? { platform: process.platform, architecture: process.arch }),
              kernel: { platform: platform(), release: release() },
              cpu_topology: {
                logical_cpus: processor.length,
                models: [...new Set(processor.map(({ model }) => model))],
                speeds_mhz: [...new Set(processor.map(({ speed }) => speed))],
              },
              cpu_governor: optionalFile("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor")
                ?? "unavailable",
              pressure_before: pressureBefore,
              pressure_after: pressureAfter,
              ...(hostUtilization === undefined
                ? {}
                : { cpu_utilization_percent: hostUtilization }),
            },
            runner_image: {
              os: process.env.ImageOS ?? "local",
              version: process.env.ImageVersion ?? "unknown",
              name: process.env.RUNNER_NAME ?? "local",
            },
            repository: {
              commit: process.env.GITHUB_SHA ?? process.env.LITELLM_BENCH_REPO_COMMIT
                ?? "unavailable-local-worktree",
            },
            docker: {
              version: dockerMetadata.version,
              os: dockerMetadata.os,
              architecture: dockerMetadata.architecture,
              cgroup_version: dockerMetadata.cgroupVersion,
            },
            load_generator: {
              version: k6Version,
              cpuset_cpus: experiment.resources.loadGeneratorCpuSet ?? "unrestricted",
            },
            images: {
              proxy: { requested: experiment.image, effective_id: proxyImageId },
              mock: {
                requested: experiment.trials[0]!.mockImage,
                effective_id: mockImages.get(experiment.trials[0]!.mockImage)!,
              },
            },
            resources: experiment.resources,
            hashes: {
              trial_plans_sha256: sha256(
                experiment.trials.map((trial) =>
                  JSON.stringify({
                    id: trial.id,
                    load: trial.load,
                    dimensions: trial.dimensions,
                    mock_environment: trial.mockEnvironment ?? {},
                    payload_sha256: sha256(trial.workload.body),
                    config_sha256: sha256(readFileSync(trial.proxyConfigPath)),
                    fixture_sha256: sha256(readFileSync(trial.fixturePath)),
                  })
                ).join("\n"),
              ),
            },
          },
        }),
      catch: (cause) => runtimeError("validate proxy observation", cause),
    });
    yield* fs.writeFileString(
      path.join(experiment.artifactsDirectory, "metadata.json"),
      `${JSON.stringify(raw.metadata, null, 2)}\n`,
    ).pipe(Effect.mapError((cause) => runtimeError("record experiment metadata", cause)));
    return raw;
  })).pipe(Effect.mapError((cause) =>
    cause instanceof ProxyRuntimeError
      ? cause
      : runtimeError("run proxy experiment", cause)
  ));

export const ProxyEnvironmentLive = Layer.effect(
  ProxyEnvironment,
  Effect.gen(function*() {
    const docker = yield* DockerEngine;
    const k6 = yield* K6;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = process.cwd();
    const host = { platform: process.platform, architecture: process.arch };
    const mockServerPath = path.resolve(
      process.env.LITELLM_BENCH_MOCK_PROVIDER ?? "apps/mock-provider/dist/main.js",
    );
    return {
      run: (experiment: ProxyExperiment) =>
        runProxyExperiment(docker, k6, experiment, { cwd, mockServerPath, host }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
    };
  }),
);
