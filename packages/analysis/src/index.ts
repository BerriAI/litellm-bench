export interface NumericSummary {
  readonly count: number;
  readonly minimum: number;
  readonly median: number;
  readonly p95: number;
  readonly maximum: number;
}

export type SummaryResult =
  | { readonly _tag: "Summary"; readonly value: NumericSummary }
  | { readonly _tag: "NoFiniteValues" };

export interface MetricLike {
  readonly id: string;
  readonly value: number;
  readonly unit: string;
  readonly label?: string;
  readonly group?: string | null;
}

export interface RecordLike {
  readonly benchmark_id: string;
  readonly record_id: string;
  readonly comparison_id?: string | null;
  readonly job?: string | null;
  readonly canonical?: boolean | null;
  readonly platform?: string | null;
  readonly architecture?: string | null;
  readonly version?: string | null;
  readonly status: string;
  readonly metrics: readonly MetricLike[];
  readonly path?: string;
}

export interface CatalogBenchmarkLike {
  readonly canonicalJob: string;
}

export type CatalogLike = Readonly<Record<string, CatalogBenchmarkLike>>;

export interface Observation {
  readonly key: string;
  readonly name: string;
  readonly benchmarkId: string;
  readonly metricId: string;
  readonly label: string | undefined;
  readonly group: string | null | undefined;
  readonly unit: string;
  readonly value: number;
  readonly version: string;
  readonly job: string;
  readonly platform: string;
  readonly architecture: string;
  readonly configuration: string | null | undefined;
  readonly path: string | undefined;
}

export interface EndpointComparison extends Observation {
  readonly from: number;
  readonly to: number;
  readonly change: number | null;
}

export function median(values: readonly number[]): number | undefined {
  const finite = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (finite.length === 0) return undefined;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 1
    ? finite[middle] as number
    : ((finite[middle - 1] as number) + (finite[middle] as number)) / 2;
}

export function nearestRankP95(values: readonly number[]): number | undefined {
  const finite = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (finite.length === 0) return undefined;
  return finite[Math.max(0, Math.ceil(0.95 * finite.length) - 1)] as number;
}

export function summarize(values: readonly number[]): SummaryResult {
  const finite = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  const middle = median(finite);
  const p95 = nearestRankP95(finite);
  if (middle === undefined || p95 === undefined) return { _tag: "NoFiniteValues" };
  return {
    _tag: "Summary",
    value: {
      count: finite.length,
      minimum: finite[0] as number,
      median: middle,
      p95,
      maximum: finite[finite.length - 1] as number,
    },
  };
}

const unitFactors = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  s: 1,
  ms: 0.001,
  us: 0.000001,
  ns: 0.000000001,
} as const;

export type ConvertibleUnit = keyof typeof unitFactors;
export type UnitConversion =
  | { readonly _tag: "Converted"; readonly value: number }
  | {
    readonly _tag: "IncompatibleUnits";
    readonly from: ConvertibleUnit;
    readonly to: ConvertibleUnit;
  };

function unitFamily(unit: ConvertibleUnit): "bytes" | "time" {
  return ["B", "KiB", "MiB", "GiB"].includes(unit) ? "bytes" : "time";
}

export function convertUnit(
  value: number,
  from: ConvertibleUnit,
  to: ConvertibleUnit,
): UnitConversion {
  if (unitFamily(from) !== unitFamily(to)) return { _tag: "IncompatibleUnits", from, to };
  return { _tag: "Converted", value: value * unitFactors[from] / unitFactors[to] };
}

export function isCanonical(record: RecordLike, catalog: CatalogLike): boolean {
  const benchmark = catalog[record.benchmark_id];
  return Boolean(benchmark && record.canonical === true);
}

export function seriesKey(record: RecordLike, metric: MetricLike): string {
  return JSON.stringify([
    record.benchmark_id,
    metric.id,
    metric.unit,
    metric.group ?? null,
    record.comparison_id ?? record.record_id,
    record.platform ?? null,
    record.architecture ?? null,
  ]);
}

export function observations(
  records: readonly RecordLike[],
  catalog: CatalogLike,
): readonly Observation[] {
  return records
    .filter((record) =>
      isCanonical(record, catalog) && record.status === "ok" && Boolean(record.version)
    )
    .flatMap((record) =>
      record.metrics
        .filter((metric) => Number.isFinite(metric.value))
        .map((metric) => ({
          key: seriesKey(record, metric),
          name: `${record.benchmark_id}.${metric.id}`,
          benchmarkId: record.benchmark_id,
          metricId: metric.id,
          label: metric.label,
          group: metric.group,
          unit: metric.unit,
          value: metric.value,
          version: record.version as string,
          job: record.job ?? "Unknown job",
          platform: record.platform ?? "Unknown platform",
          architecture: record.architecture ?? "Unknown architecture",
          configuration: record.comparison_id,
          path: record.path,
        }))
    );
}

export function compareEndpoints(
  records: readonly RecordLike[],
  catalog: CatalogLike,
  start: string,
  end: string,
): readonly EndpointComparison[] {
  if (!start || start === end) return [];
  const values = observations(records, catalog);
  return [...new Set(values.map((item) => item.key))].flatMap((key) => {
    const series = values.filter((item) => item.key === key);
    const from = median(series.filter((item) => item.version === start).map((item) => item.value));
    const to = median(series.filter((item) => item.version === end).map((item) => item.value));
    if (from === undefined || to === undefined) return [];
    const exemplar = series[0];
    if (!exemplar) return [];
    return [{
      ...exemplar,
      from,
      to,
      change: from === 0 ? null : (to - from) / Math.abs(from) * 100,
    }];
  });
}

export * from "./paired.js";
