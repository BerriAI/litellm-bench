import assert from "node:assert/strict";
import test from "node:test";
import { parse, View } from "vega";
import { compile, type TopLevelSpec } from "vega-lite";
import { parseAnnotations } from "./annotationContract.ts";
import { annotationLayers, type BenchmarkAnnotation, resolveAnnotations } from "./annotations.ts";
import { detailSpec } from "./charts.ts";
import type { BenchmarkRecord } from "./data";
import { normalizedVersion, uniqueVersions } from "./versions.ts";

const metric = { id: "import.median", label: "Median", unit: "ms", better: "lower" as const };
const note: BenchmarkAnnotation = {
  id: "import-change",
  benchmark_id: "sdk-import-time",
  introduced_in: "1.200.0rc1",
  metric_id: "import.median",
  title: "Import change",
  explanation: "An explanation with evidence",
  sources: [{ label: "Evidence", url: "https://example.com/evidence" }],
};
const theme = {
  colors: { surface: "#fff", foreground: "#111", muted: "#777", border: "#ddd", accent: "#168" },
  series: ["#168", "#a32"],
  config: {},
};
function record(version: string, value: number | null): BenchmarkRecord {
  return {
    benchmark_id: "sdk-import-time",
    benchmark_label: "Python import time",
    kind: "sdk",
    created_at: "2026-09-13T20:45:07Z",
    source: {},
    version,
    status: "ok",
    record_id: "a".repeat(64),
    path: "record.json",
    metrics: value === null ? [] : [{ ...metric, value }],
    comparison_id: "b".repeat(64),
    case_id: "c".repeat(64),
    job: "base",
    canonical: true,
    platform: "linux",
  };
}
const records = [record("1.199.0", 100), record("1.200.0", 20), record("1.200.0", 40)];

test("orders Python and SemVer prereleases numerically before stable releases", () => {
  assert.equal(normalizedVersion("1.200-RC1"), "1.200.0-rc.1");
  assert.equal(normalizedVersion("1.200.0rc1"), "1.200.0-rc.1");
  assert.equal(normalizedVersion("unknown"), null);
  assert.deepEqual(
    uniqueVersions([
      "1.200.0",
      "1.200.0rc10",
      "1.200.0-rc.2",
      "1.199.9",
      "1.200.0b2",
      "1.200.0a1",
      "1.200.0",
    ]),
    ["1.199.9", "1.200.0a1", "1.200.0b2", "1.200.0-rc.2", "1.200.0rc10", "1.200.0"],
  );
});

test("resolves a filtered or unmeasured RC between visible stable releases", () => {
  const [result] = resolveAnnotations(records, [metric.id], [note]);
  assert.equal(result.version, "1.200.0");
  assert.equal(result.between, true);
  assert.equal(result.value, null);
  assert.equal(result.annotation.introduced_in, "1.200.0rc1");
  assert.equal(
    resolveAnnotations([record("1.198.0", 100), record("1.201.0", 20)], [metric.id], [note])[0]
      .version,
    "1.201.0",
  );
});

test("anchors an exact release to its median, excluding failed and nonfinite observations", () => {
  const result = resolveAnnotations(
    [
      ...records,
      record("1.200.0rc1", 30),
      record("1.200.0rc1", 50),
      record("1.200.0rc1", null),
      record("1.200.0rc1", Infinity),
      { ...record("1.200.0rc1", 1000), status: "failed" },
      { ...record("1.200.0rc1", 2000), benchmark_id: "sdk-package-size" },
    ],
    [metric.id],
    [note],
  );
  assert.equal(result[0].version, "1.200.0rc1");
  assert.equal(result[0].between, false);
  assert.equal(result[0].value, 40);
  assert.equal(
    resolveAnnotations([record("1.200.0-rc.1", 30)], [metric.id], [note])[0].between,
    false,
  );
});

test("hides out-of-range introductions and notes without successful scoped measurements", () => {
  for (
    const values of [records.slice(1), records.slice(0, 1), [], [record("unknown", 10)], [
      record("1.199.0", null),
      record("1.200.0", 20),
    ]]
  ) {
    assert.deepEqual(resolveAnnotations(values, [metric.id], [note]), []);
  }
  assert.deepEqual(resolveAnnotations(records, ["import.p95"], [note]), []);
  assert.deepEqual(
    resolveAnnotations(records, undefined, [{ ...note, metric_id: "import.p95" }]),
    [],
  );
  assert.deepEqual(resolveAnnotations(records, [], [note]), []);
});

test("keeps ambiguous configurations and benchmark-wide notes on the version axis", () => {
  const exact = [record(note.introduced_in, 10)];
  const { metric_id: _, ...benchmarkWide } = note;
  assert.equal(
    resolveAnnotations(exact, undefined, [benchmarkWide])[0].value,
    null,
  );
  assert.equal(
    resolveAnnotations([...exact, { ...exact[0], comparison_id: "aaaaaaaaaaaaaaaaaaaa" }], [
      metric.id,
    ], [note])[0].value,
    null,
  );
});

test("validates annotation data, scopes, unique ids, versions, and evidence links", () => {
  assert.deepEqual(parseAnnotations({ annotations: [note] }), [note]);
  for (
    const value of [
      {},
      { annotations: [note, note] },
      { annotations: [{ ...note, introduced_in: "unknown" }] },
      { annotations: [{ ...note, benchmark_id: "unknown" }] },
      { annotations: [{ ...note, metric_id: "package.wheel" }] },
      { annotations: [{ ...note, from_version: "1.0.0" }] },
      { annotations: [{ ...note, introduced_in: undefined }] },
      {
        annotations: [{ ...note, sources: [{ label: "Unsafe", url: "javascript:alert(1)" }] }],
      },
    ]
  ) assert.throws(() => parseAnnotations(value));
});

test("renders RC markers halfway between stable ticks without adding a release or changing metric domains", async () => {
  const resolved = resolveAnnotations(records, [metric.id], [note]);
  const spec: TopLevelSpec = {
    width: 400,
    height: 200,
    data: {
      values: records.map((item) => ({
        version: item.version,
        value: item.metrics[0]?.value,
        series: "Median",
      })),
    },
    encoding: {
      x: {
        field: "version",
        type: "ordinal",
        sort: [...uniqueVersions(records.map((item) => item.version))],
        scale: { type: "band", paddingInner: 0, paddingOuter: 0.5 },
      },
      color: { field: "series", type: "nominal" },
    },
    layer: [
      {
        mark: "point",
        encoding: { y: { field: "value", type: "quantitative", scale: { zero: false } } },
      },
      ...annotationLayers(resolved, "#192b32"),
    ],
  };
  const view = new View(parse(compile(spec).spec), { renderer: "none" });
  try {
    const svg = await view.toSVG();
    assert.match(svg, /\[1\]/);
    assert.match(svg, /introduced in 1.200.0rc1/);
    assert.match(svg, /https:\/\/example.com\/evidence/);
    assert.doesNotMatch(svg, /NaN|undefined/);
    assert.deepEqual(view.scale("x").domain(), ["1.199.0", "1.200.0"]);
    assert.deepEqual(view.scale("color").domain(), ["Median"]);
    assert.deepEqual(view.scale("y").domain(), [20, 100]);
    const scale = view.scale("x");
    const midpoint = (scale("1.199.0") + scale("1.200.0") + scale.bandwidth()) / 2;
    assert.match(svg, new RegExp(`transform="translate\\(${midpoint},[^)]+\\)"[^>]*>\\[1\\]`));
  } finally {
    view.finalize();
  }
});

test("detail charts receive annotations and retain semantic version order", async () => {
  const values = [...records, record("1.200.0rc10", 60), record("1.200.0rc2", 80)];
  const spec = detailSpec(
    note.benchmark_id,
    values,
    { title: "Import", description: "Import", unit: "ms", metricIds: [metric.id] },
    theme,
    [note],
  );
  assert.ok(spec);
  const view = new View(parse(compile(spec).spec), { renderer: "none" });
  try {
    const svg = await view.toSVG();
    assert.match(svg, /\[1\]/);
    assert.doesNotMatch(svg, /NaN|undefined/);
    assert.deepEqual(view.scale("x").domain(), [
      "1.199.0",
      "1.200.0rc2",
      "1.200.0rc10",
      "1.200.0",
    ]);
  } finally {
    view.finalize();
  }
});

test("places metric-specific introductions against the visible multi-metric version axis", () => {
  const intermediate = {
    ...record("1.199.1", 80),
    metrics: [{ ...metric, id: "import.p95", value: 80 }],
  };
  const [resolved] = resolveAnnotations(
    [...records, intermediate],
    [metric.id, "import.p95"],
    [{ ...note, introduced_in: "1.199.1rc1" }],
  );
  assert.equal(resolved.version, "1.199.1");
  assert.equal(resolved.between, true);
  assert.equal(resolved.value, null);
  const [exact] = resolveAnnotations(
    [...records, intermediate],
    [metric.id, "import.p95"],
    [{ ...note, introduced_in: "1.199.1" }],
  );
  assert.equal(exact.between, false);
  assert.equal(exact.value, null);
});
