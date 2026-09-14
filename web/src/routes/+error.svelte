<script lang="ts">
import { resolve } from "$app/paths";
import { page } from "$app/state";
</script>

<svelte:head><title>{page.status} · LiteLLM Benchmarks</title></svelte:head>
<section class="page-header">
  <h1>{page.status === 404 ? "Benchmark not found" : "Unable to load benchmark data"}</h1>
  <p>
    {
      page.status === 404 ? "This benchmark is not available." : "Please reload the page to try again."
    }
  </p>
  <a href={resolve("/")}>All benchmarks</a>
</section>
