<script lang="ts">
	import type { Snippet } from "svelte";
	import Icon from "./Icon.svelte";
	import type { IconName } from "$lib/icon-name";

	let { icon, title, children, actions }: { icon: IconName; title: string; children?: Snippet; actions?: Snippet } =
		$props();
</script>

<div class="empty">
	<span class="icon"><Icon name={icon} size={32} /></span>
	<h2>{title}</h2>
	{#if children}<div class="body">{@render children()}</div>{/if}
	{#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: var(--space-3);
		padding: var(--space-8) var(--space-6);
		color: var(--text-secondary);
	}
	.icon {
		display: grid;
		place-items: center;
		width: 64px;
		height: 64px;
		border-radius: var(--radius-full);
		background: var(--bg-surface);
		color: var(--text-secondary);
	}
	h2 {
		margin: var(--space-2) 0 0;
		font: var(--text-title-17-medium);
		color: var(--text-primary);
	}
	.body {
		max-width: 34ch;
		font: var(--text-label-13-regular);
	}
	.actions {
		margin-top: var(--space-2);
	}
</style>
