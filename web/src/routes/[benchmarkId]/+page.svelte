<script lang="ts">
import { base } from "$app/paths";
import DetailDashboard from "../../components/DetailDashboard.svelte";
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

<nav class="navigation" aria-label="Primary navigation">
  <div class="shell navigation-inner">
    <a class="brand" href={`${base}/`} aria-label="LiteLLM Benchmarks home">
      <span class="brand-mark" aria-hidden="true">LB</span><span>LiteLLM Benchmarks</span>
    </a>
    <a class="navigation-link" href={`${base}/`}>All benchmarks</a>
  </div>
</nav>
<header class="shell page-header">
  <p class="eyebrow">Performance / {data.benchmark.kind}</p>
  <h1>{data.benchmark.label}</h1>
  <p class="page-description">
    Explore metrics, version history, and individual runs from this benchmark.
  </p>
</header>
<main
  id="main-content"
  tabindex="-1"
  class="shell dashboard"
  data-benchmark-id={data.benchmark.id}
>
  <DetailDashboard benchmarkId={data.benchmark.id} />
</main>
<footer class="page-footer">
  <div class="shell footer-content">
    <p>Measured in public. Reproducible by design.</p>
    <a href={`${base}/`}>Return to all benchmarks</a>
  </div>
</footer>
