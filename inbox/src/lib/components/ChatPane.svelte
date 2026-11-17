<script lang="ts">
	import { tick } from "svelte";
	import { base } from "$app/paths";
	import { goto } from "$app/navigation";
	import { inbox } from "$lib/inbox.svelte";
	import { accountStatusText, dayLabel, sameDay } from "$lib/format";
	import TopBar from "./TopBar.svelte";
	import Banner from "./Banner.svelte";
	import EmptyState from "./EmptyState.svelte";
	import MessageBubble from "./MessageBubble.svelte";
	import ChatFooter from "./ChatFooter.svelte";
	import SendReview from "./SendReview.svelte";
	import ModelControls from "./ModelControls.svelte";
	import OverflowMenu from "./OverflowMenu.svelte";
	import IconButton from "./IconButton.svelte";
	import Icon from "./Icon.svelte";
	import { assistant } from "$lib/assistant.svelte";
	import { composer, quoteOf } from "$lib/composer.svelte";
	import { outbox } from "$lib/outbox.svelte";

	let { id }: { id: string } = $props();

	$effect(() => {
		inbox.openChat(id);
	});

	const chat = $derived(inbox.chat?.id === id ? inbox.chat : null);
	const replyLookup = $derived(new Map(inbox.messages.map((m) => [m.id, m])));
	const sendable = $derived(chat !== null && chat !== undefined && !chat.readOnly && !chat.archived);
	const outboxPending = $derived(chat ? outbox.pendingFor(chat.id) : []);

	function reply(m: import("$lib/api").MessageView) {
		if (!chat) return;
		composer.setReply(chat.id, quoteOf(m));
	}

	const outboxChip = (state: string) =>
		state === "sending" || state === "pending"
			? "in invio…"
			: state === "uncertain"
				? "esito incerto"
				: "non inviato";
	const subtitle = $derived(
		chat
			? `${chat.network} · ${chat.type === "single" ? "chat a due" : `gruppo, ${chat.participantCount} partecipanti`} · ${accountStatusText(chat.accountStatus)}`
			: undefined,
	);

	let scroller: HTMLElement | undefined = $state();
	let pinnedToBottom = true;

	function onscroll() {
		if (!scroller) return;
		pinnedToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
	}

	/** Prepending history keeps the reader where they were: only the new height is added to the offset. */
	async function loadOlder() {
		if (!scroller || !inbox.nextCursor || inbox.loadingOlder) return;
		const before = scroller.scrollHeight;
		pinnedToBottom = false;
		await inbox.loadOlder();
		await tick();
		if (scroller) scroller.scrollTop += scroller.scrollHeight - before;
	}

	$effect(() => {
		void inbox.messages.length;
		if (pinnedToBottom && scroller) {
			const el = scroller;
			void tick().then(() => (el.scrollTop = el.scrollHeight));
		}
	});

	function onkeydown(e: KeyboardEvent) {
		if (e.key === "Escape" && !inbox.wide && !assistant.open && !outbox.review) void goto(`${base}/`);
	}
</script>

<svelte:window onkeydown={onkeydown} />

<section class="pane" aria-label="Chat">
	<TopBar title={chat?.title ?? "Chat"} subtitle={subtitle}>
		{#snippet leading()}
			<a class="back" href="{base}/" aria-label="Torna alle chat" data-sveltekit-noscroll>
				<Icon name="arrow-left" />
			</a>
		{/snippet}
		{#snippet actions()}
			{#if chat && assistant.available(chat.id)}
				<IconButton
					icon="sparkles"
					label="Assistente"
					pressed={assistant.open}
					disabled={inbox.degraded || inbox.modelPrivacyBusy || chat.modelPrivacy?.chatExcluded || chat.modelPrivacy?.networkExcluded}
					onclick={() => assistant.toggle()}
				/>
			{/if}
			{#if chat}<OverflowMenu {chat} />{/if}
		{/snippet}
	</TopBar>

	{#if chat && chat.id === id}
		{#key chat.id}<ModelControls {chat} importance={false} />{/key}
		<Banner tone="info" icon="eye-off">Lettura senza conferma: aprire la chat non la segna come letta.</Banner>
		{#if chat.accountStatus !== "connected"}
			<Banner tone="warn" icon="alert-triangle">
				{chat.network} disconnesso: la cronologia già nota resta leggibile.
			</Banner>
		{/if}
	{/if}
	{#if inbox.actionError}
		<Banner tone="danger" icon="alert-triangle">{inbox.actionError}</Banner>
	{/if}

	{#if inbox.chatError}
		<EmptyState icon="alert-triangle" title={inbox.chatError}>
			{#snippet actions()}
				<a class="btn" href="{base}/">Torna alle chat</a>
			{/snippet}
		</EmptyState>
	{:else}
		<div class="scroll" bind:this={scroller} {onscroll} aria-label="Messaggi">
			{#if inbox.nextCursor}
				<div class="older">
					<button type="button" class="link" disabled={inbox.loadingOlder} onclick={loadOlder}>
						{inbox.loadingOlder ? "Caricamento…" : "Messaggi precedenti"}
					</button>
				</div>
			{/if}
			{#each inbox.messages as m, i (m.id)}
				{#if i === 0 || !sameDay(m.timestamp, inbox.messages[i - 1]!.timestamp)}
					<p class="day">{dayLabel(m.timestamp)}</p>
				{/if}
				<MessageBubble
					message={m}
					group={chat?.type === "group"}
					replyTo={m.linkedMessageID ? replyLookup.get(m.linkedMessageID) : undefined}
					onReply={sendable ? reply : undefined}
				/>
			{/each}
			{#each outboxPending as p (p.intent.id)}
				<article class="bubble outbox" aria-label="Messaggio in uscita">
					<p class="text">{p.text}</p>
					<p class="meta"><span class="chip-{p.intent.state === 'uncertain' || p.intent.state === 'failed' || p.intent.state === 'not_found' ? 'warn' : 'info'}">{outboxChip(p.intent.state)}</span></p>
				</article>
			{/each}
			{#if inbox.messagesLoaded && inbox.messages.length === 0 && !inbox.chatError}
				<p class="muted">Nessun messaggio in questa chat.</p>
			{/if}
		</div>
		{#if chat}<ChatFooter {chat} />{/if}
	{/if}
	<SendReview />
</section>

<style>
	.pane {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--bg-base);
	}
	.back {
		display: inline-grid;
		place-items: center;
		width: var(--touch-min);
		height: var(--touch-min);
		border-radius: var(--radius-full);
	}
	.back:hover {
		background: var(--bg-raised);
	}
	.scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
	}
	.older {
		display: flex;
		justify-content: center;
	}
	.link {
		min-height: var(--touch-min);
		padding: 0 var(--space-4);
		color: var(--accent);
		font: var(--text-label-13-medium);
	}
	.day {
		align-self: center;
		margin: var(--space-2) 0;
		font: var(--text-caption-12-medium);
		color: var(--text-secondary);
	}
	.muted {
		align-self: center;
		color: var(--text-secondary);
	}
	.bubble.outbox {
		align-self: flex-end;
		max-width: min(80%, 520px);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-16);
		background: var(--accent-subtle);
		outline: 1px dashed var(--border-strong);
	}
	.bubble.outbox .text {
		margin: 0;
		font: var(--text-body-15-regular);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.bubble.outbox .meta {
		margin: 0;
		align-self: flex-end;
		font: var(--text-caption-12-regular);
	}
	.chip-info {
		color: var(--info);
	}
	.chip-warn {
		color: var(--warn);
	}
	.btn {
		display: inline-flex;
		align-items: center;
		min-height: var(--touch-min);
		padding: 0 var(--space-4);
		border-radius: var(--radius-full);
		background: var(--accent);
		color: var(--text-on-accent);
		font: var(--text-label-13-medium);
		text-decoration: none;
	}
</style>
