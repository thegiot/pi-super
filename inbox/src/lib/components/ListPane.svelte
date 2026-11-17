<script lang="ts">
	import { base } from "$app/paths";
	import { inbox } from "$lib/inbox.svelte";
	import { clock, updatedText } from "$lib/format";
	import TopBar from "./TopBar.svelte";
	import IconButton from "./IconButton.svelte";
	import Banner from "./Banner.svelte";
	import EmptyState from "./EmptyState.svelte";
	import FilterTabs from "./FilterTabs.svelte";
	import NetworkFilter from "./NetworkFilter.svelte";
	import ConversationRow from "./ConversationRow.svelte";
	import NotificationControls from "./NotificationControls.svelte";

	let { selectedId }: { selectedId?: string } = $props();

	let searchOpen = $state(false);

	function focusOnMount(node: HTMLInputElement) {
		node.focus();
	}

	const status = $derived(inbox.state?.beeper.status);
	const subtitle = $derived(
		status === "unreachable"
			? "Beeper non raggiungibile"
			: `${inbox.state?.accounts.length ?? 0} account · ${updatedText(inbox.state?.updatedAt ?? inbox.listUpdatedAt, inbox.now)}`,
	);

	const emptyTitle = $derived(
		inbox.query.trim()
			? `Nessun risultato per «${inbox.query.trim()}»`
			: inbox.filter === "reply"
				? "Niente da rispondere"
				: inbox.filter === "unread"
					? "Nessun messaggio non letto"
					: "Nessuna chat",
	);

	function openSearch() {
		searchOpen = true;
	}

	function closeSearch() {
		searchOpen = false;
		inbox.setQuery("");
	}
</script>

<section class="pane" aria-label="Inbox">
	<TopBar title="Inbox" {subtitle}>
		{#snippet leading()}
			<IconButton icon="terminal" label="Torna a pi-super" href="/" />
		{/snippet}
		{#snippet actions()}
			<IconButton
				icon={searchOpen ? "x" : "search"}
				label={searchOpen ? "Chiudi ricerca" : "Cerca"}
				onclick={() => (searchOpen ? closeSearch() : openSearch())}
				expanded={searchOpen}
			/>
		{/snippet}
	</TopBar>
	<NotificationControls />

	{#if searchOpen}
		<div class="search">
			<input
				{@attach focusOnMount}
				type="search"
				placeholder="Cerca per nome o partecipante"
				aria-label="Cerca chat"
				value={inbox.query}
				oninput={(e) => inbox.setQuery(e.currentTarget.value)}
			/>
		</div>
	{/if}

	{#if status === "slow"}
		<div class="progress" role="progressbar" aria-label="Aggiornamento in corso" aria-busy="true"></div>
	{/if}

	{#if inbox.socket === "lost"}
		<Banner tone="warn" icon="refresh-cw">Connessione persa, riprovo…</Banner>
	{/if}

	{#if status === "unreachable"}
		<Banner tone="danger" icon="cloud-off">
			Beeper non è raggiungibile. Lettura sospesa.
			{#snippet action()}
				<button type="button" class="link" onclick={() => inbox.retry()}>Riprova ora</button>
			{/snippet}
		</Banner>
	{:else if status === "unauthorized"}
		<Banner tone="danger" icon="alert-triangle">Beeper ha rifiutato il token dell'inbox.</Banner>
	{:else if status === "unconfigured"}
		<Banner tone="warn" icon="alert-triangle">Inbox non configurata: manca il token di Beeper.</Banner>
	{/if}

	{#if inbox.listError && !inbox.degraded}
		<Banner tone="danger" icon="alert-triangle">Impossibile caricare la lista: {inbox.listError}</Banner>
	{/if}

	{#if inbox.unreachable}
		<FilterTabs />
		<EmptyState icon="cloud-off" title="Beeper non risponde su K29">
			<p>
				Beeper Desktop non è in esecuzione: di solito la sessione grafica di K29 non è avviata. Assistente e invio
				restano disabilitati finché non torna.
			</p>
			<p class="last">
				Ultimo contatto riuscito: {inbox.state?.beeper.lastOkAt ? clock(inbox.state.beeper.lastOkAt) : "mai"}
			</p>
			{#snippet actions()}
				<button type="button" class="btn" onclick={() => inbox.retry()}>Riprova ora</button>
			{/snippet}
		</EmptyState>
	{:else if status === "unauthorized" || status === "unconfigured"}
		<FilterTabs />
		<EmptyState
			icon="alert-triangle"
			title={status === "unauthorized" ? "Token non accettato" : "Inbox non configurata"}
		>
			<p>
				Crea un token in Beeper → Impostazioni → Integrazioni e salvalo nel file del token di pi-super.
			</p>
		</EmptyState>
	{:else}
		<FilterTabs />
		<NetworkFilter />
		{#if inbox.listLoaded && inbox.chats.length === 0}
			<EmptyState icon={inbox.filter === "reply" ? "check" : "search"} title={emptyTitle}>
				<p>Le conversazioni compaiono qui quando cambiano stato.</p>
			</EmptyState>
		{:else}
			<ul class="list" aria-label="Chat">
				{#each inbox.chats as chat (chat.id)}
					<li>
						<ConversationRow {chat} selected={chat.id === selectedId} />
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</section>

<style>
	.pane {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--bg-base);
	}
	.search {
		padding: var(--space-2) var(--space-4);
	}
	.search input {
		width: 100%;
		min-height: var(--touch-min);
		padding: 0 var(--space-4);
		border-radius: var(--radius-full);
		border: 1px solid var(--border-strong);
		background: var(--bg-surface);
	}
	.progress {
		height: 2px;
		margin: 0 var(--space-4);
		background: linear-gradient(90deg, transparent, var(--info), transparent);
		background-size: 50% 100%;
		background-repeat: no-repeat;
		animation: slide 1.4s linear infinite;
	}
	@keyframes slide {
		from {
			background-position: -50% 0;
		}
		to {
			background-position: 150% 0;
		}
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		flex: 1;
		min-height: 0;
	}
	.last {
		color: var(--text-secondary);
	}
	.btn,
	.link {
		min-height: var(--touch-min);
		padding: 0 var(--space-4);
		border-radius: var(--radius-full);
		font: var(--text-label-13-medium);
	}
	.btn {
		background: var(--accent);
		color: var(--text-on-accent);
	}
	.link {
		color: var(--accent);
	}
</style>
