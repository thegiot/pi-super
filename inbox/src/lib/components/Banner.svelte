<script lang="ts">
	import type { Snippet } from "svelte";
	import Icon from "./Icon.svelte";
	import type { IconName } from "$lib/icon-name";

	let {
		tone = "info",
		icon,
		children,
		action,
	}: { tone?: "info" | "warn" | "danger"; icon: IconName; children: Snippet; action?: Snippet } = $props();
</script>

<div class="banner {tone}" role={tone === "danger" ? "alert" : "status"} aria-live="polite">
	<span class="icon"><Icon name={icon} size={20} /></span>
	<div class="text">{@render children()}</div>
	{#if action}<div class="action">{@render action()}</div>{/if}
</div>

<style>
	.banner {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		margin: var(--space-2) var(--space-4);
		border-radius: var(--radius-12);
		font: var(--text-label-13-regular);
	}
	.info {
		background: var(--info-subtle);
		color: var(--info);
	}
	.warn {
		background: var(--warn-subtle);
		color: var(--warn);
	}
	.danger {
		background: var(--danger-subtle);
		color: var(--danger);
	}
	.icon {
		flex: none;
		padding-top: 1px;
	}
	.text {
		flex: 1;
		color: var(--text-primary);
	}
	.action {
		flex: none;
	}
</style>
