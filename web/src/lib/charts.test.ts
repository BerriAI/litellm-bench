import { benchmarkCatalog } from "@litellm-bench/catalog";
import assert from "node:assert/strict";
import test from "node:test";
import { parse, View } from "vega";
import { compile, type TopLevelSpec } from "vega-lite";
import { detailDefinitions, detailSpec } from "./charts.ts";
import type { BenchmarkRecord, Metric } from "./data";

const theme = {
  colors: { surface: "#fff", foreground: "#111", muted: "#777", border: "#ddd", accent: "#168" },
  series: ["#168", "#a32"],
  config: {},
};
function record(benchmark = "sdk-import-time", version = "1", value = 10): BenchmarkRecord {
  return {
    record_id: `${benchmark}-${version}-${value}`,
    benchmark_label: benchmark,
    kind: benchmark.startsWith("proxy") ? "proxy" : "sdk",
    created_at: "2026-09-13T20:45:07Z",
    source: {},
    benchmark_id: benchmark,
    version,
    case_id: "c".repeat(64),
    comparison_id: "b".repeat(64),
    job: "base",
    canonical: true,
    platform: "linux",
    architecture: "x86_64",
    status: "ok",
    path: "record.json",
    metrics: [{ id: "shared", label: "Shared", value, unit: "ms", better: "lower" }],
  };
}
async function render(spec: TopLevelSpec) {
  const view = new View(parse(compile(spec).spec), { renderer: "none" });
  try {
    return await view.toSVG();
  } finally {
    view.finalize();
  }
}

test("all OCR metrics are charted once and uncovered metrics get isolated fallback charts", async () => {
  const metrics: Metric[] = Object.entries(benchmarkCatalog["proxy-ocr"].metrics).map((
    [id, metric],
  ) => ({ ...metric, id, label: id, value: 10 }));
  const ocr = { ...record("proxy-ocr"), metrics };
  const definitions = detailDefinitions("proxy-ocr", [ocr, record()]);
  assert.equal(definitions.length, 12);
  assert.deepEqual(
    definitions.flatMap((item) => item.metricIds).sort(),
    metrics.map((item) => item.id).sort(),
  );
  for (const definition of definitions) {
    const spec = detailSpec("proxy-ocr", [ocr, record()], definition, theme);
    assert.ok(spec);
    assert.doesNotMatch(await render(spec), /NaN|undefined|sdk-import-time/);
  }
  const extended = {
    ...ocr,
    metrics: [
      ...metrics,
      { id: "future", label: "Future", unit: "ms", value: 3, better: "neutral" as const },
    ],
  };
  const fallback = detailDefinitions("proxy-ocr", [extended, extended, record()]);
  assert.equal(fallback.length, 13);
  assert.deepEqual(fallback.at(-1)?.metricIds, ["future"]);
  assert.equal(detailSpec("proxy-ocr", [record()], definitions[0], theme), null);
});
