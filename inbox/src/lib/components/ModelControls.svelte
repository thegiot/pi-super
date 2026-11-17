<script lang="ts">
	import { onDestroy } from "svelte";
	import { api, ApiError, type ChatSummary } from "$lib/api";
	import { inbox } from "$lib/inbox.svelte";
	import { assistant } from "$lib/assistant.svelte";

	let { chat, importance = true }: { chat: ChatSummary; importance?: boolean } = $props();
	let busy = $state(false);
	let error = $state<string | null>(null);
	let showEvaluation = $state(false);
	let alive = true;
	let generation = 0;
	const excluded = $derived(Boolean(chat.modelPrivacy?.chatExcluded || chat.modelPrivacy?.networkExcluded));
	const evaluation = $derived(chat.importance);

	onDestroy(() => { alive = false; generation++; });

	async function evaluate() {
		if (busy || excluded || inbox.modelPrivacyBusy || !chat.labels.needsReply) return;
		const id = chat.id;
		const request = ++generation;
		busy = true;
		error = null;
		showEvaluation = true;
		try {
			const result = await api.importance(id);
			if (!alive || request !== generation || excluded || inbox.modelPrivacyBusy) return;
			inbox.applySummary({ ...result.chat, importance: result.evaluation });
			inbox.scheduleList();
		} catch (err) {
			if (alive && request === generation) error = err instanceof ApiError ? err.message : "Valutazione non disponibile: errore di rete.";
		} finally {
			if (alive && request === generation) busy = false;
		}
	}

	async function exclude(scope: "chat" | "network", on: boolean) {
		if (inbox.modelPrivacyBusy) return;
		const id = chat.id;
		generation++;
		busy = false;
		showEvaluation = false;
		error = null;
		inbox.modelPrivacyBusy = true;
		// Even an already running answer must not reintroduce model output after revocation.
		assistant.clear();
		try {
			const summary = await api.modelExclusion(id, scope, on);
			inbox.applyModelPrivacy(summary, scope);
		} catch (err) {
			const message = err instanceof ApiError ? err.message : "Impossibile aggiornare l'esclusione: errore di rete.";
			if (alive) error = message;
			else if (inbox.openId === id) inbox.actionError = message;
		} finally {
			inbox.modelPrivacyBusy = false;
		}
	}
</script>

<details class="model-controls">
	<summary>Modello e privacy</summary>
	<div class="content">
		<label>
			<input type="checkbox" checked={chat.modelPrivacy?.chatExcluded ?? false} disabled={inbox.modelPrivacyBusy}
				onchange={(e) => { const on = e.currentTarget.checked; e.currentTarget.checked = chat.modelPrivacy?.chatExcluded ?? false; void exclude("chat", on); }} />
			Escludi questa chat dal modello
		</label>
		<label>
			<input type="checkbox" checked={chat.modelPrivacy?.networkExcluded ?? false} disabled={inbox.modelPrivacyBusy}
				onchange={(e) => { const on = e.currentTarget.checked; e.currentTarget.checked = chat.modelPrivacy?.networkExcluded ?? false; void exclude("network", on); }} />
			Escludi rete {chat.network} dal modello
		</label>
		<p>Le esclusioni bloccano ogni uso del modello, inclusi assistente e importanza. Non nascondono le chat.</p>
		{#if excluded}<p class="notice">Modello escluso per questa chat.</p>{/if}
	</div>
</details>

{#if importance && chat.labels.needsReply}
	<div class="importance">
		<button type="button" disabled={busy || excluded || inbox.modelPrivacyBusy || inbox.degraded || inbox.state?.assistant.status !== "ok"}
			onclick={() => void evaluate()}>{busy ? "Valutazione…" : "Perché è importante"}</button>
		<p>Solo su richiesta: il modello legge gli ultimi messaggi di questa chat. Può ordinare ed evidenziare, mai rimuovere da «Da rispondere».</p>
		{#if showEvaluation && evaluation && !excluded}
			<section class="evaluation" aria-label="Valutazione di importanza" aria-live="polite">
				<p><strong>Importanza {evaluation.importanza} · fiducia {evaluation.fiducia}</strong></p>
				<p>{evaluation.motivo}</p>
				{#if evaluation.fiducia === "bassa"}
					<p class="notice">Fiducia bassa: nessuna evidenziazione. La chat resta visibile.</p>
				{/if}
				<p class="meta">Contesto: {evaluation.context.messages} messaggi · {evaluation.model}{evaluation.cached ? " · risultato in cache" : ""}</p>
			</section>
		{/if}
	</div>
{/if}
{#if error}<p class="error" role="alert">{error}</p>{/if}

<style>
	.model-controls, .importance { padding: var(--space-2) var(--space-4); border-bottom: 1px solid var(--border-subtle); }
	summary { min-height: var(--touch-min); display: list-item; align-content: center; cursor: pointer; font: var(--text-label-13-medium); }
	.content { display: flex; flex-direction: column; gap: var(--space-1); }
	label { display: flex; align-items: center; gap: var(--space-2); min-height: var(--touch-min); font: var(--text-label-13-regular); }
	input { width: 20px; height: 20px; flex-shrink: 0; accent-color: var(--accent); }
	p { margin: var(--space-1) 0; font: var(--text-caption-12-regular); color: var(--text-secondary); overflow-wrap: anywhere; }
	button { min-height: var(--touch-min); padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-full); color: var(--accent); font: var(--text-label-13-medium); }
	button:disabled { opacity: 0.5; cursor: default; }
	.evaluation { margin-top: var(--space-2); padding: var(--space-2) var(--space-3); background: var(--bg-raised); border-radius: var(--radius-12); }
	.evaluation p { color: var(--text-primary); white-space: pre-wrap; }
	.evaluation .meta { color: var(--text-secondary); }
	.notice, .evaluation .notice { color: var(--warn); }
	.error { padding: var(--space-2) var(--space-4); color: var(--danger); }
</style>
