<script lang="ts">
	import "$lib/tokens.css";
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { inbox } from "$lib/inbox.svelte";
	import ListPane from "$lib/components/ListPane.svelte";

	let { children } = $props();

	const chatRoute = $derived(page.route.id?.startsWith("/chat/") ?? false);
	const selectedId = $derived(page.params.id);

	onMount(() => inbox.start());

	$effect(() => {
		if (!chatRoute) inbox.closeChat();
	});
</script>

<svelte:head>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="shell" class:wide={inbox.wide}>
	{#if inbox.wide || !chatRoute}
		<div class="list-col">
			<ListPane {selectedId} />
		</div>
	{/if}
	{#if chatRoute}
		<div class="detail-col">{@render children()}</div>
	{:else if inbox.wide}
		<div class="detail-col empty-detail">
			<p>Seleziona una chat per leggerla.</p>
		</div>
	{/if}
</div>

<style>
	.shell {
		display: flex;
		flex-direction: column;
		height: 100vh;
		height: 100dvh;
		overflow: hidden;
	}
	.list-col,
	.detail-col {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.empty-detail {
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
	}
	.shell.wide {
		flex-direction: row;
	}
	.shell.wide .list-col {
		flex: 0 0 360px;
		min-width: 0;
		border-right: 1px solid var(--border-subtle);
	}
</style>
