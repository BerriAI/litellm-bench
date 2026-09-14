import {
  isCanonical as sharedIsCanonical,
  median,
  observations as sharedObservations,
  seriesKey,
} from "@litellm-bench/analysis";
import { benchmarkCatalog } from "@litellm-bench/catalog";
import type { BenchmarkRecord } from "./data";

export { median, seriesKey };

export const isCanonical = (record: BenchmarkRecord): boolean =>
  sharedIsCanonical(record, benchmarkCatalog);

export const observations = (records: readonly BenchmarkRecord[]) =>
  sharedObservations(records, benchmarkCatalog).map((observation) => ({
    ...observation,
    label: observation.label ?? observation.metricId,
    environment: [
      observation.job,
      observation.platform,
      observation.architecture,
      observation.configuration,
      observation.group,
    ].filter(Boolean).join(" · "),
  }));
