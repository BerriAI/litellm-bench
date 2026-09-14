<script lang="ts">
import { base } from "$app/paths";
import { onMount } from "svelte";
import { type BenchmarkAnnotation, resolveAnnotations } from "../lib/annotations";
import { overviewSpec } from "../lib/charts";
import {
  type BenchmarkIndex,
  type BenchmarkRecord,
  loadAnnotations,
  loadIndex,
  unique,
  withBase,
} from "../lib/data";
import { isCanonical, observations } from "../lib/observations";
import { uniqueVersions } from "../lib/versions";
import ChartAnnotations from "./ChartAnnotations.svelte";
import VegaChart from "./VegaChart.svelte";

let annotations = $state.raw<BenchmarkAnnotation[]>([]);
let index = $state.raw<BenchmarkIndex>();
let records = $state.raw<BenchmarkRecord[]>([]);
let versions = $state.raw<string[]>([]);
let start = $state("");
let end = $state("");
let chartBusy = $state(true);
let chartMessage = $state("Loading measurements…");
let chartState = $state<"loading" | "empty" | "error">("loading");

const selectedRecords = $derived.by(() => {
  const selected = new Set(versions.slice(versions.indexOf(start), versions.indexOf(end) + 1));
  return records.filter((record) => record.version && selected.has(record.version));
});
function changeStart(): void {
  if (versions.indexOf(start) > versions.indexOf(end)) end = start;
}

function changeEnd(): void {
  if (versions.indexOf(end) < versions.indexOf(start)) start = end;
}

const metricLinks = $derived.by(() => {
  const values = observations(selectedRecords);
  return unique(values.map((item) => item.name)).map((name) =>
    values.find((item) => item.name === name)!
  );
});

const spec = $derived(index ? overviewSpec(selectedRecords, undefined, annotations, base) : null);

$effect(() => {
  if (!index) return;
  chartBusy = Boolean(spec);
  chartState = spec ? "loading" : "empty";
  chartMessage = spec
    ? "Loading measurements…"
    : "No measurements are available in this version range";
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
    start = versions[0] ?? "";
    end = versions.at(-1) ?? start;
  } catch {
    chartBusy = false;
    chartState = "error";
    chartMessage = "Unable to load benchmark data. Reload the page to try again.";
  }
});
</script>

<div class="panel" data-slot="panel">
  <fieldset class="version-range" data-slot="version-range">
    <legend>LiteLLM version range</legend>
    <label class="version-field"><span class="field-label">From version</span>
      <select
        aria-label="First LiteLLM version"
        class="select"
        bind:value={start}
        onchange={changeStart}
        disabled={versions.length <= 1}
      >
        {#each versions as version}<option value={version}>{version}</option>{/each}
      </select>
    </label>
    <label class="version-field"><span class="field-label">To version</span>
      <select
        aria-label="Last LiteLLM version"
        class="select"
        bind:value={end}
        onchange={changeEnd}
        disabled={versions.length <= 1}
      >
        {#each versions as version}<option value={version}>{version}</option>{/each}
      </select>
    </label>
  </fieldset>
  <p class="chart-description">
    Select a metric point to explore its benchmark. Each chart has its own scale. Trends use
    matching host configurations.
  </p>
  <nav class="metric-links" aria-label="Metrics">
    {#each metricLinks as metric (metric.name)}
      <a href={withBase(`${metric.benchmarkId}/`, base)}>{metric.name} <span>· {metric.label} · {
            metric.unit
          }</span></a>
    {/each}
  </nav>
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
