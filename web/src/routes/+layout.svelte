<script lang="ts">
import { asset, resolve } from "$app/paths";
import type { LayoutProps } from "./$types";
import "../styles/index.css";
let { children }: LayoutProps = $props();
</script>

<svelte:head>
  <link rel="icon" href={asset("/favicon.svg")} type="image/svg+xml" />
</svelte:head>

<a class="skip-link" href="#main-content">Skip to benchmark data</a>
<header class="navigation">
  <nav class="shell navigation-inner" aria-label="Primary navigation">
    <a class="brand" href={resolve("/")} aria-label="LiteLLM Benchmarks home">
      <span class="brand-mark" aria-hidden="true">LB</span><span>LiteLLM Benchmarks</span>
    </a>
    <a class="navigation-link" href={resolve("/")}>All benchmarks</a>
  </nav>
</header>
<main id="main-content" tabindex="-1" class="shell dashboard">
  {@render children()}
</main>
<footer class="page-footer">
  <div class="shell footer-content">
    <p>Measured in public. Reproducible by design.</p>
    <a href="https://github.com/BerriAI/litellm-bench">GitHub <span aria-hidden="true"
      >↗</span></a>
  </div>
</footer>
