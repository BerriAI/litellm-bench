<script lang="ts">
import { prefersReducedMotion } from "svelte/motion";
import type { Result, VisualizationSpec } from "vega-embed";
import { enableChartLinks } from "./presentation";

let { spec, label, onready, onerror }: {
  spec: VisualizationSpec;
  label: string;
  onready?: () => void;
  onerror?: () => void;
} = $props();
let chart: HTMLDivElement;
let reservedHeight = $state(180);

$effect(() => {
  const currentSpec = spec;
  let disposed = false;
  let result: Result | undefined;
  async function render() {
    try {
      const { default: embed } = await import("vega-embed");
      if (disposed) return;
      const rendered = await embed(chart, currentSpec, {
        actions: false,
        renderer: "svg",
        tooltip: { theme: "custom" },
      });
      if (disposed) {
        rendered.finalize();
        return;
      }
      result = rendered;
      reservedHeight = chart.querySelector("svg")?.getBoundingClientRect().height ?? reservedHeight;
      enableChartLinks(chart);
      if (!prefersReducedMotion.current) {
        chart.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
      }
      onready?.();
    } catch (error) {
      if (!disposed) {
        console.error("Unable to render chart", error);
        onerror?.();
      }
    }
  }
  void render();
  return () => {
    disposed = true;
    result?.finalize();
  };
});
</script>

<div
  bind:this={chart}
  class="chart"
  data-slot="chart"
  aria-label={label}
  style:min-height={`${reservedHeight}px`}
>
</div>
