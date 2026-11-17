<script lang="ts">
	import { networkTone } from "$lib/format";

	let { network, warn = false }: { network: string; warn?: boolean } = $props();
	const tone = $derived(networkTone(network));
</script>

<span class="badge">
	<span class="dot" style:background="var(--network-{tone})" aria-hidden="true"></span>
	{network}
	{#if warn}<span class="warn">· non connesso</span>{/if}
</span>

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		font: var(--text-caption-12-regular);
		color: var(--text-secondary);
		white-space: nowrap;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: var(--radius-full);
	}
	.warn {
		color: var(--warn);
	}
</style>
