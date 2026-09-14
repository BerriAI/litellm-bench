import { Schema } from "effect";

import {
  FiniteNumber,
  JsonObject,
  NonEmptyString,
  NonNegativeInteger,
  PositiveInteger,
} from "./common.js";

export const ClosedLoad = Schema.Struct({
  mode: Schema.Literal("closed"),
  concurrency: PositiveInteger,
  duration_seconds: FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  warmup_seconds: FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
}).annotate({ identifier: "ClosedLoad" });

export const ArrivalLoad = Schema.Struct({
  mode: Schema.Literal("fixed"),
  rate: FiniteNumber.pipe(Schema.check(Schema.isGreaterThan(0))),
  preallocated_vus: PositiveInteger,
  max_vus: PositiveInteger,
  duration_seconds: FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  warmup_seconds: FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  steady_state: Schema.optionalKey(Schema.Struct({
    window_seconds: PositiveInteger,
    windows: PositiveInteger,
    maximum_cv: FiniteNumber.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  })),
}).annotate({ identifier: "ArrivalLoad" });

export const ProxyLoad = Schema.Union([ClosedLoad, ArrivalLoad], { mode: "oneOf" });

export const LatencyObservation = Schema.Struct({
  samples: NonNegativeInteger,
  mean_ms: FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  p50_ms: FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  p95_ms: FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  p99_ms: FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  max_ms: FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
}).annotate({ identifier: "LatencyObservation" });

export const ProxyLoadObservation = Schema.Struct({
  started: NonNegativeInteger,
  completed: NonNegativeInteger,
  successful: NonNegativeInteger,
  failed: NonNegativeInteger,
  dropped: NonNegativeInteger,
  interrupted: NonNegativeInteger,
  window_completed: NonNegativeInteger,
  window_successful: NonNegativeInteger,
  window_failed: NonNegativeInteger,
  tail_completed: NonNegativeInteger,
  tail_successful: NonNegativeInteger,
  tail_failed: NonNegativeInteger,
  warmup_requests: NonNegativeInteger,
  warmup_failed: NonNegativeInteger,
  measurement_seconds: FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  drain_seconds: FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  elapsed_seconds: FiniteNumber.pipe(Schema.check(Schema.isGreaterThan(0))),
  completion_rps: FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  error_rate: FiniteNumber.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  warmup_stable: Schema.optionalKey(Schema.Boolean),
  warmup_cv: Schema.optionalKey(
    FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  warmup_window_rps: Schema.optionalKey(Schema.Array(
    FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  )),
  latency: Schema.optionalKey(LatencyObservation),
  ttfb: Schema.optionalKey(LatencyObservation),
  stream_events: Schema.optionalKey(NonNegativeInteger),
  event_rps: Schema.optionalKey(
    FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  errors: Schema.Record(Schema.String, NonNegativeInteger),
}).annotate({ identifier: "ProxyLoadObservation" });

const FixturePath = Schema.String.pipe(Schema.check(Schema.isPattern(/^\//)));
const Milliseconds = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const FixtureHeaders = Schema.Record(
  Schema.String.pipe(Schema.check(Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/))),
  Schema.String.pipe(Schema.check(Schema.isPattern(/^[^\r\n]*$/))),
);
const ResponseOptions = {
  status: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 200, maximum: 599 }))),
  ),
  headers: Schema.optionalKey(FixtureHeaders),
};
export const JsonResponseTiming = Schema.Struct({
  response_delay_ms: Milliseconds,
}).annotate({ identifier: "JsonResponseTiming" });
export const SseResponseTiming = Schema.Struct({
  first_event_delay_ms: Milliseconds,
  event_interval_ms: Milliseconds,
}).annotate({ identifier: "SseResponseTiming" });
export const JsonFixtureResponse = Schema.Struct({
  kind: Schema.Literal("json"),
  timing: JsonResponseTiming,
  body: Schema.Json,
  ...ResponseOptions,
});
export const SseEvent = Schema.Struct({
  event: Schema.optionalKey(
    Schema.NonEmptyString.pipe(Schema.check(Schema.isPattern(/^[^\r\n]+$/))),
  ),
  data: Schema.Json,
});
export const SseFixtureResponse = Schema.Struct({
  kind: Schema.Literal("sse"),
  timing: SseResponseTiming,
  events: Schema.Array(SseEvent).pipe(Schema.check(Schema.isMinLength(1))),
  max_write_bytes: Schema.optionalKey(PositiveInteger),
  ...ResponseOptions,
});
export const FixtureResponse = Schema.Union([JsonFixtureResponse, SseFixtureResponse]);
const MatchFields = {
  method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]),
  path: FixturePath,
  expect: JsonObject,
  optional_expect: Schema.optionalKey(JsonObject),
  body_match: Schema.optionalKey(Schema.Literals(["subset", "exact"])),
  expect_headers: Schema.optionalKey(FixtureHeaders),
  png_fields: Schema.optionalKey(Schema.Array(NonEmptyString)),
};
export const MockOperation = Schema.Struct({
  id: NonEmptyString,
  operation: Schema.Literals(["generic", "ocr", "chat-completions", "responses"]),
  ...MatchFields,
  response: FixtureResponse,
}).annotate({ identifier: "MockOperation" });
export const ProviderFixture = Schema.Struct({
  $schema: Schema.optionalKey(NonEmptyString),
  version: Schema.Literal(2),
  operations: Schema.Array(MockOperation).pipe(Schema.check(Schema.isMinLength(1))),
}).annotate({ identifier: "ProviderFixture" });
export const UpstreamFixture = ProviderFixture.annotate({
  identifier: "UpstreamFixture",
  title: "LiteLLM upstream fixture",
});

export const FixtureProvenance = Schema.Struct({
  source: Schema.Literals(["synthetic", "recorded"]),
  generator: NonEmptyString,
  upstream_version: Schema.optionalKey(NonEmptyString),
  recorded_at: Schema.optionalKey(NonEmptyString),
});
export const ProviderRouteFixture = Schema.Struct({
  id: NonEmptyString,
  export: NonEmptyString,
  purpose: Schema.Literals(["capacity", "conformance"]),
  modes: Schema.Array(Schema.Literals(["json", "sse"])).pipe(Schema.check(Schema.isMinLength(1))),
  provenance: FixtureProvenance,
});
export const ProviderRouteManifest = Schema.Struct({
  version: Schema.Literal(1),
  provider: NonEmptyString,
  route: FixturePath,
  fixtures: Schema.Array(ProviderRouteFixture).pipe(Schema.check(Schema.isMinLength(1))),
}).annotate({ identifier: "ProviderRouteManifest" });
export type ProviderRouteManifest = typeof ProviderRouteManifest.Type;

export const decodeProviderRouteManifest = Schema.decodeUnknownSync(ProviderRouteManifest, {
  onExcessProperty: "error",
});

export const StreamStats = Schema.Struct({
  started: NonNegativeInteger,
  completed: NonNegativeInteger,
  cancelled: NonNegativeInteger,
  failed: NonNegativeInteger,
});
export const RequestMismatchReason = Schema.Literals([
  "method_or_path",
  "request_body",
  "request_headers",
  "png_document",
  "ambiguous_match",
]);
export const RequestMismatchDiagnostic = Schema.Struct({
  reason: RequestMismatchReason,
  method: NonEmptyString,
  path: FixturePath,
  operation_id: Schema.optionalKey(NonEmptyString),
  detail: NonEmptyString,
});
export const MockStats = Schema.Struct({
  requests: NonNegativeInteger,
  failures: NonNegativeInteger,
  errors: Schema.Record(Schema.String, NonNegativeInteger),
  streams: Schema.optionalKey(StreamStats),
  last_mismatch: Schema.optionalKey(RequestMismatchDiagnostic),
});
export type MockOperation = typeof MockOperation.Type;
export type FixtureResponse = typeof FixtureResponse.Type;
export type SseEvent = typeof SseEvent.Type;
export type MockStats = typeof MockStats.Type;
export type RequestMismatchDiagnostic = typeof RequestMismatchDiagnostic.Type;

/** Decode once at the boundary; both preflight and the provider use this contract. */
export const decodeUpstreamFixture = (value: unknown): readonly MockOperation[] => {
  const fixture = Schema.decodeUnknownSync(UpstreamFixture, { onExcessProperty: "error" })(value);
  const operations: readonly MockOperation[] = fixture.operations;
  const ids = new Set<string>();
  for (const op of operations) {
    if (ids.has(op.id)) throw new Error(`duplicate operation ID: ${op.id}`);
    ids.add(op.id);
    if (op.path.split("?")[0] === "/__stats") throw new Error("/__stats is reserved");
    const overlappingBodyFields = Object.keys(op.optional_expect ?? {}).filter((key) =>
      Object.hasOwn(op.expect, key)
    );
    if (overlappingBodyFields.length > 0) {
      throw new Error(
        `operation ${op.id}: body fields cannot be both required and optional: ${
          overlappingBodyFields.join(", ")
        }`,
      );
    }
    if (op.response.status === 204 || op.response.status === 205 || op.response.status === 304) {
      throw new Error(`operation ${op.id}: bodyless status cannot have a fixture response`);
    }
    if (op.method === "HEAD" && op.response.kind === "sse") {
      throw new Error(`operation ${op.id}: HEAD cannot stream events`);
    }
    for (const header of Object.keys(op.response.headers ?? {})) {
      if (
        ["content-length", "transfer-encoding", "connection", "content-type"].includes(
          header.toLowerCase(),
        )
      ) {
        throw new Error(`operation ${op.id}: transport owns header ${header}`);
      }
    }
  }
  return operations;
};

export const ContainerTelemetry = Schema.Struct({
  image_id: NonEmptyString,
  baseline_memory_bytes: NonNegativeInteger,
  baseline_anon_bytes: NonNegativeInteger,
  peak_memory_bytes: NonNegativeInteger,
  loaded_memory_bytes: NonNegativeInteger,
  loaded_anon_bytes: NonNegativeInteger,
  idle_memory_bytes: NonNegativeInteger,
  idle_anon_bytes: NonNegativeInteger,
  cpu_before_usec: NonNegativeInteger,
  cpu_after_usec: NonNegativeInteger,
  cpu_nr_periods_before: NonNegativeInteger,
  cpu_nr_periods_after: NonNegativeInteger,
  cpu_nr_throttled_before: NonNegativeInteger,
  cpu_nr_throttled_after: NonNegativeInteger,
  cpu_throttled_usec_before: NonNegativeInteger,
  cpu_throttled_usec_after: NonNegativeInteger,
  cpu_max: NonEmptyString,
  cpuset_cpus_effective: NonEmptyString,
  wall_seconds: FiniteNumber.pipe(Schema.check(Schema.isGreaterThan(0))),
  window: NonEmptyString,
}).annotate({ identifier: "ContainerTelemetry" });

export const ProxyRawObservation = Schema.Struct({
  trials: Schema.Array(Schema.Struct({
    id: NonEmptyString,
    scenario: NonEmptyString,
    variant: NonEmptyString,
    round: PositiveInteger,
    load: ProxyLoad,
    dimensions: JsonObject,
    client: Schema.optionalKey(Schema.Struct({
      engine: NonEmptyString,
      exit_code: Schema.Int,
      result: Schema.optionalKey(ProxyLoadObservation),
      error: Schema.optionalKey(Schema.String),
      artifacts: Schema.Record(Schema.String, NonEmptyString),
    })),
    telemetry: Schema.optionalKey(ContainerTelemetry),
    mock_telemetry: Schema.optionalKey(ContainerTelemetry),
    load_generator_telemetry: Schema.optionalKey(Schema.Struct({
      cpu_percent: FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
      user_seconds: FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
      system_seconds: FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
      max_rss_kib: NonNegativeInteger,
      cpuset_cpus: Schema.optionalKey(NonEmptyString),
    })),
    upstream: Schema.optionalKey(MockStats),
    error: Schema.optionalKey(Schema.String),
  })),
  metadata: JsonObject,
}).annotate({ identifier: "ProxyRawObservation" });

export function validateArrivalLoad(load: typeof ArrivalLoad.Type): boolean {
  return load.max_vus >= load.preallocated_vus;
}

export function validateProxyLoadObservation(result: typeof ProxyLoadObservation.Type): boolean {
  return result.started === result.completed + result.interrupted
    && result.completed === result.successful + result.failed
    && result.window_completed === result.window_successful + result.window_failed
    && result.tail_completed === result.tail_successful + result.tail_failed
    && result.completed === result.window_completed + result.tail_completed
    && (result.latency?.samples ?? 0) === result.window_successful
    && (result.ttfb === undefined || result.ttfb.samples === result.window_successful)
    && (
      (result.stream_events === undefined && result.event_rps === undefined)
      || (
        result.stream_events !== undefined && result.event_rps !== undefined
        && result.ttfb !== undefined
        && result.event_rps === result.stream_events / result.measurement_seconds
      )
    )
    && result.completion_rps === result.window_successful / result.measurement_seconds
    && result.error_rate === (result.window_completed === 0
        ? 0
        : result.window_failed / result.window_completed);
}

export type ProxyLoad = typeof ProxyLoad.Type;
export type ProxyLoadObservation = typeof ProxyLoadObservation.Type;
export type ProxyRawObservation = typeof ProxyRawObservation.Type;
export type UpstreamFixture = typeof UpstreamFixture.Type;
