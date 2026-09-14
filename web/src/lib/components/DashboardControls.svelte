<script lang="ts">
import MultiSelect from "svelte-widgets/MultiSelect.svelte";
import RangeSlider from "svelte-widgets/RangeSlider.svelte";
import type { MetricOption } from "../dashboard";
let { versions, metricOptions, versionRange = $bindable(), selectedMetrics = $bindable() }: {
  versions: string[];
  metricOptions: MetricOption[];
  versionRange: [number, number];
  selectedMetrics: MetricOption[];
} = $props();
</script>

<div class="panel detail-controls" aria-label="Chart controls">
  <div class="version-slider">
    {#if versions.length > 1}
      <RangeSlider
        class="version-range-slider"
        min={0}
        max={versions.length - 1}
        step={1}
        bind:value={versionRange}
        label="LiteLLM version range"
        lower_label="First LiteLLM version"
        upper_label="Last LiteLLM version"
        format_value={(value) => versions[Math.round(value)] ?? "—"}
        show_inputs={false}
        tick_count={2}
      />
    {:else if versions.length === 1}
      <div>
        <span class="field-label">LiteLLM version range</span>
        <p class="control-placeholder">{versions[0]}</p>
      </div>
    {:else}
      <p class="control-placeholder">No versions available.</p>
    {/if}
  </div>
  <div class="metric-picker">
    <label class="field-label" for="detail-metrics">Metrics</label>
    <MultiSelect
      class="metric-multiselect"
      id="detail-metrics"
      options={metricOptions}
      bind:value={selectedMetrics}
      placeholder="Select metrics"
      max_visible_chips={0}
      keep_selected_in_dropdown="checkboxes"
      select_all_option="Select all metrics"
      virtual_list
      allow_empty
      disabled={!metricOptions.length}
    />
  </div>
</div>
