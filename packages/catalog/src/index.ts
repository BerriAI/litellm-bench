export { benchmarkCatalog } from "./generated.js";
export type {
  BenchmarkCatalog,
  BenchmarkCatalogEntry,
  CatalogBuildResult,
  CatalogIssue,
  CatalogMetric,
  LocatedBenchmarkDefinition,
} from "./model.js";

import { benchmarkCatalog } from "./generated.js";

export type BenchmarkId = keyof typeof benchmarkCatalog;
type BenchmarkMetrics<I extends BenchmarkId> = (typeof benchmarkCatalog)[I]["metrics"];

export type BenchmarkMetricId<I extends BenchmarkId> = Extract<keyof BenchmarkMetrics<I>, string>;
export type BenchmarkUnit<I extends BenchmarkId> = {
  [M in BenchmarkMetricId<I>]: BenchmarkMetrics<I>[M] extends
    { readonly unit: infer U extends string } ? U
    : never;
}[BenchmarkMetricId<I>];
export type BenchmarkMetricIdForUnit<
  I extends BenchmarkId,
  U extends BenchmarkUnit<I>,
> = {
  [M in BenchmarkMetricId<I>]: BenchmarkMetrics<I>[M] extends { readonly unit: U } ? M : never;
}[BenchmarkMetricId<I>];
