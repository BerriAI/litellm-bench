import { compareEndpoints } from "@litellm-bench/analysis";
import { benchmarkCatalog } from "@litellm-bench/catalog";
import type { BenchmarkRecord } from "./data";

export const compareRange = (records: readonly BenchmarkRecord[], start: string, end: string) =>
  compareEndpoints(records, benchmarkCatalog, start, end).map((comparison) => ({
    ...comparison,
    label: comparison.label ?? comparison.metricId,
    environment: [
      comparison.job,
      comparison.platform,
      comparison.architecture,
      comparison.configuration,
      comparison.group,
    ].filter(Boolean).join(" · "),
  }));
