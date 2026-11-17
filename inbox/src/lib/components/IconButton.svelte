<script lang="ts">
	import type { Snippet } from "svelte";
	import Icon from "./Icon.svelte";
	import type { IconName } from "$lib/icon-name";

	let {
		icon,
		label,
		onclick,
		expanded,
		pressed,
		haspopup,
		href,
	}: {
		icon: IconName;
		label: string;
		onclick?: () => void;
		expanded?: boolean;
		pressed?: boolean;
		haspopup?: boolean;
		href?: string;
	} = $props();
</script>

{#if href}
	<a class="icon-btn" {href} aria-label={label} title={label} data-sveltekit-reload>
		<Icon name={icon} />
	</a>
{:else}
	<button
		type="button"
		class="icon-btn"
		aria-label={label}
		title={label}
		{onclick}
		aria-expanded={expanded}
		aria-pressed={pressed}
		aria-haspopup={haspopup ? "menu" : undefined}
	>
		<Icon name={icon} />
	</button>
{/if}

<style>
	.icon-btn {
		display: inline-grid;
		place-items: center;
		width: var(--touch-min);
		height: var(--touch-min);
		border-radius: var(--radius-full);
		color: var(--text-primary);
	}
	.icon-btn:hover {
		background: var(--bg-raised);
	}
</style>
