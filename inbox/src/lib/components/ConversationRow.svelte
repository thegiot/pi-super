<script lang="ts">
	import { base } from "$app/paths";
	import type { ChatSummary } from "$lib/api";
	import { inbox } from "$lib/inbox.svelte";
	import { previewLine, reasonChips, relativeShort } from "$lib/format";
	import Avatar from "./Avatar.svelte";
	import Chip from "./Chip.svelte";
	import NetworkBadge from "./NetworkBadge.svelte";

	let { chat, selected = false }: { chat: ChatSummary; selected?: boolean } = $props();
	const chips = $derived(reasonChips(chat, inbox.now));
	const preview = $derived(previewLine(chat));
</script>

<a
	class="row"
	href="{base}/chat/{encodeURIComponent(chat.id)}"
	aria-current={selected ? "true" : undefined}
	aria-label="{chat.title}, {chat.network}{chat.unreadCount > 0 ? `, ${chat.unreadCount} non letti` : ''}"
>
	<Avatar name={chat.title} network={chat.network} />
	<div class="body">
		<div class="line">
			<span class="title">{chat.title}</span>
			<span class="time">{relativeShort(chat.lastActivity, inbox.now)}</span>
			{#if chat.unreadCount > 0}
				<span class="unread" aria-hidden="true">{chat.unreadCount}</span>
			{/if}
		</div>
		{#if preview}<p class="preview">{preview}</p>{/if}
		<div class="meta">
			<NetworkBadge network={chat.network} />
			{#each chips as c, i (i)}
				<Chip tone={c.tone}>{c.text}</Chip>
			{/each}
		</div>
	</div>
</a>

<style>
	.row {
		display: flex;
		gap: var(--space-3);
		min-height: 72px;
		padding: var(--space-3) var(--space-4);
		border-bottom: 1px solid var(--border-subtle);
		color: var(--text-primary);
		text-decoration: none;
	}
	.row:hover {
		background: var(--bg-surface);
	}
	.row[aria-current="true"] {
		background: var(--bg-raised);
	}
	.body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.line {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.title {
		flex: 1;
		min-width: 0;
		font: var(--text-body-15-medium);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.time {
		font: var(--text-caption-12-regular);
		color: var(--text-secondary);
	}
	.unread {
		display: inline-grid;
		place-items: center;
		min-width: 20px;
		height: 20px;
		padding: 0 6px;
		border-radius: var(--radius-full);
		background: var(--accent);
		color: var(--text-on-accent);
		font: var(--text-caption-12-medium);
	}
	.preview {
		margin: 0;
		font: var(--text-label-13-regular);
		color: var(--text-secondary);
		overflow: hidden;
		display: -webkit-box;
		line-clamp: 2;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-1);
	}
</style>
