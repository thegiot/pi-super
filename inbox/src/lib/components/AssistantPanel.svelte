<script lang="ts">
	import { tick } from "svelte";
	import { assistant, assistantErrorText, type Turn } from "$lib/assistant.svelte";
	import { inbox } from "$lib/inbox.svelte";
	import IconButton from "./IconButton.svelte";
	import Icon from "./Icon.svelte";

	let { chatId }: { chatId: string } = $props();

	const CHIPS = ["Riassumi", "Cosa mi chiede?", "Proponi risposta", "Perché è da rispondere?"];

	let question = $state("");
	let copied = $state(false);
	let panel: HTMLElement | undefined = $state();
	let thread = $derived(assistant.thread(chatId));
	const lastDraft = $derived(findDraft(thread.turns));
	const available = $derived(inbox.state?.assistant.status === "ok");

	function findDraft(turns: Turn[]): Turn["draft"] {
		for (let i = turns.length - 1; i >= 0; i--) {
			const d = turns[i]!.draft;
			if (d) return d;
		}
		return null;
	}

	function languageName(code: string): string {
		return code.toLowerCase().startsWith("it") ? "italiano" : code;
	}

	function send(text: string) {
		question = "";
		void assistant.ask(chatId, text);
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
		if (assistant.open && !assistant.columns) void tick().then(() => panel?.querySelector<HTMLElement>("button")?.focus());
	});
</script>

{#snippet body()}
	<header class="head">
		<span class="title"><Icon name="sparkles" size={20} /> Assistente</span>
		<IconButton icon="x" label="Chiudi assistente" onclick={() => assistant.close()} />
	</header>

	<p class="scope">
		{#if thread.contextMessages === null}
			Conoscerà gli ultimi messaggi di questa chat. Nient'altro.
		{:else}
			Conosce gli ultimi {thread.contextMessages} messaggi di questa chat. Nient'altro.
		{/if}
	</p>

	<div class="thread" aria-live="polite" aria-busy={thread.busy}>
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
						<p class="draft-note">Non viene inviata da qui. Copiala e inviala dall'app.</p>
						<div class="draft-actions">
							<button type="button" class="btn" onclick={() => copy(t.draft?.text ?? "")}>{copied ? "Copiata" : "Copia"}</button>
							<button type="button" class="btn ghost" disabled={thread.busy} onclick={() => assistant.reformulate(chatId)}>Riformula</button>
						</div>
					</section>
				{/if}
			{/if}
		{/each}
		{#if thread.busy}
			<p class="thinking">Sto leggendo la chat…</p>
		{/if}
	</div>

	<div class="chips" role="group" aria-label="Suggerimenti">
		{#each CHIPS as c (c)}
			<button type="button" class="chip" disabled={thread.busy || !available} onclick={() => send(c)}>{c}</button>
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
		<p class="error">L'assistente non è configurato: manca la chiave del modello.</p>
	{/if}
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
	}
	.column {
		flex: 0 0 400px;
		border-left: 1px solid var(--border-subtle);
		overflow-y: auto;
	}
	.sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		height: 85vh;
		border-radius: var(--radius-16) var(--radius-16) 0 0;
		z-index: 20;
		overflow-y: auto;
		padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom));
	}
	.scrim {
		position: fixed;
		inset: 0;
		background: var(--bg-scrim);
		z-index: 19;
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
	.thread {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-height: 0;
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
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.chip {
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
		margin-top: auto;
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
