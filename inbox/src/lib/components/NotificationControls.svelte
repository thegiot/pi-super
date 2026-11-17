<script lang="ts">
	import { onMount } from "svelte";
	import { notifications } from "$lib/notifications.svelte";

	onMount(() => { void notifications.inspect(); });
</script>

<details class="notifications" ontoggle={(e) => { if (e.currentTarget.open) void notifications.inspect(); }}>
	<summary>Notifiche</summary>
	<div class="content">
		<p>Web Push per questa SPA, solo nei browser compatibili e in contesto sicuro. Non è garantito nelle WebView.</p>
		<p>Le notifiche possono mostrare conteggi e titoli delle chat, mai il testo dei messaggi. I titoli possono essere visibili sulla schermata di blocco e al servizio push del browser.</p>
		{#if notifications.checked && !notifications.supported}
			<p class="warn">Notifiche non disponibili: servono HTTPS, Notification, PushManager e service worker.</p>
		{:else}
			<p aria-live="polite">{notifications.subscribed ? "Iscrizione presente su questo browser." : "Nessuna iscrizione attiva su questo browser."}</p>
			{#if notifications.permission === "denied"}<p class="warn">Permesso bloccato: cambialo nelle impostazioni del browser per attivare.</p>{/if}
			<div class="actions">
				<button type="button" disabled={!notifications.checked || notifications.busy} onclick={() => void notifications.enable()}>
					{notifications.subscribed ? "Riattiva / sincronizza" : "Attiva notifiche"}
				</button>
				<button type="button" disabled={!notifications.checked || notifications.busy} onclick={() => void notifications.disable()}>
					{notifications.pendingDelete ? "Riprova disattivazione" : "Disattiva notifiche"}
				</button>
			</div>
		{/if}
		{#if notifications.busy}<p role="status">Aggiornamento notifiche…</p>{/if}
		{#if notifications.message}<p role="status">{notifications.message}</p>{/if}
		{#if notifications.error}<p class="error" role="alert">{notifications.error}</p>{/if}
	</div>
</details>

<style>
	.notifications { padding: 0 var(--space-4); border-bottom: 1px solid var(--border-subtle); max-height: 45vh; overflow-y: auto; flex-shrink: 0; }
	summary { cursor: pointer; min-height: var(--touch-min); align-content: center; font: var(--text-label-13-medium); }
	.content { padding-bottom: var(--space-3); }
	p { margin: 0 0 var(--space-2); font: var(--text-caption-12-regular); color: var(--text-secondary); overflow-wrap: anywhere; }
	.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
	button { min-height: var(--touch-min); padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-full); color: var(--accent); font: var(--text-label-13-medium); }
	button:disabled { opacity: 0.5; cursor: default; }
	.warn { color: var(--warn); }
	.error { color: var(--danger); }
</style>
