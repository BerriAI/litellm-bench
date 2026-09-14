import type { BenchmarkIndex, Metric } from "@litellm-bench/contracts/results";

export type BenchmarkRecord = BenchmarkIndex["records"][number];
export type BenchmarkSummary = BenchmarkIndex["benchmarks"][number];
export type { BenchmarkIndex, Metric };

export const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort(
    collator.compare,
  );
}

export function formatValue(value: number, unit: string): string {
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${unit}`;
}
