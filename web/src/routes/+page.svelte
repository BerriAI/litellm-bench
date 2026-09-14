<script lang="ts">
import { resolve } from "$app/paths";
import PageHeader from "$lib/components/PageHeader.svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>LiteLLM Benchmarks</title>
  <meta name="description" content="Reproducible LiteLLM SDK and proxy benchmark history" />
</svelte:head>

<PageHeader
  eyebrow="Performance history"
  title="LiteLLM Benchmarks"
  description="Reproducible LiteLLM SDK and proxy benchmark history."
/>
<section aria-labelledby="benchmarks-title">
  <h2 id="benchmarks-title">Available benchmarks</h2>
  <div class="directory">
    {#each data.benchmarks as benchmark (benchmark.id)}
      <a
        class="panel benchmark-card"
        href={`${resolve("/[benchmarkId]", { benchmarkId: benchmark.id })}/`}
      >
        <span class="benchmark-title">{benchmark.label}</span>
        <span class="benchmark-metric">{benchmark.kind} benchmark</span>
        <span class="benchmark-count">View history <span aria-hidden="true">→</span></span>
      </a>
    {/each}
  </div>
</section>
