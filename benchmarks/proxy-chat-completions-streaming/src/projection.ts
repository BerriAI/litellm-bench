import { median } from "@litellm-bench/analysis";
import type { Analysis, Metric } from "@litellm-bench/contracts";
import type { StreamingChatConfig } from "./config.js";

export interface StreamingChatTrialObservation {
  readonly round: number;
  readonly offered_rps: number;
  readonly completion_rps: number;
  readonly error_rate: number;
  readonly p95_ttfb_ms: number;
  readonly p95_stream_duration_ms: number;
  readonly dropped: number;
  readonly warmup_stable: boolean;
  readonly calibration: boolean;
  readonly valid: boolean;
  readonly mock_cpu_percent?: number;
  readonly mock_throttled_fraction?: number;
  readonly load_generator_cpu_percent?: number;
}

const deviation = (values: readonly number[]): number => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
};

const bootstrapMedian = (values: readonly number[]) => {
  let state = 0x5eed1234;
  const samples = Array.from({ length: 10_000 }, () => {
    const sample = Array.from({ length: values.length }, () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return values[state % values.length]!;
    });
    return median(sample)!;
  }).sort((left, right) => left - right);
  return { lower: samples[249]!, upper: samples[9749]! };
};

export const streamingTrialMeetsSlo = (
  trial: StreamingChatTrialObservation,
  config: typeof StreamingChatConfig.Type,
): boolean =>
  trial.valid
  && trial.warmup_stable
  && trial.dropped === 0
  && trial.error_rate <= config.slo.maximum_error_rate
  && trial.p95_ttfb_ms <= config.slo.p95_ttfb_ms
  && trial.p95_stream_duration_ms <= config.slo.p95_stream_duration_ms
  && trial.completion_rps / trial.offered_rps >= config.slo.minimum_achievement_ratio;

/**
 * Why a bypass-calibration trial fails to prove that the mock and load generator have headroom,
 * or `undefined` when the apparatus was healthy. Throttling is judged as a fraction of wall time
 * because CFS bandwidth control routinely reports a few hundred microseconds of throttling for a
 * pinned cgroup running far below its quota; genuine contention shows up as a material fraction.
 */
export const calibrationHeadroomIssue = (
  trial: StreamingChatTrialObservation,
  config: typeof StreamingChatConfig.Type,
): string | undefined => {
  const limit = config.calibration_headroom;
  if (!streamingTrialMeetsSlo({ ...trial, p95_ttfb_ms: 0, p95_stream_duration_ms: 0 }, config)) {
    return "bypass calibration missed its offered rate, error budget, or dropped arrivals";
  }
  if (trial.load_generator_cpu_percent === undefined) {
    return "missing load-generator CPU utilization";
  }
  if (trial.load_generator_cpu_percent >= limit.maximum_cpu_percent) {
    return `load generator used ${
      trial.load_generator_cpu_percent.toFixed(1)
    }% CPU (limit ${limit.maximum_cpu_percent}%)`;
  }
  if (trial.mock_cpu_percent === undefined) return "missing mock CPU utilization";
  if (trial.mock_cpu_percent >= limit.maximum_cpu_percent) {
    return `mock used ${
      trial.mock_cpu_percent.toFixed(1)
    }% CPU (limit ${limit.maximum_cpu_percent}%)`;
  }
  if (trial.mock_throttled_fraction === undefined) return "missing mock CPU throttling telemetry";
  if (trial.mock_throttled_fraction > limit.maximum_throttled_fraction) {
    return `mock was CPU-throttled for ${
      (trial.mock_throttled_fraction * 100).toFixed(3)
    }% of the trial (limit ${limit.maximum_throttled_fraction * 100}%)`;
  }
  return undefined;
};

export const projectStreamingChatCompletions = (
  trials: readonly StreamingChatTrialObservation[],
  config: typeof StreamingChatConfig.Type,
) => {
  if (trials.some(({ valid }) => !valid)) {
    throw new Error("streaming chat benchmark requires every trial to have measurement integrity");
  }
  const calibrations = trials.filter(({ calibration }) => calibration);
  const measurements = trials.filter(({ calibration }) => !calibration);
  if (calibrations.length !== config.rounds) {
    throw new Error("one bypass calibration is required per round");
  }
  const calibrationFailures = calibrations.filter((trial) =>
    calibrationHeadroomIssue(trial, config) !== undefined
  );
  if (calibrationFailures.length > 0) {
    throw new Error(
      `load-generator/mock headroom calibration failed in ${calibrationFailures.length} round(s)`,
    );
  }
  const rates = [...config.arrival_rates];
  const rateRows = rates.map((rate) => {
    const rows = measurements.filter(({ offered_rps }) => offered_rps === rate);
    if (rows.length !== config.rounds) {
      throw new Error(`rate ${rate} does not have ${config.rounds} independent trials`);
    }
    const passes = rows.filter((trial) => streamingTrialMeetsSlo(trial, config)).length;
    return {
      rate,
      passes,
      pass_fraction: passes / rows.length,
      sustainable: passes / rows.length >= config.slo.required_pass_fraction,
    };
  });
  let sustainableCapacity: number | undefined;
  for (const row of rateRows) {
    if (!row.sustainable) break;
    sustainableCapacity = row.rate;
  }
  if (sustainableCapacity === undefined) {
    throw new Error("the sweep did not find a sustainable offered rate");
  }
  if (!rateRows.some(({ rate, sustainable }) => rate > sustainableCapacity! && !sustainable)) {
    throw new Error("the sweep did not bracket saturation above the sustainable rate");
  }
  const roundCapacities = Array.from({ length: config.rounds }, (_, index) => index + 1).map(
    (round) => {
      let capacity = 0;
      for (const rate of rates) {
        const row = measurements.find((trial) =>
          trial.round === round && trial.offered_rps === rate
        );
        if (row === undefined || !streamingTrialMeetsSlo(row, config)) break;
        capacity = rate;
      }
      return capacity;
    },
  );
  const capacityMedian = median(roundCapacities)!;
  const mad = median(roundCapacities.map((value) => Math.abs(value - capacityMedian)))!;
  const confidence = bootstrapMedian(roundCapacities);
  return {
    metrics: [{
      id: "stream.sustainable_rps",
      label: "Sustainable one-worker offered streaming request rate",
      value: sustainableCapacity,
      unit: "RPS",
      better: "higher",
    }] satisfies Metric[],
    analyses: [{
      id: "stream.capacity-knee",
      measurement: "slo_pass",
      aggregation: "highest contiguous rate meeting required trial pass fraction",
      payload: {
        rates: rateRows,
        round_capacities: roundCapacities,
        median: capacityMedian,
        minimum: Math.min(...roundCapacities),
        maximum: Math.max(...roundCapacities),
        standard_deviation: deviation(roundCapacities),
        median_absolute_deviation: mad,
        bootstrap_95_percent_ci: confidence,
        bootstrap_resamples: 10_000,
      },
    }] satisfies Analysis[],
  };
};
