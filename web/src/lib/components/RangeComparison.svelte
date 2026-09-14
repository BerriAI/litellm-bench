<script lang="ts">
import { prefersReducedMotion, Tween } from "svelte/motion";
import { formatValue } from "../data";
let { from, to, unit }: { from: number; to: number; unit: string } = $props();
const share = Tween.of(() => Math.abs(to) / Math.max(Math.abs(from), Math.abs(to), 1) * 100, {
  duration: () => prefersReducedMotion.current ? 0 : 180,
});
</script>
<span class="comparison-values">{formatValue(from, unit)} / {formatValue(to, unit)}</span>
<div class="comparison-bars" aria-hidden="true">
  <i style:width={`${Math.abs(from) / Math.max(Math.abs(from), Math.abs(to), 1) * 100}%`}></i>
  <i style:width={`${share.current}%`}></i>
</div>
