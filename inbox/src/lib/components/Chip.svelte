<script lang="ts">
	import type { Snippet } from "svelte";

	let { tone = "neutral", children }: { tone?: "accent" | "warn" | "neutral"; children: Snippet } = $props();
</script>

<span class="chip {tone}">{@render children()}</span>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		padding: 2px var(--space-2);
		border-radius: var(--radius-full);
		font: var(--text-caption-12-medium);
		white-space: nowrap;
	}
	.accent {
		background: var(--accent-subtle);
		color: var(--accent);
	}
	.warn {
		background: var(--warn-subtle);
		color: var(--warn);
	}
	.neutral {
		background: var(--bg-raised);
		color: var(--text-secondary);
	}
</style>
