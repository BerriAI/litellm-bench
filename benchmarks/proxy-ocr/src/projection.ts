import { median, pairedRatios } from "@litellm-bench/analysis";
import type { Analysis, Metric, Trial } from "@litellm-bench/contracts";
import type { OcrIntegrity } from "./config.js";
import { apparatusGateIssue } from "./observation.js";
import { seededUint32 } from "./random.js";
import type { OcrObservation, OcrProjection, OcrScenario } from "./types.js";

const scenarioId = (row: OcrObservation): string => row.label.replace(/_r\d+$/, "");
const roundNumber = (row: OcrObservation): number => Number(row.label.match(/_r(\d+)$/)?.[1]);

const measurements = {
  throughput_rps: {
    field: "completion_rps",
    short: "rps",
    label: "throughput",
    unit: "RPS",
    better: "higher",
  },
  latency_p95_ms: {
    field: "p95_ms",
    short: "latency_p95_ms",
    label: "p95 latency",
    unit: "ms",
    better: "lower",
  },
  cpu_average_percent: {
    field: "cpu_average_percent",
    short: "cpu_average_percent",
    label: "average CPU",
    unit: "%",
    better: "neutral",
  },
  cpu_ms_per_request: {
    field: "cpu_ms_per_request",
    short: "cpu_ms_per_request",
    label: "proxy CPU time per successful request",
    unit: "ms",
    better: "lower",
  },
  peak_memory_mib: {
    field: "peak_memory_mib",
    short: "peak_memory_mib",
    label: "peak memory",
    unit: "MiB",
    better: "lower",
  },
  peak_memory_growth_mib: {
    field: "peak_memory_growth_mib",
    short: "peak_memory_growth_mib",
    label: "peak memory growth above the post-warm-up baseline",
    unit: "MiB",
    better: "lower",
  },
  idle_anon_mib: {
    field: "idle_anon_mib",
    short: "idle_anon_mib",
    label: "post-load anonymous memory",
    unit: "MiB",
    better: "lower",
  },
  idle_anon_growth_mib: {
    field: "idle_anon_growth_mib",
    short: "idle_anon_growth_mib",
    label: "post-load anonymous-memory growth above the post-warm-up baseline",
    unit: "MiB",
    better: "lower",
  },
} as const;

type MeasurementId = keyof typeof measurements;
const measurementValue = (row: OcrObservation, id: MeasurementId): number =>
  row[measurements[id].field];

export const validatePrimaryRows = (
  rows: readonly OcrObservation[],
  scenarios: readonly OcrScenario[],
  rounds: number,
  integrity: OcrIntegrity,
): readonly string[] => {
  const scenarioMap = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const actual = rows.map((row) => `${scenarioId(row)}:${roundNumber(row)}:${row.variant}`);
  const expected = new Set(
    scenarios.flatMap((scenario) =>
      Array.from({ length: rounds }, (_, index) => index + 1).flatMap((round) =>
        (["python", "rust"] as const).map((variant) => `${scenario.id}:${round}:${variant}`)
      )
    ),
  );
  const rowIssues = rows.flatMap((row) => {
    const scenario = scenarioMap.get(scenarioId(row));
    if (scenario === undefined) return [`unexpected OCR scenario: ${scenarioId(row)}`];
    const gate = apparatusGateIssue({
      proxy_cpu_percent: row.cpu_average_percent,
      mock_cpu_percent: row.mock_cpu_average_percent,
      load_generator_cpu_percent: row.load_generator_cpu_percent,
    }, integrity);
    return [
      ...(row.payload_requested_bytes === scenario.payload_bytes
        ? []
        : [`wrong payload for ${row.label}`]),
      ...(row.concurrency === scenario.concurrency ? [] : [`wrong concurrency for ${row.label}`]),
      ...(row.load_model === scenario.load_model || row.load_model === "closed"
        ? []
        : [`wrong load model for ${row.label}`]),
      ...(row.failures === 0 && row.successes > 0 ? [] : [`invalid responses in ${row.label}`]),
      ...(gate === undefined ? [] : [`${row.label} ${row.variant}: ${gate}`]),
    ];
  });
  const actualSet = new Set(actual);
  const matrixIssues = actual.length === actualSet.size
      && actualSet.size === expected.size
      && actual.every((key) => expected.has(key))
    ? []
    : ["primary matrix is incomplete, duplicated, or contains unexpected trials"];
  return [...rowIssues, ...matrixIssues];
};

const normalizeTrials = (rows: readonly OcrObservation[]): readonly Trial[] =>
  rows.map((row) => ({
    id: `${row.label}.${row.variant}`,
    round: roundNumber(row),
    scenario: scenarioId(row),
    variant: row.variant,
    valid: row.failures === 0,
    dimensions: {
      payload_bytes: row.payload_requested_bytes,
      wire_body_bytes: row.wire_body_bytes,
      document_bytes: row.document_bytes,
      document_sha256: row.document_sha256,
      load_model: row.load_model,
      concurrency: row.concurrency,
    },
    measurements: Object.fromEntries(
      Object.keys(measurements).map((id) => [id, measurementValue(row, id as MeasurementId)]),
    ),
    request_counts: { attempted: row.requests, successful: row.successes, failed: row.failures },
  }));

export const projectOcr = (
  rows: readonly OcrObservation[],
  scenarios: readonly OcrScenario[],
  rounds: number,
  integrity: OcrIntegrity,
  orderSeed = "proxy-ocr-v1",
): OcrProjection => {
  const issues = validatePrimaryRows(rows, scenarios, rounds, integrity);
  if (issues.length > 0) throw new Error(issues.join(", "));
  const outputs = scenarios.map((scenario) => {
    const selected = rows.filter((row) => scenarioId(row) === scenario.id);
    const summaries = Object.entries(measurements).flatMap(([rawId, definition]) => {
      const id = rawId as MeasurementId;
      const groups = (["python", "rust"] as const).map((variant) => {
        const values = selected.filter((row) => row.variant === variant).map((row) =>
          measurementValue(row, id)
        );
        return {
          variant,
          values,
          median: median(values) as number,
          minimum: Math.min(...values),
          maximum: Math.max(...values),
        };
      });
      return {
        metrics: groups.map((group): Metric => ({
          id: `${scenario.id}.${group.variant}.${definition.short}`,
          label: `${group.variant[0]?.toUpperCase()}${
            group.variant.slice(1)
          } median ${definition.label}`,
          value: group.median,
          unit: definition.unit,
          group: scenario.label,
          better: definition.better,
        })),
        analysis: {
          id: `${scenario.id}.${id}.variant_summary`,
          measurement: id,
          aggregation: "median",
          payload: {
            definition: id === "throughput_rps" ? "variant_throughput" : "variant_diagnostics",
            scenario: scenario.id,
            groups: groups.map(({ variant, values, ...summary }) => ({
              variant,
              attempt_count: values.length,
              ...summary,
            })),
          },
        } satisfies Analysis,
      };
    });
    const python = selected.filter((row) => row.variant === "python");
    const rust = selected.filter((row) => row.variant === "rust");
    const ratios = pairedRatios(
      python,
      rust,
      (row) => String(roundNumber(row)),
      (row) => row.completion_rps,
    );
    if (ratios._tag !== "Ratios") throw new Error(`invalid OCR pairs: ${ratios._tag}`);
    const ratio = ratios.value;
    const logRatios = ratio.pairs.map(({ ratio }) => Math.log(ratio));
    const bootstrap = bootstrapMedianLogRatio(logRatios, `${orderSeed}:${scenario.id}`);
    const pairAnalysis: Analysis = {
      id: `${scenario.id}.paired_throughput_ratio`,
      measurement: "throughput_rps",
      aggregation: "median",
      payload: {
        definition: "paired_throughput_ratio",
        scenario: scenario.id,
        operation: "rust / python",
        pair_by: ["scenario", "round"],
        pairs: ratio.pairs.map(({ key, left, right, ratio: value }) => ({
          round: Number(key),
          python_rps: left.completion_rps,
          rust_rps: right.completion_rps,
          ratio: value,
        })),
        summary: {
          attempt_count: ratio.summary.count,
          median: ratio.summary.median,
          minimum: ratio.summary.minimum,
          maximum: ratio.summary.maximum,
          rust_wins: ratio.rightWins,
          paired_log_ratios: logRatios,
          bootstrap_95_percent_ci: bootstrap,
          bootstrap_resamples: 10_000,
        },
      },
    };
    const ratioMetric: Metric = {
      id: `${scenario.id}.paired_ratio`,
      label: "Median paired Rust/Python throughput",
      value: ratio.summary.median,
      unit: "x",
      group: scenario.label,
      better: "higher",
    };
    return {
      metrics: [...summaries.flatMap(({ metrics }) => metrics), ratioMetric],
      analyses: [...summaries.map(({ analysis }) => analysis), pairAnalysis],
    };
  });
  return {
    metrics: outputs.flatMap(({ metrics }) => metrics),
    analyses: outputs.flatMap(({ analyses }) => analyses),
    trials: normalizeTrials(rows),
  };
};

const bootstrapMedianLogRatio = (
  values: readonly number[],
  seed: string,
): { readonly lower: number; readonly upper: number } => {
  const next = seededUint32(seed);
  const samples = Array.from(
    { length: 10_000 },
    () =>
      median(
        Array.from(
          { length: values.length },
          () => values[Math.floor(next() / 0x1_0000_0000 * values.length)]!,
        ),
      )!,
  ).toSorted((left, right) => left - right);
  return {
    lower: Math.exp(samples[Math.floor(samples.length * 0.025)]!),
    upper: Math.exp(samples[Math.ceil(samples.length * 0.975) - 1]!),
  };
};
