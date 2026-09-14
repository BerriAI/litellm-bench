import { type ProxyRawObservation, Sha256Id } from "@litellm-bench/contracts";
import { InvalidObservation } from "@litellm-bench/harness";
import { proxyTrialIssue } from "@litellm-bench/proxy";
import { Effect, Option, Schema } from "effect";
import type { OcrObservation } from "./types.js";

const ByteCount = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

export const OcrVariant = Schema.Literals(["python", "rust"]);

export const OcrApparatusLimits = {
  minimumProxyCpuPercent: 90,
  maximumMockCpuPercent: 80,
  maximumLoadGeneratorCpuPercent: 160,
} as const;

export const OcrDimensions = Schema.Struct({
  payload_requested_bytes: ByteCount,
  wire_body_bytes: ByteCount,
  document_bytes: ByteCount,
  document_sha256: Sha256Id,
});

export type ClassifiedOcrFields = {
  readonly variant: typeof OcrVariant.Type;
  readonly payload_requested_bytes: number;
  readonly wire_body_bytes: number;
  readonly document_bytes: number;
  readonly document_sha256: string;
};

export type ClassifiedOcrTrial =
  | { readonly ok: true; readonly fields: ClassifiedOcrFields }
  | { readonly ok: false; readonly issue: string };

export const classifyOcrTrial = (
  trial: ProxyRawObservation["trials"][number],
): ClassifiedOcrTrial => {
  const issue = proxyTrialIssue(trial);
  if (issue !== undefined) return { ok: false, issue };
  if (trial.telemetry === undefined) return { ok: false, issue: "missing telemetry" };
  if (trial.mock_telemetry === undefined) return { ok: false, issue: "missing mock telemetry" };
  if (trial.load_generator_telemetry === undefined) {
    return { ok: false, issue: "missing load-generator telemetry" };
  }
  const proxyCpuPercent = (trial.telemetry.cpu_after_usec - trial.telemetry.cpu_before_usec)
    / 1_000_000 / trial.telemetry.wall_seconds * 100;
  const mockCpuPercent = (
    trial.mock_telemetry.cpu_after_usec - trial.mock_telemetry.cpu_before_usec
  ) / 1_000_000 / trial.mock_telemetry.wall_seconds * 100;
  if (proxyCpuPercent < OcrApparatusLimits.minimumProxyCpuPercent) {
    return { ok: false, issue: `proxy was not CPU-saturated: ${proxyCpuPercent.toFixed(1)}%` };
  }
  if (mockCpuPercent >= OcrApparatusLimits.maximumMockCpuPercent) {
    return { ok: false, issue: `mock may be limiting: ${mockCpuPercent.toFixed(1)}% CPU` };
  }
  if (
    trial.load_generator_telemetry.cpu_percent
      >= OcrApparatusLimits.maximumLoadGeneratorCpuPercent
  ) {
    return {
      ok: false,
      issue: `load generator may be limiting: ${
        trial.load_generator_telemetry.cpu_percent.toFixed(1)
      }% CPU`,
    };
  }
  const dimensions = Schema.decodeUnknownOption(OcrDimensions)(trial.dimensions);
  if (Option.isNone(dimensions)) return { ok: false, issue: "missing payload dimensions" };
  if (!Schema.is(OcrVariant)(trial.variant)) {
    return { ok: false, issue: `unknown variant ${trial.variant}` };
  }
  return {
    ok: true,
    fields: {
      variant: trial.variant,
      payload_requested_bytes: dimensions.value.payload_requested_bytes,
      wire_body_bytes: dimensions.value.wire_body_bytes,
      document_bytes: dimensions.value.document_bytes,
      document_sha256: dimensions.value.document_sha256,
    },
  };
};

export const decodeOcrObservation = Effect.fn("ProxyOcr.decodeObservation")(
  function*(trial: ProxyRawObservation["trials"][number]) {
    const classified = classifyOcrTrial(trial);
    const client = trial.client?.result;
    const telemetry = trial.telemetry;
    if (!classified.ok) {
      return yield* new InvalidObservation({
        message: `Invalid OCR trial ${trial.id}: ${classified.issue}`,
      });
    }
    if (client?.latency === undefined) {
      return yield* new InvalidObservation({
        message: `Invalid OCR trial ${trial.id}: missing latency`,
      });
    }
    if (telemetry === undefined) {
      return yield* new InvalidObservation({
        message: `Invalid OCR trial ${trial.id}: missing telemetry`,
      });
    }
    if (trial.mock_telemetry === undefined) {
      return yield* new InvalidObservation({
        message: `Invalid OCR trial ${trial.id}: missing mock telemetry`,
      });
    }
    if (trial.load_generator_telemetry === undefined) {
      return yield* new InvalidObservation({
        message: `Invalid OCR trial ${trial.id}: missing load-generator telemetry`,
      });
    }
    const proxyCpuUsec = telemetry.cpu_after_usec - telemetry.cpu_before_usec;
    const mockCpuUsec = trial.mock_telemetry.cpu_after_usec
      - trial.mock_telemetry.cpu_before_usec;
    const concurrency = trial.load.mode === "closed"
      ? trial.load.concurrency
      : trial.load.preallocated_vus;
    return {
      label: `${trial.scenario}_r${trial.round}`,
      variant: classified.fields.variant,
      payload_requested_bytes: classified.fields.payload_requested_bytes,
      wire_body_bytes: classified.fields.wire_body_bytes,
      document_bytes: classified.fields.document_bytes,
      document_sha256: classified.fields.document_sha256,
      load_model: trial.load.mode,
      concurrency,
      requests: client.started,
      successes: client.successful,
      failures: client.failed,
      completion_rps: client.completion_rps,
      p95_ms: client.latency.p95_ms,
      cpu_average_percent: proxyCpuUsec / 1_000_000 / telemetry.wall_seconds * 100,
      cpu_ms_per_request: proxyCpuUsec / 1_000 / client.successful,
      peak_memory_mib: telemetry.peak_memory_bytes / 1_048_576,
      peak_memory_growth_mib: (telemetry.peak_memory_bytes - telemetry.baseline_memory_bytes)
        / 1_048_576,
      idle_anon_mib: telemetry.idle_anon_bytes / 1_048_576,
      idle_anon_growth_mib: (telemetry.idle_anon_bytes - telemetry.baseline_anon_bytes)
        / 1_048_576,
      mock_cpu_average_percent: mockCpuUsec / 1_000_000
        / trial.mock_telemetry.wall_seconds * 100,
      load_generator_cpu_percent: trial.load_generator_telemetry.cpu_percent,
    } satisfies OcrObservation;
  },
);
