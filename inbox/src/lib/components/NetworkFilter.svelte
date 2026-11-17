<script lang="ts">
	import { inbox } from "$lib/inbox.svelte";
	import { networkTone } from "$lib/format";
	import Icon from "./Icon.svelte";

	const networks = $derived.by(() => {
		const accounts = inbox.state?.accounts ?? [];
		return [...new Set(accounts.map((a) => a.network))].map((name) => ({
			name,
			connected: accounts.every((a) => a.network !== name || a.status === "connected"),
		}));
	});
</script>

<div class="networks" role="group" aria-label="Filtra per rete">
	<button type="button" class="chip" aria-pressed={inbox.network === ""} onclick={() => inbox.setNetwork("")}>
		Tutte le reti
	</button>
	{#each networks as n (n.name)}
		<button
			type="button"
			class="chip"
			aria-pressed={inbox.network === n.name}
			onclick={() => inbox.setNetwork(n.name)}
			aria-label={n.connected ? n.name : `${n.name}, account non connesso`}
		>
			<span class="dot" style:background="var(--network-{networkTone(n.name)})" aria-hidden="true"></span>
			{n.name}
			{#if !n.connected}<span class="warn"><Icon name="alert-triangle" size={14} /></span>{/if}
		</button>
	{/each}
</div>

<style>
	.networks {
		display: flex;
		gap: var(--space-2);
		padding: 0 var(--space-4) var(--space-2);
		overflow-x: auto;
		scrollbar-width: none;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		flex: none;
		min-height: var(--touch-min);
		padding: 0 var(--space-3);
		border-radius: var(--radius-full);
		background: var(--bg-surface);
		color: var(--text-secondary);
		font: var(--text-caption-12-medium);
	}
	.chip[aria-pressed="true"] {
		background: var(--bg-raised);
		color: var(--text-primary);
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: var(--radius-full);
	}
	.warn {
		display: inline-flex;
		color: var(--warn);
	}
</style>
