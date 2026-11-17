<script lang="ts">
	import { onMount } from "svelte";
	type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
	let prompt = $state<InstallPrompt | null>(null);
	let standalone = $state(false);
	let help = $state(false);
	let busy = $state(false);

	onMount(() => {
		standalone = matchMedia("(display-mode: standalone)").matches;
		const available = (event: Event) => { event.preventDefault(); prompt = event as InstallPrompt; };
		const installed = () => { standalone = true; prompt = null; help = false; };
		window.addEventListener("beforeinstallprompt", available);
		window.addEventListener("appinstalled", installed);
		return () => { window.removeEventListener("beforeinstallprompt", available); window.removeEventListener("appinstalled", installed); };
	});

	async function install() {
		if (!prompt) { help = !help; return; }
		const current = prompt;
		prompt = null;
		busy = true;
		try { await current.prompt(); await current.userChoice; }
		catch { help = true; }
		finally { busy = false; }
	}
</script>

{#if !standalone}
	<div class="install">
		<button type="button" disabled={busy} onclick={() => void install()} aria-expanded={help}>Installa app</button>
		{#if help}
			<div class="help" role="status">
				<p>In Chrome Android apri il menu ⋮ e scegli <strong>Installa app</strong> oppure <strong>Aggiungi a schermata Home</strong>. Se l'app è già installata, aprila dalla schermata Home.</p>
				<p>L'installazione non associa il dispositivo: se l'app chiede l'accesso, usa il QR di un browser già autorizzato. Le chat richiedono una connessione.</p>
				<button type="button" onclick={() => help = false}>Chiudi</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	.install { position: relative; }
	button { min-height: var(--touch-min); padding: 0 var(--space-2); color: var(--accent); border-radius: var(--radius-md); font: var(--text-label-13-medium); }
	.help { position: absolute; z-index: 20; right: 0; top: 100%; width: min(300px, 80vw); padding: var(--space-3); background: var(--bg-elevated, #222630); border: 1px solid var(--border-strong); border-radius: var(--radius-md); box-shadow: 0 8px 24px #0008; }
	p { font: var(--text-caption-12-regular); line-height: 1.5; margin: 0 0 var(--space-2); }
</style>
