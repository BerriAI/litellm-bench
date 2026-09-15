import { ProxyLoad, type ProxyLoadObservation } from "@litellm-bench/contracts/proxy";
import { Schema } from "effect";

const HttpStatus = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
);
const PathSegment = Schema.Union([
  Schema.String,
  Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
]);
const JsonCheck = Schema.Struct({
  path: Schema.Array(PathSegment),
  value: Schema.Json,
});
const Positive = Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0)));
const PositiveInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)));

export const K6WorkloadDefinition = Schema.Struct({
  request: Schema.Struct({
    method: Schema.NonEmptyString,
    path: Schema.String.pipe(Schema.check(Schema.isPattern(/^\//))),
    headers: Schema.Record(Schema.String, Schema.String),
  }),
  response: Schema.Struct({
    status: HttpStatus,
    jsonEquals: Schema.Array(JsonCheck),
    sse: Schema.optionalKey(Schema.Struct({
      event_count: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
      terminal_data: Schema.optionalKey(Schema.Json),
      jsonEquals: Schema.Array(Schema.Struct({
        index: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
        ...JsonCheck.fields,
      })),
    })),
  }),
}).annotate({ identifier: "K6WorkloadDefinition" });

export type K6WorkloadDefinition = typeof K6WorkloadDefinition.Type;

export interface K6Workload extends K6WorkloadDefinition {
  readonly body: Uint8Array;
}

export interface K6Run {
  readonly workload: K6Workload;
  readonly load: ProxyLoad;
  readonly url: string;
  readonly artifactsDirectory: string;
  readonly cwd: string;
  readonly cpuSet?: string;
}

export interface K6Artifacts {
  readonly result: string;
  readonly log: string;
  readonly summary: string;
  readonly configuration: string;
  readonly payload: string;
}

export interface K6Measurement {
  readonly engine: string;
  readonly exitCode: number;
  readonly result?: ProxyLoadObservation;
  readonly error?: string;
  readonly artifacts: K6Artifacts;
  readonly telemetry?: {
    readonly cpuPercent: number;
    readonly userSeconds: number;
    readonly systemSeconds: number;
    readonly maxRssKib: number;
    readonly cpuSet?: string;
  };
}

export interface ProxyResources {
  readonly cpus: number;
  readonly memory: string;
  readonly workers: number;
  readonly idleSeconds: number;
  readonly logDriver: string;
  readonly proxyCpuSet?: string;
  readonly mockCpuSet?: string;
  readonly loadGeneratorCpuSet?: string;
  readonly mockCpus?: number;
  readonly mockMemory?: string;
}

export interface ProxyTrialPlan {
  readonly id: string;
  readonly scenario: string;
  readonly variant: string;
  readonly round: number;
  readonly load: ProxyLoad;
  readonly workload: K6Workload;
  readonly proxyConfigPath: string;
  readonly fixturePath: string;
  readonly mockImage: string;
  readonly mockEnvironment?: Readonly<Record<string, string>>;
  readonly isolateMeasurementWindow?: boolean;
  readonly bypassProxy?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly dimensions: Readonly<Record<string, unknown>>;
}

export interface ProxyExperiment {
  readonly image: string;
  readonly resources: ProxyResources;
  readonly trials: ReadonlyArray<ProxyTrialPlan>;
  readonly port?: number;
  readonly readinessPath?: string;
  readonly artifactsDirectory: string;
}

export const ProxyResourcesSchema = Schema.Struct({
  cpus: Positive,
  memory: Schema.NonEmptyString,
  workers: PositiveInteger,
  idleSeconds: Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  logDriver: Schema.NonEmptyString,
  proxyCpuSet: Schema.optionalKey(Schema.NonEmptyString),
  mockCpuSet: Schema.optionalKey(Schema.NonEmptyString),
  loadGeneratorCpuSet: Schema.optionalKey(Schema.NonEmptyString),
  mockCpus: Schema.optionalKey(Positive),
  mockMemory: Schema.optionalKey(Schema.NonEmptyString),
});

export const ProxyExperimentSchema = Schema.Struct({
  image: Schema.NonEmptyString,
  resources: ProxyResourcesSchema,
  trials: Schema.Array(Schema.Struct({
    id: Schema.NonEmptyString,
    scenario: Schema.NonEmptyString,
    variant: Schema.NonEmptyString,
    round: PositiveInteger,
    load: ProxyLoad,
    workload: Schema.Struct({
      ...K6WorkloadDefinition.fields,
      body: Schema.instanceOf(Uint8Array),
    }),
    proxyConfigPath: Schema.NonEmptyString,
    fixturePath: Schema.NonEmptyString,
    mockImage: Schema.NonEmptyString,
    mockEnvironment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    isolateMeasurementWindow: Schema.optionalKey(Schema.Boolean),
    bypassProxy: Schema.optionalKey(Schema.Boolean),
    environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    dimensions: Schema.Record(Schema.String, Schema.Json),
  })).pipe(Schema.check(Schema.isMinLength(1))),
  port: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))),
  ),
  readinessPath: Schema.optionalKey(Schema.NonEmptyString),
  artifactsDirectory: Schema.NonEmptyString,
}).annotate({ identifier: "ProxyExperiment" });

export interface ContainerTelemetry {
  readonly imageId: string;
  readonly baselineMemoryBytes: number;
  readonly baselineAnonBytes: number;
  readonly peakMemoryBytes: number;
  readonly loadedMemoryBytes: number;
  readonly loadedAnonBytes: number;
  readonly idleMemoryBytes: number;
  readonly idleAnonBytes: number;
  readonly cpuBeforeUsec: number;
  readonly cpuAfterUsec: number;
  readonly cpuNrPeriodsBefore: number;
  readonly cpuNrPeriodsAfter: number;
  readonly cpuNrThrottledBefore: number;
  readonly cpuNrThrottledAfter: number;
  readonly cpuThrottledUsecBefore: number;
  readonly cpuThrottledUsecAfter: number;
  readonly cpuMax: string;
  readonly cpuSet: string;
  readonly wallSeconds: number;
  readonly window: TelemetryWindow;
}

export type TelemetryWindow =
  | "k6 process: warmup, fixed measurement window, and drain"
  | "post-warmup measurement process and drain; memory.peak spans the container lifetime because Docker mounts the container cgroup read-only";

export interface TelemetryMeasurements {
  readonly cpuAveragePercent: number;
  readonly baselineMemoryMib: number;
  readonly baselineAnonMib: number;
  readonly peakMemoryMib: number;
  readonly loadedMemoryMib: number;
  readonly loadedAnonMib: number;
  readonly idleMemoryMib: number;
  readonly idleAnonMib: number;
}

export const telemetryMeasurements = (telemetry: ContainerTelemetry): TelemetryMeasurements => ({
  cpuAveragePercent: (telemetry.cpuAfterUsec - telemetry.cpuBeforeUsec) / 1_000_000
    / telemetry.wallSeconds * 100,
  baselineMemoryMib: telemetry.baselineMemoryBytes / 1_048_576,
  baselineAnonMib: telemetry.baselineAnonBytes / 1_048_576,
  peakMemoryMib: telemetry.peakMemoryBytes / 1_048_576,
  loadedMemoryMib: telemetry.loadedMemoryBytes / 1_048_576,
  loadedAnonMib: telemetry.loadedAnonBytes / 1_048_576,
  idleMemoryMib: telemetry.idleMemoryBytes / 1_048_576,
  idleAnonMib: telemetry.idleAnonBytes / 1_048_576,
});
