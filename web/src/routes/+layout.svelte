<script lang="ts">
import { base } from "$app/paths";
import type { LayoutProps } from "./$types";
import "../styles/index.css";

let { children }: LayoutProps = $props();
</script>

<svelte:head>
  <link rel="icon" href={`${base}/favicon.svg`} type="image/svg+xml" />
</svelte:head>

<a class="skip-link" href="#main-content">Skip to benchmark data</a>
{@render children()}
