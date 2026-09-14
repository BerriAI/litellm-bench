<script lang="ts">
import { VegaLite } from "svelte-vega";
import { prefersReducedMotion } from "svelte/motion";
import type { EmbedOptions, VisualizationSpec } from "vega-embed";
import { enableChartLinks } from "./presentation";

let {
  spec,
  label,
  onready,
  onerror,
}: {
  spec: VisualizationSpec;
  label: string;
  onready?: () => void;
  onerror?: () => void;
} = $props();
let chart: HTMLDivElement;
let reservedHeight = $state(180);
const options: EmbedOptions = {
  actions: false,
  renderer: "svg",
  tooltip: { theme: "custom" },
};
</script>

<div
  bind:this={chart}
  class="chart"
  data-slot="chart"
  aria-label={label}
  style:min-height={`${reservedHeight}px`}
>
  <VegaLite
    {spec}
    {options}
    data={{}}
    onNewView={() => {
      reservedHeight = chart.querySelector("svg")?.getBoundingClientRect().height ?? reservedHeight;
      enableChartLinks(chart);
      if (!prefersReducedMotion.current) {
        chart.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
      }
      onready?.();
    }}
    onError={() => onerror?.()}
  />
</div>
