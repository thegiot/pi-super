<script lang="ts">
	import type { ChatSummary } from "$lib/api";
	import { api } from "$lib/api";
	import { inbox } from "$lib/inbox.svelte";
	import IconButton from "./IconButton.svelte";

	let { chat }: { chat: ChatSummary } = $props();
	let open = $state(false);

	function run(action: () => Promise<ChatSummary>) {
		open = false;
		void inbox.correct(action);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === "Escape") open = false;
	}
</script>

<svelte:window onkeydown={onkeydown} />

<div class="wrap">
	<IconButton icon="more-vertical" label="Altre azioni" expanded={open} haspopup onclick={() => (open = !open)} />
	{#if open}
		<div class="menu" role="menu" aria-label="Altre azioni della chat">
			<button type="button" role="menuitem" class="item" onclick={() => run(() => api.mark(chat.id, !chat.corrections.marked))}>
				{chat.corrections.marked ? "Togli segno" : "Segna da rispondere"}
			</button>
			<button type="button" role="menuitem" class="item" onclick={() => run(() => api.priority(chat.id, !chat.corrections.priority))}>
				{chat.corrections.priority ? "Prioritaria: disattiva" : "Prioritaria: attiva"}
			</button>
		</div>
	{/if}
</div>

<style>
	.wrap {
		position: relative;
	}
	.menu {
		position: absolute;
		right: 0;
		top: calc(100% + var(--space-1));
		display: flex;
		flex-direction: column;
		min-width: 230px;
		padding: var(--space-1);
		border-radius: var(--radius-12);
		background: var(--bg-raised);
		border: 1px solid var(--border-strong);
		z-index: 10;
	}
	.item {
		min-height: var(--touch-min);
		padding: 0 var(--space-4);
		border-radius: var(--radius-8);
		text-align: left;
		font: var(--text-body-15-regular);
	}
	.item:hover,
	.item:focus-visible {
		background: var(--bg-surface);
	}
</style>
