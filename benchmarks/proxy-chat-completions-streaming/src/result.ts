import { BenchmarkResult, type ProxyRawObservation, type Trial } from "@litellm-bench/contracts";
import { InvalidObservation, type RunContext } from "@litellm-bench/harness";
import { proxyTrialIntegrityIssue } from "@litellm-bench/proxy";
import { Effect, Schema } from "effect";
import type { StreamingChatConfig } from "./config.js";
import {
  calibrationHeadroomIssue,
  projectStreamingChatCompletions,
  streamingTrialMeetsSlo,
} from "./projection.js";

const cpuPercent = (
  telemetry: NonNullable<ProxyRawObservation["trials"][number]["mock_telemetry"]>,
) =>
  (telemetry.cpu_after_usec - telemetry.cpu_before_usec) / 1_000_000 / telemetry.wall_seconds * 100;

const observation = (
  trial: ProxyRawObservation["trials"][number],
  config: typeof StreamingChatConfig.Type,
) => {
  const result = trial.client?.result;
  const integrityIssue = proxyTrialIntegrityIssue(trial);
  const calibration = trial.dimensions.calibration === true;
  const streamIssue = result?.ttfb === undefined
    ? "missing streaming TTFB measurement"
    : result.stream_events === undefined || result.event_rps === undefined
    ? "missing streaming event measurements"
    : trial.upstream?.streams === undefined
    ? "missing upstream stream statistics"
    : trial.upstream.streams.failed !== 0 || trial.upstream.streams.cancelled !== 0
        || trial.upstream.streams.started !== trial.upstream.streams.completed
    ? "upstream streams failed, cancelled, or incomplete"
    : undefined;
  const telemetryIssue = trial.mock_telemetry === undefined
    ? "missing mock cgroup telemetry"
    : trial.mock_telemetry.cpuset_cpus_effective !== config.resources.cpu_sets.mock
    ? "mock effective CPU set does not match the plan"
    : trial.mock_telemetry.cpu_max.startsWith("max ")
    ? "mock CPU quota is unlimited"
    : trial.load_generator_telemetry === undefined
    ? "missing load-generator utilization telemetry"
    : trial.load_generator_telemetry.cpuset_cpus !== config.resources.cpu_sets.load_generator
    ? "load-generator effective CPU set does not match the plan"
    : !calibration && trial.telemetry === undefined
    ? "missing proxy cgroup telemetry"
    : !calibration && trial.telemetry?.cpuset_cpus_effective !== config.resources.cpu_sets.proxy
    ? "proxy effective CPU set does not match the plan"
    : !calibration && trial.telemetry?.cpu_max.startsWith("max ")
    ? "proxy CPU quota is unlimited"
    : undefined;
  const issue = integrityIssue ?? streamIssue ?? telemetryIssue;
  const offered = Number(trial.dimensions.offered_rps ?? 0);
  const projected = {
    round: trial.round,
    offered_rps: offered,
    completion_rps: result?.completion_rps ?? 0,
    error_rate: result?.error_rate ?? 1,
    p95_ttfb_ms: result?.ttfb?.p95_ms ?? Number.MAX_SAFE_INTEGER,
    p95_stream_duration_ms: result?.latency?.p95_ms ?? Number.MAX_SAFE_INTEGER,
    dropped: result?.dropped ?? 0,
    warmup_stable: result?.warmup_stable ?? false,
    calibration,
    valid: issue === undefined,
    ...(trial.mock_telemetry === undefined
      ? {}
      : {
        mock_cpu_percent: cpuPercent(trial.mock_telemetry),
        mock_throttled_fraction: (trial.mock_telemetry.cpu_throttled_usec_after
          - trial.mock_telemetry.cpu_throttled_usec_before)
          / 1_000_000 / trial.mock_telemetry.wall_seconds,
      }),
    ...(trial.load_generator_telemetry === undefined
      ? {}
      : { load_generator_cpu_percent: trial.load_generator_telemetry.cpu_percent }),
  };
  const normalized: Trial = {
    id: trial.id,
    scenario: trial.scenario,
    variant: trial.variant,
    round: trial.round,
    valid: issue === undefined,
    dimensions: { ...trial.dimensions, ...trial.load },
    measurements: {
      offered_rps: offered,
      window_completion_rps: result?.completion_rps ?? 0,
      window_event_rps: result?.event_rps ?? 0,
      window_error_rate: result?.error_rate ?? 1,
      p95_ttfb_ms: result?.ttfb?.p95_ms ?? 0,
      p95_stream_duration_ms: result?.latency?.p95_ms ?? 0,
      drain_seconds: result?.drain_seconds ?? 0,
      tail_completions: result?.tail_completed ?? 0,
      dropped_arrivals: result?.dropped ?? 0,
      warmup_cv: result?.warmup_cv ?? 0,
      slo_pass: streamingTrialMeetsSlo(projected, config) ? 1 : 0,
    },
    request_counts: {
      started: result?.started ?? 0,
      completed: result?.completed ?? 0,
      window_completed: result?.window_completed ?? 0,
      successful: result?.successful ?? 0,
      failed: result?.failed ?? 0,
      dropped: result?.dropped ?? 0,
      interrupted: result?.interrupted ?? 0,
      tail_completed: result?.tail_completed ?? 0,
    },
    ...(issue === undefined ? {} : { invalid_reason: issue }),
  };
  return { projected, normalized };
};

/**
 * Why a trial must be re-run as part of a fresh round: lost measurement integrity, or a bypass
 * calibration that failed to demonstrate apparatus headroom. SLO misses at swept rates are data,
 * not retry reasons.
 */
export const trialRetryIssue = (
  trial: ProxyRawObservation["trials"][number],
  config: typeof StreamingChatConfig.Type,
): string | undefined => {
  const { projected, normalized } = observation(trial, config);
  if (!normalized.valid) return normalized.invalid_reason;
  return projected.calibration ? calibrationHeadroomIssue(projected, config) : undefined;
};

export const buildStreamingChatResult = Effect.fn("ProxyStreamingChat.buildResult")(
  function*(
    context: RunContext,
    raw: ProxyRawObservation,
    config: typeof StreamingChatConfig.Type,
  ) {
    const observations = raw.trials.map((trial) => observation(trial, config));
    const invalid = observations.find(({ normalized }) => !normalized.valid);
    if (invalid !== undefined) {
      return yield* new InvalidObservation({
        message:
          `Invalid proxy trial ${invalid.normalized.id}: ${invalid.normalized.invalid_reason}`,
      });
    }
    const projected = yield* Effect.try({
      try: () =>
        projectStreamingChatCompletions(observations.map(({ projected }) => projected), config),
      catch: (error) =>
        new InvalidObservation({ message: error instanceof Error ? error.message : String(error) }),
    });
    return yield* Schema.decodeUnknownEffect(BenchmarkResult, { onExcessProperty: "error" })({
      run_id: context.runId,
      created_at: context.createdAt,
      case_id: context.spec.case_id,
      comparison_id: context.spec.comparison_id,
      benchmark: context.spec.benchmark,
      job: context.spec.job,
      version: context.spec.version.version,
      artifact: context.spec.artifact,
      apparatus: raw.metadata,
      metrics: projected.metrics,
      trials: observations.map(({ normalized }) => normalized),
      analyses: projected.analyses,
      details: raw,
      status: "ok",
    }).pipe(Effect.mapError((error) => new InvalidObservation({ message: error.message })));
  },
);
