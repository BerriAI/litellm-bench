<script lang="ts">
import { type BenchmarkAnnotation, resolveAnnotations } from "../annotations";
import { detailDefinitions } from "../charts";
import { compareRange } from "../comparisons";
import type { MetricOption } from "../dashboard";
import { type BenchmarkRecord, unique } from "../data";
import { isCanonical, observations } from "../observations";
import { uniqueVersions } from "../versions";
import ChartPanel from "./ChartPanel.svelte";
import DashboardControls from "./DashboardControls.svelte";
import RangeComparison from "./RangeComparison.svelte";

let { benchmarkId, records, annotations }: {
  benchmarkId: string;
  records: BenchmarkRecord[];
  annotations: BenchmarkAnnotation[];
} = $props();
const versions = $derived([...uniqueVersions(records.map((record) => record.version))]);
let range = $state<[number, number]>();
let metrics = $state<MetricOption[]>();
let versionRange: [number, number] = $derived(range ?? [0, Math.max(0, versions.length - 1)]);

const metricOptions = $derived.by(() => {
  const values = observations(records.filter(isCanonical));
  return unique(values.map((metric) => metric.metricId)).map((metricId) => {
    const metric = values.find((item) => item.metricId === metricId)!;
    return {
      group: metric.unit,
      label: `${metric.label} (${metric.unit})`,
      value: metricId,
    };
  });
});
let selectedMetrics = $derived(metrics ?? metricOptions);
const start = $derived(versions[versionRange[0]] ?? "");
const end = $derived(versions[versionRange[1]] ?? start);
const selectedRecords = $derived.by(() => {
  const selected = new Set(versions.slice(versionRange[0], versionRange[1] + 1));
  return records.filter((record) => record.version && selected.has(record.version));
});
const canonicalRecords = $derived.by(() => {
  const selectedMetricIds = new Set(selectedMetrics.map((metric) => metric.value));
  return selectedRecords.filter(isCanonical).map((record) => ({
    ...record,
    metrics: record.metrics.filter((metric) => selectedMetricIds.has(metric.id)),
  }));
});
const chartItems = $derived(
  detailDefinitions(benchmarkId, canonicalRecords)
    .filter((definition) =>
      canonicalRecords.some((record) =>
        record.metrics.some((metric) =>
          definition.metricIds.includes(metric.id) && metric.unit === definition.unit
        )
      )
    )
    .map((definition) => ({
      definition,
      records: canonicalRecords,
      annotations: resolveAnnotations(canonicalRecords, definition.metricIds, annotations),
    })),
);
const comparisons = $derived(compareRange(canonicalRecords, start, end));
const metricCount = $derived(
  unique(observations(canonicalRecords).map((metric) => metric.name)).length,
);
</script>

<section class="summary" data-slot="summary" data-variant="three" aria-label="Benchmark summary">
  {#each [
    {
      id: "detail-run-count",
      label: "Results in selected range",
      value: selectedRecords.length,
    },
    {
      id: "detail-version-count",
      label: "LiteLLM versions",
      value: unique(selectedRecords.map((record) => record.version)).length,
    },
    {
      id: "detail-metric-count",
      label: "Metrics in selected range",
      value: metricCount,
    },
  ] as item}
    <div class="summary-item" data-slot="summary-item">
      <span class="summary-label">{item.label}</span>
      <strong id={item.id} class="summary-value">{item.value ?? "…"}</strong>
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
  <DashboardControls
    {versions}
    {metricOptions}
    bind:versionRange={() => versionRange, (value) => range = value}
    bind:selectedMetrics={() => selectedMetrics, (value) => metrics = value}
  />
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
  >
    {#each chartItems as item (item)}
      <ChartPanel
        {benchmarkId}
        records={item.records}
        definition={item.definition}
        {annotations}
        resolvedAnnotations={item.annotations}
      />
    {/each}
  </div>
  {#if !chartItems.length}
    <p id="detail-empty" class="status" data-slot="status" data-state="empty" role="status">
      {
        !metricOptions.length || selectedMetrics.length
        ? "No successful canonical Linux measurements are available in this version range"
        : "Select at least one metric to draw the charts"
      }
    </p>
  {/if}
</section>
