<script lang="ts">
	import { api, type ChatSummary } from "$lib/api";
	import { inbox } from "$lib/inbox.svelte";
	import { snoozeOptions, snoozeText } from "$lib/format";

	let { chat }: { chat: ChatSummary } = $props();

	let menuOpen = $state(false);
	const noReply = $derived(Boolean(chat.corrections.noReplyAt));
	const snoozed = $derived(
		chat.corrections.snoozeUntil && Date.parse(chat.corrections.snoozeUntil) > inbox.now
			? chat.corrections.snoozeUntil
			: undefined,
	);

	const options = $derived(menuOpen ? snoozeOptions(new Date(inbox.now)) : []);

	function pickSnooze(iso: string) {
		menuOpen = false;
		void inbox.correct(() => api.snooze(chat.id, iso));
	}
</script>

<footer class="footer">
	{#if snoozed}
		<p class="snoozed">
			Rimandata a {snoozeText(snoozed)}
			<button type="button" class="link" onclick={() => inbox.correct(() => api.snooze(chat.id, null))}>
				Annulla rimando
			</button>
		</p>
	{/if}
	<div class="row">
		<button
			type="button"
			class="btn outline"
			aria-pressed={noReply}
			onclick={() => inbox.correct(() => api.setNoReply(chat.id, !noReply))}
		>
			{noReply ? "Annulla «Non serve risposta»" : "Non serve risposta"}
		</button>
		<div class="snooze">
			<button
				type="button"
				class="link"
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				onclick={() => (menuOpen = !menuOpen)}
			>
				Rimanda
			</button>
			{#if menuOpen}
				<div class="menu" role="menu" aria-label="Rimanda fino a">
					{#each options as o (o.label)}
						<button type="button" role="menuitem" class="item" onclick={() => pickSnooze(o.until)}>
							{o.label}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</footer>

<style>
	.footer {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4) calc(var(--space-3) + env(safe-area-inset-bottom));
		border-top: 1px solid var(--border-subtle);
		background: var(--bg-surface);
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
	.btn,
	.link {
		min-height: var(--touch-min);
		font: var(--text-label-13-medium);
		border-radius: var(--radius-full);
	}
	.outline {
		flex: 1;
		padding: 0 var(--space-4);
		border: 1px solid var(--border-strong);
		color: var(--text-primary);
	}
	.link {
		padding: 0 var(--space-3);
		color: var(--accent);
	}
	.snoozed {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin: 0;
		font: var(--text-label-13-regular);
		color: var(--text-secondary);
	}
	.snooze {
		position: relative;
	}
	.menu {
		position: absolute;
		right: 0;
		bottom: calc(100% + var(--space-2));
		display: flex;
		flex-direction: column;
		min-width: 220px;
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
