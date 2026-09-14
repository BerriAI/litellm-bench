<script lang="ts">
import OverviewDashboard from "../components/OverviewDashboard.svelte";
</script>

<svelte:head>
  <title>LiteLLM Benchmarks</title>
  <meta name="description" content="Reproducible LiteLLM SDK and proxy benchmark history" />
</svelte:head>

<main
  id="main-content"
  tabindex="-1"
  class="shell dashboard"
  data-variant="chart-only"
  aria-label="LiteLLM benchmark measurements"
>
  <header class="overview-header">
    <h1>LiteLLM Benchmark</h1>
    <a href="https://github.com/BerriAI/litellm-bench">GitHub <span aria-hidden="true"
      >↗</span></a>
  </header>
  <OverviewDashboard />
</main>
