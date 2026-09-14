<script lang="ts">
import type { ResolvedAnnotation } from "../lib/annotations";
let { annotations }: { annotations: ResolvedAnnotation[] } = $props();
</script>

{#if annotations.length}
  <aside class="chart-annotations" aria-label="Chart annotations">
    <h4>What changed</h4>
    {#each annotations as { annotation, number } (annotation.id)}
      <div class="chart-annotation">
        <strong>[{number}] {annotation.title}</strong>
        <p class="annotation-scope">
          {annotation.benchmark_id} · Introduced in {annotation.introduced_in}{
            annotation.metric_id ? ` · ${annotation.metric_id}` : " · All metrics"
          }
        </p>
        <p>{annotation.explanation}</p>
        {#if annotation.sources.length}
          <ul aria-label={`Evidence for ${annotation.title}`}>
            {#each annotation.sources as source}
              <li>
                <a href={source.url} target="_blank" rel="noopener noreferrer">{source.label}</a>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/each}
  </aside>
{/if}
