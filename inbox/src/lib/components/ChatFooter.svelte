<script lang="ts">
	import { api, type ChatSummary } from "$lib/api";
	import { inbox } from "$lib/inbox.svelte";
	import { assistant } from "$lib/assistant.svelte";
	import { composer } from "$lib/composer.svelte";
	import { outbox, outboxErrorText } from "$lib/outbox.svelte";
	import { snoozeOptions, snoozeText } from "$lib/format";
	import IconButton from "./IconButton.svelte";
	import Icon from "./Icon.svelte";

	let { chat }: { chat: ChatSummary } = $props();

	let menuOpen = $state(false);
	let area: HTMLTextAreaElement | undefined = $state();
	const noReply = $derived(Boolean(chat.corrections.noReplyAt));
	const snoozed = $derived(
		chat.corrections.snoozeUntil && Date.parse(chat.corrections.snoozeUntil) > inbox.now
			? chat.corrections.snoozeUntil
			: undefined,
	);

	const options = $derived(menuOpen ? snoozeOptions(new Date(inbox.now)) : []);

	// ---- composer (F4–F5): nothing sends from here; «Rivedi» opens the sheet
	const draft = $derived(composer.draft(chat.id));
	const sendable = $derived(!chat.readOnly && !chat.archived);
	const canReview = $derived(
		sendable && draft.text.trim() !== "" && !inbox.degraded && chat.accountStatus === "connected",
	);
	const counter = $derived.by(() => {
		const n = draft.text.length.toLocaleString("it");
		return chat.maxTextLength
			? `${n} / limite ${chat.maxTextLength.toLocaleString("it")}`
			: `${n} caratteri · nessun limite dichiarato`;
	});
	const overLimit = $derived(chat.maxTextLength !== undefined && draft.text.length > chat.maxTextLength);

	function pickSnooze(iso: string) {
		menuOpen = false;
		void inbox.correct(() => api.snooze(chat.id, iso));
	}

	function grow() {
		if (!area) return;
		area.style.height = "auto";
		area.style.height = `${Math.min(area.scrollHeight, 160)}px`;
	}

	async function review() {
		if (!canReview) return;
		if (!(await outbox.openReview(chat.id, draft.text, draft.replyTo?.id))) {
			inbox.actionError = outboxErrorText(outbox.lastError ?? "network");
		}
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
	{#if sendable}
		{#if draft.replyTo}
			<p class="quote">
				<Icon name="corner-up-left" size={14} />
				<span class="quote-text">Rispondi a {draft.replyTo.author ?? "messaggio"}: {draft.replyTo.snippet}</span>
				<button type="button" class="quote-clear" aria-label="Annulla citazione" onclick={() => composer.setReply(chat.id, undefined)}>
					<Icon name="x" size={14} />
				</button>
			</p>
		{/if}
		<div class="composer">
			{#if inbox.state?.assistant.status === "ok"}
				<IconButton icon="sparkles" label="Assistente" pressed={assistant.open} disabled={inbox.degraded} onclick={() => assistant.toggle()} />
			{/if}
			<label class="sr-only" for="composer-input">Scrivi un messaggio</label>
			<textarea
				id="composer-input"
				rows="1"
				placeholder="Scrivi un messaggio"
				value={draft.text}
				bind:this={area}
				oninput={(e) => {
					composer.setText(chat.id, e.currentTarget.value);
					grow();
				}}
			></textarea>
			<button type="button" class="btn review" disabled={!canReview} onclick={review}>Rivedi</button>
		</div>
		<p class="counter" class:over={overLimit}>{counter}</p>
	{:else}
		<p class="counter">In questa chat non puoi scrivere.</p>
	{/if}
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
	.quote {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-8);
		background: var(--bg-raised);
		color: var(--text-secondary);
		font: var(--text-caption-12-regular);
	}
	.quote-text {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.quote-clear {
		display: inline-grid;
		place-items: center;
		width: var(--touch-min);
		height: var(--touch-min);
		flex: 0 0 var(--touch-min);
		border-radius: var(--radius-full);
		color: var(--text-secondary);
	}
	.composer {
		display: flex;
		align-items: flex-end;
		gap: var(--space-2);
	}
	.composer textarea {
		flex: 1;
		min-width: 0;
		min-height: var(--touch-min);
		max-height: 160px;
		padding: 12px var(--space-4);
		border-radius: var(--radius-16);
		border: 1px solid var(--border-strong);
		background: var(--bg-base);
		color: var(--text-primary);
		font: var(--text-body-15-regular);
		resize: none;
	}
	.btn.review {
		background: var(--accent);
		color: var(--text-on-accent);
		padding: 0 var(--space-4);
	}
	.btn.review:disabled {
		opacity: 0.5;
	}
	.counter {
		margin: 0;
		align-self: flex-end;
		font: var(--text-caption-12-regular);
		color: var(--text-secondary);
	}
	.counter.over {
		color: var(--warn);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
</style>
