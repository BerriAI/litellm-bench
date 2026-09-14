<script lang="ts">
import { base } from "$app/paths";
import { onMount } from "svelte";
import MultiSelect from "svelte-widgets/MultiSelect.svelte";
import RangeSlider from "svelte-widgets/RangeSlider.svelte";
import { type BenchmarkAnnotation, resolveAnnotations } from "../lib/annotations";
import { overviewSpec } from "../lib/charts";
import {
  type BenchmarkIndex,
  type BenchmarkRecord,
  loadAnnotations,
  loadIndex,
  unique,
} from "../lib/data";
import { isCanonical, observations } from "../lib/observations";
import { uniqueVersions } from "../lib/versions";
import ChartAnnotations from "./ChartAnnotations.svelte";
import VegaChart from "./VegaChart.svelte";

let annotations = $state.raw<BenchmarkAnnotation[]>([]);
let index = $state.raw<BenchmarkIndex>();
let records = $state.raw<BenchmarkRecord[]>([]);
let versions = $state.raw<string[]>([]);
let versionRange = $state<[number, number]>([0, 0]);
let selectedMetrics = $state<MetricOption[]>([]);
let chartBusy = $state(true);
let chartMessage = $state("Loading measurements…");
let chartState = $state<"loading" | "empty" | "error">("loading");

interface MetricOption {
  group: string;
  label: string;
  value: string;
}

const metricOptions = $derived.by(() => {
  const values = observations(records);
  return unique(values.map((item) => item.name)).map((name) => {
    const metric = values.find((item) => item.name === name)!;
    return {
      group: metric.benchmarkId,
      label: `${metric.metricId} — ${metric.label} (${metric.unit})`,
      value: name,
    };
  });
});

const versionRecords = $derived.by(() => {
  const selectedVersions = new Set(versions.slice(versionRange[0], versionRange[1] + 1));
  return records.filter((record) => record.version && selectedVersions.has(record.version));
});
const unavailableProxyBenchmarks = $derived.by(() =>
  unique(
    versionRecords.filter((record) => record.kind === "proxy").map((record) => record.benchmark_id),
  ).filter((benchmarkId) =>
    !versionRecords.some((record) =>
      record.benchmark_id === benchmarkId && record.status === "ok" && record.metrics.length
    )
  )
);
const selectedRecords = $derived.by(() => {
  const selectedNames = new Set(selectedMetrics.map((metric) => metric.value));
  return versionRecords.map((record) => ({
    ...record,
    metrics: record.metrics.filter((metric) =>
      selectedNames.has(`${record.benchmark_id}.${metric.id}`)
    ),
  }));
});

const spec = $derived(index ? overviewSpec(selectedRecords, undefined, annotations, base) : null);

$effect(() => {
  if (!index) return;
  chartBusy = Boolean(spec);
  chartState = spec ? "loading" : "empty";
  chartMessage = spec
    ? "Loading measurements…"
    : selectedMetrics.length
    ? "No measurements are available in this version range"
    : "Select at least one metric to draw the chart";
});

onMount(async () => {
  try {
    const [loadedIndex, loadedAnnotations] = await Promise.all([
      loadIndex(base),
      loadAnnotations(base),
    ]);
    annotations = loadedAnnotations;
    index = loadedIndex;
    records = (index.records ?? []).filter(isCanonical);
    versions = [...uniqueVersions(records.map((record) => record.version))];
    versionRange = [0, Math.max(0, versions.length - 1)];
    selectedMetrics = metricOptions;
  } catch {
    chartBusy = false;
    chartState = "error";
    chartMessage = "Unable to load benchmark data. Reload the page to try again.";
  }
});
</script>

<div class="panel" data-slot="panel">
  <div class="overview-controls">
    <div class="version-slider">
      {#if versions.length > 1}
        <RangeSlider
          class="version-range-slider"
          min={0}
          max={versions.length - 1}
          step={1}
          bind:value={versionRange}
          label="LiteLLM version range"
          lower_label="First LiteLLM version"
          upper_label="Last LiteLLM version"
          format_value={(value) => versions[Math.round(value)] ?? "—"}
          show_inputs={false}
          tick_count={2}
        />
      {:else}
        <p class="control-placeholder">Loading version range…</p>
      {/if}
    </div>
  </div>
  <div class="metric-picker">
    <label class="field-label" for="overview-metrics">Metrics</label>
    <MultiSelect
      class="metric-multiselect"
      id="overview-metrics"
      options={metricOptions}
      bind:value={selectedMetrics}
      placeholder="Select metrics"
      max_visible_chips={0}
      keep_selected_in_dropdown="checkboxes"
      select_all_option="Select all metrics"
      virtual_list
      allow_empty
      disabled={!index}
    />
  </div>
  <div
    id="overview-chart"
    role="region"
    aria-label="Benchmark metrics across versions"
    aria-busy={chartBusy}
  >
    {#if spec}
      <VegaChart
        {spec}
        label="Benchmark metrics across versions"
        onready={() => {
          chartMessage = "";
          chartBusy = false;
        }}
        onerror={() => {
          chartBusy = false;
          chartState = "error";
          chartMessage = "Unable to render measurements. Try another version range or reload the page.";
        }}
      />
    {/if}
  </div>
  {#if unavailableProxyBenchmarks.length}
    <p class="data-note" role="status">
      Proxy metrics unavailable for {unavailableProxyBenchmarks.join(", ")}: every selected run
      failed before producing measurements.
    </p>
  {/if}
  {#if chartMessage}<p
      id="overview-empty"
      class="status"
      data-slot="status"
      data-state={chartState}
      role="status"
      aria-live="polite"
    >
      {chartMessage}
    </p>{/if}
  <ChartAnnotations annotations={resolveAnnotations(selectedRecords, undefined, annotations)} />
  <div class="chart-legend" aria-label="Chart legend">
    <span class="legend-item"><i
        class="legend-mark"
        data-variant="point"
        aria-hidden="true"
      ></i>Individual run</span>
    <span class="legend-item"><i class="legend-mark" aria-hidden="true"></i>Median trend</span>
  </div>
</div>
