<script lang="ts">
let { eyebrow, title, description }: { eyebrow: string; title: string; description: string } =
  $props();
</script>

<header class="page-header">
  <p class="eyebrow">{eyebrow}</p>
  <h1>{title}</h1>
  <p class="page-description">{description}</p>
</header>
