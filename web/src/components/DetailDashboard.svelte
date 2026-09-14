<script lang="ts">
import { base } from "$app/paths";
import { onMount } from "svelte";
import { type BenchmarkAnnotation, resolveAnnotations } from "../lib/annotations";
import { detailDefinitions, detailSpec } from "../lib/charts";
import { compareRange } from "../lib/comparisons";
import {
  type BenchmarkIndex,
  type BenchmarkRecord,
  formatValue,
  loadAnnotations,
  loadIndex,
  unique,
  withBase,
} from "../lib/data";
import { isCanonical, observations } from "../lib/observations";
import { uniqueVersions } from "../lib/versions";
import ChartAnnotations from "./ChartAnnotations.svelte";
import RangeComparison from "./RangeComparison.svelte";
import VegaChart from "./VegaChart.svelte";

let { benchmarkId }: { benchmarkId: string } = $props();
let annotations = $state.raw<BenchmarkAnnotation[]>([]);
let index = $state.raw<BenchmarkIndex>();
let records = $state.raw<BenchmarkRecord[]>([]);
let versions = $state.raw<string[]>([]);
let start = $state("");
let end = $state("");
let loadFailed = $state(false);
let renderFailed = $state(false);
let readyCount = $state(0);

const selectedRecords = $derived.by(() => {
  const selected = new Set(versions.slice(versions.indexOf(start), versions.indexOf(end) + 1));
  return records.filter((record) => record.version && selected.has(record.version));
});
const canonicalRecords = $derived(selectedRecords.filter(isCanonical));
const chartItems = $derived.by(() => {
  if (typeof getComputedStyle === "undefined") return [];
  return detailDefinitions(benchmarkId, canonicalRecords).flatMap((definition) => {
    const spec = detailSpec(benchmarkId, canonicalRecords, definition, undefined, annotations);
    return spec
      ? [{
        definition,
        spec,
        annotations: resolveAnnotations(canonicalRecords, definition.metricIds, annotations),
      }]
      : [];
  });
});
const comparisons = $derived(compareRange(canonicalRecords, start, end));
const metricCount = $derived(
  unique(observations(canonicalRecords).map((metric) => metric.name)).length,
);
const chartBusy = $derived(Boolean(index && chartItems.length && readyCount < chartItems.length));

function changeStart(): void {
  if (versions.indexOf(start) > versions.indexOf(end)) end = start;
}

function changeEnd(): void {
  if (versions.indexOf(end) < versions.indexOf(start)) start = end;
}

$effect(() => {
  start;
  end;
  readyCount = 0;
  renderFailed = false;
});

onMount(async () => {
  try {
    const [loadedIndex, loadedAnnotations] = await Promise.all([
      loadIndex(base),
      loadAnnotations(base),
    ]);
    annotations = loadedAnnotations;
    index = loadedIndex;
    records = (index.records ?? []).filter((record) => record.benchmark_id === benchmarkId);
    versions = [...uniqueVersions(records.map((record) => record.version))];
    start = versions[0] ?? "";
    end = versions.at(-1) ?? start;
  } catch {
    loadFailed = true;
  }
});
</script>

<section class="summary" data-slot="summary" data-variant="three" aria-label="Benchmark summary">
  {#each [
    {
      id: "detail-run-count",
      label: "Runs in selected range",
      value: loadFailed ? "Unavailable" : index ? selectedRecords.length : undefined,
    },
    {
      id: "detail-version-count",
      label: "LiteLLM versions",
      value: loadFailed
        ? "Unavailable"
        : index
        ? unique(selectedRecords.map((record) => record.version)).length
        : undefined,
    },
    {
      id: "detail-metric-count",
      label: "Metrics in selected range",
      value: loadFailed ? "Unavailable" : index ? metricCount : undefined,
    },
  ] as item}
    <div class="summary-item" data-slot="summary-item">
      <span class="summary-label">{item.label}</span>
      <strong id={item.id} class="summary-value" data-format={loadFailed ? "text" : undefined}>{
        item.value ?? "…"
      }</strong>
    </div>
  {/each}
</section>

<section class="dashboard-section" aria-labelledby="results-title">
  <div class="section-intro">
    <div>
      <p class="eyebrow">Detailed measurements</p>
      <h2 id="results-title">Version history</h2>
    </div>
    <div class="section-description">
      <p>
        Compare published metrics across releases. Charts use canonical Linux runs. Hover over a
        point for its measurement and configuration.
      </p>
    </div>
  </div>
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
  {#if start !== end}
    <section class="range-comparison" aria-label="Selected version comparison">
      <h3>{start} / {end}</h3>
      <p class="chart-description">
        Median measurements in matching environments. Percentage change is relative to {start}.
      </p>
      {#each comparisons as comparison (comparison.key)}
        <div class="comparison-row">
          <div><strong>{comparison.label}</strong><small>{comparison.environment}</small></div>
          <div>
            <RangeComparison from={comparison.from} to={comparison.to} unit={comparison.unit} />
          </div>
          <strong>{
            comparison.change === null
            ? "No percentage baseline"
            : `${comparison.change > 0 ? "+" : ""}${comparison.change.toFixed(1)}%`
          }</strong>
        </div>
      {:else}
        <p class="chart-description">No matching measurements at both selected versions.</p>
      {/each}
    </section>
  {/if}
  <div
    id="detail-charts"
    role="region"
    class="chart-stack"
    aria-label="Benchmark measurements"
    aria-busy={chartBusy}
  >
    {#each chartItems as item (`${item.definition.title}:${item.definition.unit}`)}
      <article class="panel" data-slot="panel">
        <div class="chart-heading">
          <div>
            <p class="eyebrow">Version history</p>
            <h3 class="chart-title">{item.definition.title}</h3>
          </div>
          <p class="chart-description">{item.definition.description}</p>
        </div>
        <VegaChart
          spec={item.spec}
          label={item.definition.title}
          onready={() => readyCount += 1}
          onerror={() => renderFailed = true}
        />
        <ChartAnnotations annotations={item.annotations} />
      </article>
    {/each}
  </div>
  {#if loadFailed}
    <p id="detail-empty" class="status" data-slot="status" data-state="error" role="status">
      Unable to load benchmark data. Reload the page to try again.
    </p>
  {:else if renderFailed}
    <p id="detail-empty" class="status" data-slot="status" data-state="error" role="status">
      Unable to render measurements. Try another version range or reload the page.
    </p>
  {:else if !index}
    <p id="detail-empty" class="status" data-slot="status" data-state="loading" role="status">
      Loading measurements…
    </p>
  {:else if !chartItems.length}
    <p id="detail-empty" class="status" data-slot="status" data-state="empty" role="status">
      No successful canonical Linux measurements are available in this version range
    </p>
  {/if}
</section>

<section class="dashboard-section" aria-labelledby="detail-runs-title">
  <div class="section-intro">
    <div>
      <p class="eyebrow">Audit trail</p>
      <h2 id="detail-runs-title">Run records</h2>
    </div>
  </div>
  <div class="panel" data-slot="panel" data-variant="runs">
    <div class="run-header" aria-hidden="true">
      <span>Version</span><span>Environment</span><span>Status</span>
    </div>
    <div id="detail-run-list" data-slot="run-list">
      {#if loadFailed}<p class="status" data-slot="status" data-state="error" role="status">
          Run records unavailable
        </p>
      {:else if !index}<p class="status" data-slot="status" data-state="loading" role="status">
          Loading run records…
        </p>
      {:else if !records.length}<p
          class="status"
          data-slot="status"
          data-state="empty"
          role="status"
        >
          No run records are available yet
        </p>
      {:else}{#each selectedRecords as record (record.record_id)}
          <details class="run-record">
            <summary class="run-row" data-slot="run-row">
              <strong class="run-title">{record.version ?? "Unknown version"}</strong>
              <span class="run-detail">{record.job ?? "default"} · {
                  record.platform ?? "unknown platform"
                }{isCanonical(record) ? "" : " · Audit only"}</span>
              <b class="run-value">{record.status === "ok" ? "Passed" : "Failed"}</b>
            </summary>
            <dl class="run-metrics">
              {#each record.metrics as metric (metric.id)}
                <div>
                  <dt>{metric.label}</dt>
                  <dd>{formatValue(metric.value, metric.unit)}</dd>
                </div>
              {/each}
              <div>
                <dt>Source</dt>
                <dd><a href={withBase(`data/${record.path}`, base)}>Raw record</a></dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{record.status}</dd>
              </div>
            </dl>
          </details>
        {/each}{/if}
    </div>
  </div>
</section>
