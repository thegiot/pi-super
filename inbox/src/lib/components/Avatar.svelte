<script lang="ts">
	import { initials, networkTone } from "$lib/format";

	let { name, network }: { name: string; network: string } = $props();
	const tone = $derived(networkTone(network));
</script>

<span class="avatar" aria-hidden="true">
	{initials(name)}
	<span class="dot" style:background="var(--network-{tone})"></span>
</span>

<style>
	.avatar {
		position: relative;
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 40px;
		height: 40px;
		border-radius: var(--radius-full);
		background: var(--bg-raised);
		color: var(--text-primary);
		font: var(--text-label-13-medium);
	}
	.dot {
		position: absolute;
		right: -1px;
		bottom: -1px;
		width: 10px;
		height: 10px;
		border-radius: var(--radius-full);
		border: 2px solid var(--bg-base);
	}
</style>
