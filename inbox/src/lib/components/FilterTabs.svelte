<script lang="ts">
	import { inbox } from "$lib/inbox.svelte";
	import type { ChatFilter } from "$lib/api";

	const tabs: { id: ChatFilter; label: string }[] = [
		{ id: "reply", label: "Da rispondere" },
		{ id: "unread", label: "Non letti" },
		{ id: "all", label: "Tutte" },
	];

	const count = (id: ChatFilter): string => {
		if (inbox.degraded) return "–";
		return String(inbox.state?.counts[id] ?? 0);
	};

	function onkeydown(e: KeyboardEvent) {
		const i = tabs.findIndex((t) => t.id === inbox.filter);
		const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
		if (!step) return;
		e.preventDefault();
		const next = tabs[(i + step + tabs.length) % tabs.length]!;
		inbox.setFilter(next.id);
		document.getElementById(`tab-${next.id}`)?.focus();
	}
</script>

<div class="tabs" role="tablist" aria-label="Filtro chat" tabindex="-1" {onkeydown}>
	{#each tabs as t (t.id)}
		<button
			id="tab-{t.id}"
			type="button"
			role="tab"
			class="tab"
			class:selected={inbox.filter === t.id}
			class:dim={inbox.degraded}
			aria-selected={inbox.filter === t.id}
			tabindex={inbox.filter === t.id ? 0 : -1}
			onclick={() => inbox.setFilter(t.id)}
		>
			{t.label}
			<span class="count">{count(t.id)}</span>
		</button>
	{/each}
</div>

<style>
	.tabs {
		display: flex;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-4);
		overflow-x: auto;
		scrollbar-width: none;
	}
	.tab {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: var(--touch-min);
		padding: 0 var(--space-3);
		border-radius: var(--radius-full);
		border: 1px solid var(--border-strong);
		color: var(--text-primary);
		font: var(--text-label-13-medium);
		white-space: nowrap;
	}
	.tab.selected {
		border-color: var(--accent);
		background: var(--accent-subtle);
		color: var(--accent);
	}
	.tab.dim {
		color: var(--text-secondary);
		border-color: var(--border-subtle);
	}
	.count {
		font: var(--text-caption-12-medium);
		color: var(--text-secondary);
	}
	.tab.selected .count {
		color: var(--accent);
	}
</style>
