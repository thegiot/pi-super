<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		title,
		subtitle,
		leading,
		actions,
	}: { title: string; subtitle?: string; leading?: Snippet; actions?: Snippet } = $props();
</script>

<header class="topbar">
	<div class="lead">{@render leading?.()}</div>
	<div class="titles">
		<h1>{title}</h1>
		{#if subtitle}<p class="subtitle">{subtitle}</p>{/if}
	</div>
	<div class="actions">{@render actions?.()}</div>
</header>

<style>
	.topbar {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 64px;
		padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
		background: var(--bg-surface);
		border-bottom: 1px solid var(--border-subtle);
	}
	.lead,
	.actions {
		display: flex;
		align-items: center;
		flex: none;
	}
	.titles {
		flex: 1;
		min-width: 0;
	}
	h1 {
		margin: 0;
		font: var(--text-title-17-medium);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.subtitle {
		margin: 0;
		font: var(--text-caption-12-regular);
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
