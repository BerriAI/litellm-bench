import type { BenchmarkIndex, Metric } from "@litellm-bench/contracts/results";

export type BenchmarkRecord = BenchmarkIndex["records"][number];
export type BenchmarkSummary = BenchmarkIndex["benchmarks"][number];
export type { BenchmarkIndex, Metric };

export type Fetcher = (input: string) => Promise<Pick<Response, "json" | "ok" | "status">>;

export const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort(
    collator.compare,
  );
}

export function withBase(path: string, base = ""): string {
  return `${base.replace(/\/$/, "")}/${path}`;
}

export function element<T extends Element>(selector: string): T {
  const match = document.querySelector<T>(selector);
  if (!match) throw new Error(`Missing dashboard element: ${selector}`);
  return match;
}

export async function loadIndex(base = "", fetcher: Fetcher = fetch): Promise<BenchmarkIndex> {
  const response = await fetcher(withBase("data/index.json", base));
  if (!response.ok) throw new Error(`Unable to load result index: ${response.status}`);
  const { parseIndex } = await import("./indexContract.ts");
  return parseIndex(await response.json());
}

export function formatValue(value: number, unit: string): string {
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${unit}`;
}

export async function loadAnnotations(base = "", fetcher: Fetcher = fetch) {
  const response = await fetcher(withBase("data/annotations.json", base));
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Unable to load annotations: ${response.status}`);
  const { parseAnnotations } = await import("./annotationContract.ts");
  return parseAnnotations(await response.json());
}
