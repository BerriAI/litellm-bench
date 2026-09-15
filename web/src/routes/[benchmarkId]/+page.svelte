<script lang="ts">
import DetailDashboard from "$lib/components/DetailDashboard.svelte";
import PageHeader from "$lib/components/PageHeader.svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{data.benchmark.label} · LiteLLM Benchmarks</title>
  <meta
    name="description"
    content={`Versioned ${data.benchmark.label} benchmark measurements`}
  />
</svelte:head>

<PageHeader
  eyebrow={`Performance / ${data.benchmark.kind}`}
  title={data.benchmark.label}
  description="Explore the latest published metrics for each LiteLLM version."
/>
<div data-benchmark-id={data.benchmark.id} class="benchmark-dashboard">
  {#key data.benchmark.id}
    <DetailDashboard
      benchmarkId={data.benchmark.id}
      records={data.records}
      annotations={data.annotations}
      knownVersions={data.knownVersions}
    />
  {/key}
</div>
