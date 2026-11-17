<script lang="ts">
	import { tick } from "svelte";
	import { outbox, outboxErrorText } from "$lib/outbox.svelte";
	import { inbox } from "$lib/inbox.svelte";
	import { composer } from "$lib/composer.svelte";
	import IconButton from "./IconButton.svelte";
	import Icon from "./Icon.svelte";

	/*
	 * Optional review and shared send outcomes. Direct composer sends also use this
	 * sheet for delivery status, reconciliation and deliberate retries.
	 */

	const session = $derived(outbox.review);
	const intent = $derived(session?.intent);
	const recipient = $derived(intent?.recipient);

	const sendable = $derived(session !== null && !session.stale && !session.busy);
	const overLimit = $derived(
		session !== null && recipient?.maxLength != null && session.text.length > recipient.maxLength,
	);
	const charLine = $derived.by(() => {
		if (!session || !recipient) return "";
		const n = session.text.length.toLocaleString("it");
		return recipient.maxLength == null
			? `${n} caratteri · nessun limite dichiarato`
			: `${n} caratteri · limite ${recipient.network} ${recipient.maxLength.toLocaleString("it")}`;
	});
	const shortTitle = $derived((recipient?.title ?? "").split(" ")[0] || "chat");

	let panel: HTMLElement | undefined = $state();

	function close() {
		outbox.closeReview();
	}

	async function confirm() {
		const s = outbox.review;
		if (await outbox.confirm()) {
			// the text went out for review and send: the composer hands it to the intent
			if (s) composer.clearIfRevision(s.intent.chatID, s.composerRevision);
		}
	}

	function onkeydown(e: KeyboardEvent) {
		if (!session || !panel) return;
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			close();
			return;
		}
		if (e.key !== "Tab") return;
		const items = [...panel.querySelectorAll<HTMLElement>("button, input, textarea, a[href]")].filter(
			(el) => !el.hasAttribute("disabled"),
		);
		if (items.length === 0) return;
		const first = items[0]!;
		const last = items.at(-1)!;
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}

	$effect(() => {
		if (session && !session.outcome) void tick().then(() => panel?.querySelector<HTMLElement>("button")?.focus());
	});
</script>

<svelte:window onkeydown={onkeydown} />

{#if session && intent && recipient}
	{#snippet fields()}
		<dl class="fields">
			<div class="field">
				<dt>Da</dt>
				<dd>{recipient.network} · {recipient.accountLabel}</dd>
			</div>
			<div class="field">
				<dt>A</dt>
				<dd class="to">
					<span class="avatar" aria-hidden="true">{recipient.title.slice(0, 2).toUpperCase()}</span>
					<span>
						<strong>{recipient.title}</strong>
						<small>
							{[recipient.peerLabel, recipient.type === "single" ? "chat a due" : `gruppo · ${recipient.participantCount} partecipanti`]
								.filter(Boolean)
								.join(" · ")}
						</small>
						{#if intent.resolvedChatID && intent.resolvedChatID !== intent.chatID}
							<small>Beeper la recapita a un'altra copia di questa chat</small>
						{/if}
					</span>
				</dd>
			</div>
			{#if intent.replyTo}
				<div class="field">
					<dt>In risposta a</dt>
					<dd class="quote">
						{intent.replyTo.author ? `${intent.replyTo.author}: ` : ""}{intent.replyTo.text ?? "(messaggio senza testo)"}
					</dd>
				</div>
			{/if}
			<div class="field">
				<dt>Testo esatto</dt>
				<dd class="exact">{session.text}</dd>
			</div>
		</dl>
		<p class="count" class:over={overLimit}>{charLine}</p>
	{/snippet}

	<div class="scrim" role="presentation" onclick={close}></div>
	<div
		class={inbox.wide ? "modal" : "sheet"}
		role="dialog"
		tabindex="-1"
		aria-modal="true"
		aria-label={session.outcome ? "Esito invio" : "Rivedi e invia"}
		bind:this={panel}
	>
		{#if !inbox.wide}<span class="handle" aria-hidden="true"></span>{/if}
		<header class="head">
			<span class="title"><Icon name="check" size={20} /> {session.outcome ? "Esito invio" : "Rivedi e invia"}</span>
			<IconButton icon="x" label="Chiudi senza inviare" onclick={close} />
		</header>

		{#if !session.outcome}
			{@render fields()}
			{#if session.stale}
				<p class="note warn" role="alert">{outboxErrorText(session.error ?? "confirm_expired")} Riapri «Rivedi» per inviare.</p>
			{:else}
				<p class="note info">
					<Icon name="eye-off" size={14} /> Parte una sola volta, esattamente questo testo. Se cambi qualcosa, torni a
					questo foglio.
				</p>
			{/if}
			{#if session.error && !session.stale}
				<p class="note warn" role="alert">{outboxErrorText(session.error)}</p>
			{/if}
			<div class="actions">
				<button type="button" class="btn ghost" onclick={close}>Modifica</button>
				<button type="button" class="btn send" disabled={!sendable} onclick={confirm}>
					Invia a {shortTitle}
				</button>
			</div>
		{:else}
			<!-- outcome -->
			{@render fields()}
			{#if intent.state === "sending" || intent.state === "pending"}
				<p class="note info" role="status">In invio…</p>
			{:else if intent.state === "sent"}
				<p class="note ok" role="status"><Icon name="check" size={14} /> Inviato.</p>
			{:else if intent.state === "uncertain"}
				<p class="note warn" role="alert">
					Esito incerto: Beeper non ha confermato l'invio. Non è stato reinviato nulla: controlla la
					cronologia, poi decidi.
				</p>
			{:else if intent.state === "not_found"}
				<p class="note warn" role="alert">
					Non risulta nella cronologia. Puoi riprovare: se in realtà era partito, arriverà due volte.
				</p>
			{:else if intent.state === "failed"}
				<p class="note warn" role="alert">Non inviato{intent.reason ? `: ${outboxErrorText(intent.reason)}` : "."}</p>
			{:else}
				<p class="note warn" role="alert">{outboxErrorText(session.error ?? "confirm_expired")}</p>
			{/if}
			{#if session.error && intent.state !== "failed"}
				<p class="note warn" role="alert">{outboxErrorText(session.error)}</p>
			{/if}
			<div class="actions">
				{#if intent.state === "uncertain"}
					<button type="button" class="btn ghost" disabled={session.busy} onclick={() => outbox.reconcile()}>
						Controlla nella cronologia
					</button>
					<button type="button" class="btn ghost" disabled={session.busy} onclick={() => outbox.reissue()}>
						Riprova comunque
					</button>
				{:else if intent.state === "failed" || intent.state === "not_found"}
					<button type="button" class="btn ghost" disabled={session.busy} onclick={() => outbox.reissue()}>
						Riprova
					</button>
				{/if}
				<button type="button" class="btn send" onclick={close}>
					{intent.state === "sending" || intent.state === "pending" ? "Chiudi e attendi" : "Chiudi"}
				</button>
			</div>
			{#if intent.state === "uncertain" || intent.state === "not_found"}
				<p class="hint">«Riprova» riapre Rivedi e invia e avvisa del rischio di doppione.</p>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.sheet,
	.modal {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4) var(--space-4);
		background: var(--bg-surface);
		color: var(--text-primary);
		z-index: 30;
	}
	.sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		max-height: 88vh;
		overflow-y: auto;
		border-radius: var(--radius-16) var(--radius-16) 0 0;
		padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom));
	}
	.modal {
		position: fixed;
		left: 50%;
		top: 50%;
		translate: -50% -50%;
		width: min(520px, calc(100vw - 2 * var(--space-4)));
		max-height: 85vh;
		overflow-y: auto;
		border-radius: var(--radius-16);
		border: 1px solid var(--border-strong);
	}
	.scrim {
		position: fixed;
		inset: 0;
		background: var(--bg-scrim);
		z-index: 29;
	}
	.handle {
		align-self: center;
		width: 40px;
		height: 4px;
		border-radius: var(--radius-full);
		background: var(--border-strong);
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.title {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		font: var(--text-title-17-medium);
		color: var(--accent);
	}
	.fields {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: 0;
	}
	.field dt {
		font: var(--text-caption-12-medium);
		color: var(--text-secondary);
		margin-bottom: var(--space-1);
	}
	.field dd {
		margin: 0;
		font: var(--text-body-15-regular);
	}
	.to {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.to small {
		display: block;
		color: var(--text-secondary);
		font: var(--text-caption-12-regular);
	}
	.avatar {
		display: inline-grid;
		place-items: center;
		width: 40px;
		height: 40px;
		flex: 0 0 40px;
		border-radius: var(--radius-full);
		background: var(--bg-raised);
		color: var(--text-secondary);
		font: var(--text-label-13-medium);
	}
	.quote {
		padding-left: var(--space-2);
		border-left: 2px solid var(--border-strong);
		color: var(--text-secondary);
		font: var(--text-caption-12-regular);
		overflow-wrap: anywhere;
	}
	.exact {
		padding: var(--space-3);
		border-radius: var(--radius-12);
		background: var(--bg-raised);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.count {
		margin: 0;
		font: var(--text-caption-12-regular);
		color: var(--text-secondary);
	}
	.count.over {
		color: var(--warn);
	}
	.note {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		margin: 0;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-12);
		font: var(--text-label-13-regular);
	}
	.note.info {
		background: var(--info-subtle);
		color: var(--info);
	}
	.note.warn {
		background: var(--warn-subtle);
		color: var(--warn);
	}
	.note.ok {
		background: var(--accent-subtle);
		color: var(--accent);
	}
	.hint {
		margin: 0;
		font: var(--text-caption-12-regular);
		color: var(--text-secondary);
	}
	.actions {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.btn {
		min-height: var(--touch-min);
		padding: 0 var(--space-4);
		border-radius: var(--radius-full);
		font: var(--text-label-13-medium);
	}
	.btn.ghost {
		background: transparent;
		color: var(--text-primary);
		border: 1px solid var(--border-strong);
	}
	.btn.send {
		flex: 1;
		background: var(--accent);
		color: var(--text-on-accent);
	}
	.btn:disabled {
		opacity: 0.5;
	}
</style>
