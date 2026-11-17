<script lang="ts">
	import { untrack } from "svelte";
	import { assistant } from "$lib/assistant.svelte";
	import { inbox } from "$lib/inbox.svelte";
	let { chatId }: { chatId: string } = $props();
	const selection = $derived(assistant.settings[chatId]);
	const engine = $derived(assistant.options?.engines.find((item) => item.id === selection?.engine));
	const providers = $derived([...new Set(engine?.models.map((model) => model.provider) ?? [])]);
	const models = $derived(engine?.models.filter((model) => model.provider === selection?.provider) ?? []);
	const disabled = $derived(assistant.settingsBusy[chatId] || inbox.modelPrivacyBusy || inbox.degraded);
	$effect(() => { const id = chatId; untrack(() => { void assistant.loadSettings(id); }); });
	function selectEngine(value: string) {
		const choice = assistant.options?.engines.find((item) => item.id === value && item.available);
		if (choice) void assistant.select(chatId, { engine: choice.id, ...choice.default });
	}
	function selectProvider(value: string) {
		const model = engine?.models.find((item) => item.provider === value);
		if (selection && model) void assistant.select(chatId, { ...selection, provider: model.provider, model: model.id });
	}
	function selectModel(value: string) {
		const model = models.find((item) => item.id === value);
		if (selection && model) void assistant.select(chatId, { ...selection, model: model.id });
	}
</script>

{#if selection && assistant.options}
	<div class="settings">
		<label>Motore assistente
			<select aria-label="Motore assistente" value={selection.engine} disabled={disabled} onchange={(event) => selectEngine(event.currentTarget.value)}>
				{#each assistant.options.engines as option (option.id)}
					<option value={option.id} disabled={!option.available}>{option.label}{option.profile ? ` · ${option.profile}` : ""}{!option.available ? " · non disponibile" : ""}</option>
				{/each}
			</select>
		</label>
		<label>Provider
			<select aria-label="Provider" value={selection.provider} disabled={disabled} onchange={(event) => selectProvider(event.currentTarget.value)}>
				{#each providers as provider (provider)}<option value={provider}>{provider}</option>{/each}
			</select>
		</label>
		<label>Modello
			<select aria-label="Modello" value={selection.model} disabled={disabled} onchange={(event) => selectModel(event.currentTarget.value)}>
				{#each models as model (model.id)}<option value={model.id}>{model.label}</option>{/each}
			</select>
		</label>
		<p>La scelta si salva per questa chat. Cambiarla cancella la conversazione dell'assistente.</p>
		{#if assistant.options.engines.some((option) => option.id === "hermes")}
			<p>Hermes usa il profilo chatassistant, la sua memoria e skill, e gli MCP di lettura. Le sessioni vengono salvate.</p>
		{/if}
	</div>
{/if}
{#if assistant.settingsErrors[chatId]}
	<p role="alert">{assistant.settingsErrors[chatId]}</p>
	<button type="button" disabled={disabled} onclick={() => assistant.loadSettings(chatId)}>Ricarica impostazioni</button>
{/if}

<style>
	.settings { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
	label { display: flex; flex-direction: column; gap: var(--space-1); font: var(--text-label-13-medium); }
	select { width: 100%; min-width: 0; min-height: var(--touch-min); padding: var(--space-2); border: 1px solid var(--border-strong); border-radius: var(--radius-8); background: var(--bg-base); color: var(--text-primary); font: var(--text-label-13-regular); }
	p { margin: 0; font: var(--text-caption-12-regular); color: var(--text-secondary); overflow-wrap: anywhere; }
	button { min-height: var(--touch-min); color: var(--accent); }
</style>
