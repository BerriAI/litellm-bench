import assert from "node:assert/strict";
import test from "node:test";
import {
  compareEndpoints,
  convertUnit,
  nearestRankP95,
  type RecordLike,
  summarize,
} from "./index.js";
import { pairedRatios } from "./paired.js";

const catalog = { bench: { canonicalJob: "base" } } as const;
function record(version: string, value: number, overrides: Partial<RecordLike> = {}): RecordLike {
  return {
    benchmark_id: "bench",
    record_id: `${version}-${value}`,
    comparison_id: "same-config",
    job: "base",
    canonical: true,
    platform: "linux",
    architecture: "x86_64",
    version,
    status: "ok",
    metrics: [{ id: "latency", value, unit: "ms" }],
    ...overrides,
  };
}

test("summarizes finite values with nearest-rank p95", () => {
  assert.deepEqual(summarize([0.4, 0.1, 0.3, 0.2, Number.NaN]), {
    _tag: "Summary",
    value: { count: 4, minimum: 0.1, median: 0.25, p95: 0.4, maximum: 0.4 },
  });
  assert.equal(nearestRankP95(Array.from({ length: 20 }, (_, index) => index + 1)), 19);
  assert.deepEqual(summarize([]), { _tag: "NoFiniteValues" });
});

test("converts time and binary byte units but rejects cross-family conversion", () => {
  assert.deepEqual(convertUnit(1, "s", "ms"), { _tag: "Converted", value: 1000 });
  assert.deepEqual(convertUnit(1048576, "B", "MiB"), { _tag: "Converted", value: 1 });
  assert.equal(convertUnit(1, "s", "MiB")._tag, "IncompatibleUnits");
});

test("compares endpoint medians without mixing configurations or failed observations", () => {
  const result = compareEndpoints(
    [
      record("1", 100),
      record("1", 200),
      record("2", 30),
      record("2", 60),
      record("2", 1000, { status: "failed" }),
      record("2", 9999, { comparison_id: "changed" }),
    ],
    catalog,
    "1",
    "2",
  );
  assert.equal(result.length, 1);
  const comparison = result[0];
  assert.ok(comparison);
  assert.deepEqual({ from: comparison.from, to: comparison.to, change: comparison.change }, {
    from: 150,
    to: 45,
    change: -70,
  });
});

test("pairs explicitly and reports duplicates, missing partners, and zero denominators", () => {
  const left = [{ round: 1, rps: 10 }, { round: 2, rps: 20 }];
  const right = [{ round: 2, rps: 40 }, { round: 1, rps: 15 }];
  const result = pairedRatios(left, right, (row) => String(row.round), (row) => row.rps);
  assert.equal(result._tag, "Ratios");
  if (result._tag === "Ratios") {
    assert.deepEqual(result.value.pairs.map((pair) => pair.ratio), [1.5, 2]);
    assert.equal(result.value.summary.median, 1.75);
    assert.equal(result.value.rightWins, 2);
  }
  const first = left[0] as { readonly round: number; readonly rps: number };
  assert.equal(
    pairedRatios([first, first], right, (row) => String(row.round), (row) => row.rps)._tag,
    "DuplicateKey",
  );
  assert.equal(
    pairedRatios(left.slice(0, 1), right, (row) => String(row.round), (row) => row.rps)._tag,
    "UnmatchedKeys",
  );
  const matchingRight = right[1] as { readonly round: number; readonly rps: number };
  assert.equal(
    pairedRatios(
      [{ round: 1, rps: 0 }],
      [matchingRight],
      (row) => String(row.round),
      (row) => row.rps,
    )._tag,
    "InvalidDenominator",
  );
});
