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
  <OverviewDashboard />
</main>
