import type { ProxyRawObservation } from "@litellm-bench/contracts";

export const proxyTrialIssue = (
  trial: ProxyRawObservation["trials"][number],
): string | undefined => {
  const result = trial.client?.result;
  if (trial.error !== undefined) return trial.error;
  if (trial.client?.exit_code !== 0) {
    return trial.client?.error ?? `k6 exited ${trial.client?.exit_code ?? "without a code"}`;
  }
  if (result === undefined) return trial.client?.error ?? "missing k6 result";
  if (result.successful <= 0) return "no successful requests";
  if (
    result.failed !== 0 || result.dropped !== 0 || result.interrupted !== 0
    || result.warmup_failed !== 0
  ) return "failed, dropped, interrupted, or warmup requests were observed";
  if (trial.upstream?.failures !== 0) return "upstream validation failed";
  const streams = trial.upstream.streams;
  if (
    streams !== undefined && (
      streams.failed !== 0 || streams.cancelled !== 0 || streams.started !== streams.completed
    )
  ) return "upstream streams failed, cancelled, or incomplete";
  if (trial.upstream.requests !== result.started + result.warmup_requests) {
    return "client and upstream request counts differ";
  }
  return undefined;
};

/** Integrity-only validation for load sweeps; SLO misses remain valid saturation observations. */
export const proxyTrialIntegrityIssue = (
  trial: ProxyRawObservation["trials"][number],
): string | undefined => {
  const result = trial.client?.result;
  if (trial.error !== undefined) return trial.error;
  if (trial.client?.exit_code !== 0) {
    return trial.client?.error ?? `k6 exited ${trial.client?.exit_code ?? "without a code"}`;
  }
  if (result === undefined) return trial.client?.error ?? "missing k6 result";
  if (result.window_completed <= 0) return "no requests completed inside the measurement window";
  if (result.interrupted !== 0 || result.warmup_failed !== 0) {
    return "interrupted or warmup requests were observed";
  }
  if (trial.upstream?.failures !== 0) return "upstream validation failed";
  if (trial.upstream === undefined) return "missing upstream statistics";
  if (trial.upstream.requests !== result.started + result.warmup_requests) {
    return "client and upstream request counts differ";
  }
  return undefined;
};
