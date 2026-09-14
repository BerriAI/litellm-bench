<script lang="ts">
import { onMount } from "svelte";
import { readChartTheme } from "../../styles/charts";
import type { BenchmarkAnnotation, ResolvedAnnotation } from "../annotations";
import { type DetailChartDefinition, detailSpec } from "../charts";
import type { BenchmarkRecord } from "../data";
import ChartAnnotations from "./ChartAnnotations.svelte";
import VegaChart from "./VegaChart.svelte";

let { benchmarkId, records, definition, annotations, resolvedAnnotations }: {
  benchmarkId: string;
  records: BenchmarkRecord[];
  definition: DetailChartDefinition;
  annotations: BenchmarkAnnotation[];
  resolvedAnnotations: ResolvedAnnotation[];
} = $props();
let spec = $state.raw<ReturnType<typeof detailSpec>>(null);
let status = $state<"loading" | "ready" | "error">("loading");
onMount(() => {
  try {
    spec = detailSpec(benchmarkId, records, definition, readChartTheme(), annotations);
  } catch {
    status = "error";
  }
});
</script>

<article class="panel" data-slot="panel" aria-busy={status === "loading"}>
  <div class="chart-heading">
    <div>
      <p class="eyebrow">Version history</p>
      <h3 class="chart-title">{definition.title}</h3>
    </div>
    <p class="chart-description">{definition.description}</p>
  </div>
  {#if spec}
    <VegaChart
      {spec}
      label={definition.title}
      onready={() => status = "ready"}
      onerror={() => status = "error"}
    />
  {/if}
  {#if status === "error"}
    <p class="status" data-slot="status" data-state="error" role="status">
      Unable to render measurements. Try another version range or reload the page.
    </p>
  {:else if status === "loading"}
    <p class="status" data-slot="status" data-state="loading" role="status">Loading chart…</p>
  {/if}
  <ChartAnnotations annotations={resolvedAnnotations} />
</article>
