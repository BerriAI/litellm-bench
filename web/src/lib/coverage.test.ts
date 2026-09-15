import assert from "node:assert/strict";
import test from "node:test";

import { benchmarkCoverage } from "./coverage.ts";
import type { BenchmarkRecord } from "./data.ts";

const record = (
  version: string,
  status: "ok" | "failed",
  overrides: Partial<BenchmarkRecord> = {},
): BenchmarkRecord => ({
  record_id: "a".repeat(64),
  comparison_id: "b".repeat(64),
  case_id: "c".repeat(64),
  benchmark_id: "proxy-chat-completions",
  benchmark_label: "Proxy chat",
  kind: "proxy",
  status,
  path: `results/${version}/proxy-chat-completions/${status}.json`,
  metrics: status === "ok"
    ? [{ id: "nonstream.sustainable_rps", label: "RPS", value: 100, unit: "RPS", better: "higher" }]
    : [],
  created_at: "2026-09-13T20:45:07Z",
  job: "base",
  canonical: true,
  version,
  source: {},
  ...(status === "failed"
    ? { failure: { code: "invalid_observation", message: "k6 exited with 99" } }
    : {}),
  ...overrides,
});

test("classifies every known version as published, failed, or missing in version order", () => {
  const coverage = benchmarkCoverage(
    [record("1.100.0", "ok"), record("1.99.0", "failed")],
    ["1.100.1", "1.100.0", "1.99.0", "1.98.0"],
  );
  assert.deepEqual(
    coverage.versions.map(({ version, state }) => [version, state]),
    [
      ["1.98.0", "missing"],
      ["1.99.0", "failed"],
      ["1.100.0", "published"],
      ["1.100.1", "missing"],
    ],
  );
  assert.equal(coverage.published, 1);
  assert.equal(coverage.failed, 1);
  assert.equal(coverage.missing, 2);
  assert.equal(coverage.versions[1]?.detail, "base: invalid_observation — k6 exited with 99");
  assert.match(coverage.versions[0]?.detail ?? "", /No canonical result/);
});

test("a version is published when any canonical run succeeded, and failed reruns stay visible", () => {
  const coverage = benchmarkCoverage(
    [
      record("1.100.0", "ok", { created_at: "2026-09-13T20:00:00Z" }),
      record("1.100.0", "failed", { created_at: "2026-09-13T21:00:00Z" }),
    ],
    [],
  );
  assert.equal(coverage.versions[0]?.state, "published");
  assert.equal(coverage.versions[0]?.detail, "1 successful, 1 failed");
  assert.equal(coverage.versions[0]?.records[0]?.status, "failed");
});

test("non-canonical runs do not count as coverage", () => {
  const coverage = benchmarkCoverage([record("1.100.0", "ok", { canonical: false })], []);
  assert.deepEqual(coverage.versions.map(({ state }) => state), ["missing"]);
});

test("failed records without a structured error still explain themselves", () => {
  const failed = record("1.100.0", "failed");
  const { failure: _omitted, ...withoutFailure } = failed;
  const coverage = benchmarkCoverage([withoutFailure], []);
  assert.equal(coverage.versions[0]?.detail, "base: failed without a recorded error");
});
