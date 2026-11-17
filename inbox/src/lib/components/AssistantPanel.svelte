<script lang="ts">
	import { tick } from "svelte";
	import { assistant, assistantErrorText } from "$lib/assistant.svelte";
	import type { AssistantIntent } from "$lib/api";
	import { inbox } from "$lib/inbox.svelte";
	import { composer } from "$lib/composer.svelte";
	import IconButton from "./IconButton.svelte";
	import Icon from "./Icon.svelte";
	import ModelControls from "./ModelControls.svelte";

	let { chatId }: { chatId: string } = $props();

	const CHIPS: { label: string; intent: AssistantIntent }[] = [
		{ label: "Riassumi", intent: "answer" },
		{ label: "Di cosa hanno parlato?", intent: "answer" },
		{ label: "Cosa mi chiede?", intent: "answer" },
		{ label: "Proponi risposta", intent: "draft" },
		{ label: "Perché è da rispondere?", intent: "answer" },
	];

	let question = $state("");
	let copied = $state(false);
	let panel: HTMLElement | undefined = $state();
	/** a draft waiting on "Sostituire o accodare?" before entering the composer */
	let pendingUse = $state<string | null>(null);
	let thread = $derived(assistant.thread(chatId));
	const excluded = $derived(inbox.chat?.id === chatId && Boolean(inbox.chat.modelPrivacy?.chatExcluded || inbox.chat.modelPrivacy?.networkExcluded));
	const available = $derived(inbox.chat?.id === chatId && inbox.state?.assistant.status === "ok" && !excluded && !inbox.modelPrivacyBusy && !inbox.degraded);

	function languageName(code: string): string {
		return code.toLowerCase().startsWith("it") ? "italiano" : code;
	}

	function send(text: string, intent: AssistantIntent = "answer") {
		if (!available || thread.busy || !text.trim()) return;
		question = "";
		void assistant.ask(chatId, text, intent);
	}

	/**
	 * RF14/F4: the only path besides typing that writes into the composer. With a
	 * non-empty field the user picks replace or append; then the assistant closes.
	 */
	function useAsDraft(text: string) {
		if (composer.draft(chatId).text.trim() === "") {
			composer.setText(chatId, text);
			pendingUse = null;
			assistant.close();
		} else {
			pendingUse = text;
		}
	}

	function applyDraft(mode: "replace" | "append") {
		if (pendingUse === null) return;
		const current = composer.draft(chatId).text;
		composer.setText(chatId, mode === "replace" ? pendingUse : `${current}${current.endsWith("\n") ? "" : "\n"}${pendingUse}`);
		pendingUse = null;
		assistant.close();
	}

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => (copied = false), 1600);
		} catch {
			copied = false;
		}
	}

	/** Phone sheet: focus moves in on open, Tab stays inside, Escape or the X closes, focus goes back to the trigger. */
	function trap(e: KeyboardEvent) {
		if (!assistant.open || !panel) return;
		if (e.key === "Escape" && !assistant.columns) {
			e.preventDefault();
			assistant.close();
			return;
		}
		if (e.key !== "Tab") return;
		const items = [...panel.querySelectorAll<HTMLElement>("button, input, textarea, a[href]")].filter((el) => !el.hasAttribute("disabled"));
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
		if (excluded) assistant.clear();
	});

	$effect(() => {
		if (assistant.open && !assistant.columns) void tick().then(() => panel?.querySelector<HTMLElement>("button")?.focus());
	});

	$effect(() => {
		if (!assistant.open || assistant.columns || !panel || !window.visualViewport) return;
		const viewport = window.visualViewport;
		const sheet = panel;
		// Mobile keyboards can shrink only the visual viewport, leaving fixed sheets behind them.
		const resize = () => {
			if (viewport.scale !== 1) return;
			sheet.style.setProperty("--sheet-height", `${viewport.height * 0.9}px`);
			sheet.style.setProperty("--sheet-bottom", `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`);
		};
		resize();
		viewport.addEventListener("resize", resize);
		viewport.addEventListener("scroll", resize);
		return () => {
			viewport.removeEventListener("resize", resize);
			viewport.removeEventListener("scroll", resize);
			sheet.style.removeProperty("--sheet-height");
			sheet.style.removeProperty("--sheet-bottom");
		};
	});
</script>

{#snippet body()}
	<header class="head">
		<span class="title"><Icon name="sparkles" size={20} /> Assistente</span>
		<IconButton icon="x" label="Chiudi assistente" onclick={() => assistant.close()} />
	</header>

	<div class="content">
		<p class="scope">
			{#if thread.contextMessages === null}
				Conoscerà gli ultimi messaggi di questa chat. Nient'altro.
			{:else}
				Conosce gli ultimi {thread.contextMessages} messaggi di questa chat. Nient'altro.
			{/if}
		</p>

		<div class="thread" aria-live="polite" aria-busy={thread.busy}>
			{#if thread.turns.length === 0}
				<p class="intro">Puoi chiedere di cosa hanno parlato ultimamente nel gruppo, un riassunto o un chiarimento, senza preparare né inviare risposte. Per una bozza scegli «Proponi risposta».</p>
			{/if}
			{#each thread.turns as t, i (i)}
				{#if t.role === "user"}
					<p class="bubble me">{t.text}</p>
				{:else if t.error}
					<p class="error" role="alert">{assistantErrorText(t.error)}</p>
				{:else}
					<p class="bubble them">{t.text}</p>
					{#if t.draft}
						<section class="draft" aria-label="Bozza">
							<p class="draft-head"><Icon name="sparkles" size={14} /> Bozza · {languageName(t.draft.language)}</p>
							<p class="draft-text">{t.draft.text}</p>
							<p class="draft-note">Non viene inviata da qui. Passa dal campo di scrittura e da «Rivedi e invia».</p>
							{#if pendingUse !== null}
								<div class="draft-confirm" role="group" aria-label="Il campo non è vuoto">
									<p>Il campo di scrittura non è vuoto.</p>
									<div class="draft-actions">
										<button type="button" class="btn" onclick={() => applyDraft("replace")}>Sostituire</button>
										<button type="button" class="btn ghost" onclick={() => applyDraft("append")}>Accodare</button>
										<button type="button" class="btn ghost" onclick={() => (pendingUse = null)}>Annulla</button>
									</div>
								</div>
							{:else}
								<div class="draft-actions">
									<button type="button" class="btn" onclick={() => useAsDraft(t.draft?.text ?? "")}>Usa come bozza</button>
									<button type="button" class="btn ghost" onclick={() => copy(t.draft?.text ?? "")}>{copied ? "Copiata" : "Copia"}</button>
									<button type="button" class="btn ghost" disabled={thread.busy} onclick={() => assistant.reformulate(chatId)}>Riformula</button>
								</div>
							{/if}
						</section>
					{/if}
				{/if}
			{/each}
			{#if thread.busy}
				<p class="thinking">Sto leggendo la chat…</p>
			{/if}
		</div>
		{#if inbox.chat?.id === chatId}
			{#key chatId}<ModelControls chat={inbox.chat} />{/key}
		{/if}
	</div>

	<footer class="footer">
		<div class="chips" role="group" aria-label="Suggerimenti">
			{#each CHIPS as c (c.label)}
				<button type="button" class="chip" disabled={thread.busy || !available} onclick={() => send(c.label, c.intent)}>{c.label}</button>
			{/each}
		</div>

		<form
			class="ask"
			onsubmit={(e) => {
				e.preventDefault();
				send(question);
			}}
		>
			<label class="sr-only" for="ask-input">Chiedi all'assistente</label>
			<input id="ask-input" type="text" placeholder="Chiedi all'assistente" bind:value={question} disabled={!available || thread.busy} />
			<button type="submit" class="btn" disabled={!available || thread.busy || question.trim() === ""}>Chiedi</button>
		</form>
		{#if !available}
			<p class="error">{excluded ? "Modello escluso: assistente e importanza sono disabilitati." : "Assistente non disponibile al momento."}</p>
		{/if}
	</footer>
{/snippet}

<svelte:window onkeydown={trap} />

{#if assistant.open && chatId}
	{#if assistant.columns}
		<aside class="column" bind:this={panel} aria-label="Assistente">
			{@render body()}
		</aside>
	{:else}
		<div class="scrim" role="presentation" onclick={() => assistant.close()}></div>
		<div class="sheet" role="dialog" tabindex="-1" aria-modal="true" aria-label="Assistente" bind:this={panel}>
			<span class="handle" aria-hidden="true"></span>
			{@render body()}
		</div>
	{/if}
{/if}

<style>
	.column,
	.sheet {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4) var(--space-4);
		background: var(--bg-surface);
		color: var(--text-primary);
		min-height: 0;
		min-width: 0;
		overflow: hidden;
	}
	.column {
		flex: 0 0 400px;
		border-left: 1px solid var(--border-subtle);
	}
	.sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: var(--sheet-bottom, 0px);
		height: 90vh;
		height: var(--sheet-height, 90dvh);
		border-radius: var(--radius-16) var(--radius-16) 0 0;
		z-index: 20;
		padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom));
	}
	.scrim {
		position: fixed;
		inset: 0;
		background: var(--bg-scrim);
		z-index: 19;
	}
	.handle {
		flex-shrink: 0;
		align-self: center;
		width: 40px;
		height: 4px;
		border-radius: var(--radius-full);
		background: var(--border-strong);
	}
	.head {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.title {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		font: var(--text-title-17-medium);
		color: var(--info);
	}
	.scope {
		margin: 0;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-12);
		background: var(--info-subtle);
		color: var(--info);
		font: var(--text-caption-12-medium);
	}
	.content {
		flex: 1 1 0;
		min-height: 0;
		min-width: 0;
		overflow-y: auto;
		overscroll-behavior-y: contain;
		scrollbar-gutter: stable;
	}
	.thread {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding-top: var(--space-3);
	}
	.thread > * {
		flex-shrink: 0;
	}
	.intro {
		margin: 0;
		color: var(--text-secondary);
		font: var(--text-body-15-regular);
	}
	.footer {
		flex: 0 0 auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		min-width: 0;
		padding-top: var(--space-3);
		border-top: 1px solid var(--border-subtle);
	}
	.bubble {
		margin: 0;
		max-width: 88%;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-16);
		font: var(--text-body-15-regular);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.me {
		align-self: flex-end;
		background: var(--accent-subtle);
	}
	.them {
		align-self: flex-start;
		background: var(--bg-raised);
	}
	.draft {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3);
		border-radius: var(--radius-12);
		border: 1px solid var(--info);
		background: var(--bg-raised);
	}
	.draft-head {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		margin: 0;
		color: var(--info);
		font: var(--text-caption-12-medium);
	}
	.draft-text {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font: var(--text-body-15-regular);
	}
	.draft-note {
		margin: 0;
		font: var(--text-caption-12-regular);
		color: var(--text-secondary);
	}
	.draft-actions {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.draft-confirm p {
		margin: 0 0 var(--space-1);
		font: var(--text-caption-12-medium);
		color: var(--warn);
	}
	.btn {
		min-height: var(--touch-min);
		padding: 0 var(--space-4);
		border-radius: var(--radius-full);
		background: var(--accent);
		color: var(--text-on-accent);
		font: var(--text-label-13-medium);
	}
	.btn:disabled {
		opacity: 0.5;
	}
	.btn.ghost {
		background: transparent;
		color: var(--accent);
		border: 1px solid var(--border-strong);
	}
	.thinking {
		margin: 0;
		color: var(--text-secondary);
		font: var(--text-label-13-regular);
	}
	.error {
		margin: 0;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-12);
		background: var(--danger-subtle);
		color: var(--danger);
		font: var(--text-label-13-regular);
	}
	.chips {
		display: flex;
		gap: var(--space-2);
		overflow-x: auto;
		overscroll-behavior-x: contain;
	}
	.chip {
		flex: 0 0 auto;
		white-space: nowrap;
		min-height: var(--touch-min);
		padding: 0 var(--space-3);
		border-radius: var(--radius-full);
		border: 1px solid var(--border-strong);
		color: var(--text-primary);
		font: var(--text-label-13-medium);
	}
	.ask {
		display: flex;
		gap: var(--space-2);
	}
	.ask input {
		flex: 1;
		min-width: 0;
		min-height: var(--touch-min);
		padding: 0 var(--space-4);
		border-radius: var(--radius-full);
		border: 1px solid var(--border-strong);
		background: var(--bg-base);
	}
</style>
