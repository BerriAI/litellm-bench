import assert from "node:assert/strict";
import test from "node:test";
import { compareRange } from "./comparisons.ts";
import type { BenchmarkRecord } from "./data";

function record(
  version: string,
  value: number,
  platform = "linux",
  status: "ok" | "failed" = "ok",
): BenchmarkRecord {
  const metric = { id: "latency", label: "Latency", unit: "ms", better: "lower" as const };
  return {
    benchmark_id: "sdk-import-time",
    benchmark_label: "Python import time",
    kind: "sdk",
    created_at: "2026-09-13T20:45:07Z",
    source: {},
    version,
    status,
    platform,
    record_id: "a".repeat(64),
    path: "record.json",
    metrics: [{ ...metric, value }],
    comparison_id: "b".repeat(64),
    case_id: (version === "1" ? "c" : "d").repeat(64),
    job: "base",
    canonical: true,
  };
}

test("compares endpoint medians without mixing environments or failed runs", () => {
  const result = compareRange(
    [
      record("1", 100),
      record("1", 200),
      record("2", 30),
      record("2", 60),
      record("2", 1000, "linux", "failed"),
      record("2", Infinity),
      { ...record("2", 9999, "macos"), canonical: false },
    ],
    "1",
    "2",
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].from, 150);
  assert.equal(result[0].to, 45);
  assert.equal(result[0].change, -70);
});

test("handles zero baselines and missing endpoints without inventing percentages", () => {
  assert.equal(compareRange([record("1", 0), record("2", 4)], "1", "2")[0].change, null);
  assert.deepEqual(compareRange([record("1", 2)], "1", "2"), []);
  assert.deepEqual(compareRange([record("1", 2)], "1", "1"), []);
});

test("matches different case IDs across releases but never changed configurations", () => {
  const first = record("1", 10);
  const last = record("2", 20);
  assert.notEqual(first.case_id, last.case_id);
  assert.equal(compareRange([first, last], "1", "2").length, 1);
  for (
    const changed of [
      { ...last, comparison_id: "aaaaaaaaaaaaaaaaaaaa" },
      { ...last, architecture: "arm64" },
      { ...last, metrics: last.metrics.map((metric) => ({ ...metric, unit: "seconds" })) },
    ]
  ) assert.deepEqual(compareRange([first, changed], "1", "2"), []);
});
