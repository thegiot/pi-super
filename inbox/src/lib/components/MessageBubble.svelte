<script lang="ts">
	import type { MessageView } from "$lib/api";
	import { clock, kindLabel } from "$lib/format";
	import Attachment from "./Attachment.svelte";

	let {
		message,
		group,
		replyTo,
	}: { message: MessageView; group: boolean; replyTo?: MessageView | undefined } = $props();

	const snippet = $derived.by(() => {
		if (!replyTo) return undefined;
		if (replyTo.deleted) return "Messaggio eliminato";
		const body = replyTo.text ?? (replyTo.attachments[0] ? replyTo.attachments[0].name : kindLabel(replyTo.kind));
		return body ? body.slice(0, 80) : kindLabel(replyTo.kind);
	});
</script>

<article class="bubble" class:sent={message.isSender} class:received={!message.isSender} aria-label={message.isSender ? "Tuo messaggio" : undefined}>
	{#if group && !message.isSender && message.senderName}
		<p class="sender">{message.senderName}</p>
	{/if}
	{#if snippet !== undefined}
		<p class="reply"><span aria-hidden="true">↩</span> {replyTo?.senderName ? `${replyTo.senderName}: ` : ""}{snippet}</p>
	{/if}
	{#if message.deleted}
		<p class="deleted">Messaggio eliminato</p>
	{:else}
		{#each message.attachments as a (a.index)}
			<Attachment attachment={a} />
		{/each}
		{#if message.text}
			<p class="text">{message.text}</p>
		{:else if message.attachments.length === 0 && message.kind !== "text"}
			<p class="placeholder">[{kindLabel(message.kind) || "Contenuto"}]</p>
		{/if}
	{/if}
	{#if message.reactions.length > 0}
		<p class="reactions" aria-label="Reazioni">
			{message.reactions.map((r) => `${r.key} ${r.count}`).join("  ")}
		</p>
	{/if}
	<p class="meta">{message.edited ? "modificato · " : ""}{clock(message.timestamp)}</p>
</article>

<style>
	.bubble {
		max-width: min(80%, 520px);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-16);
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.received {
		align-self: flex-start;
		background: var(--bg-raised);
	}
	.sent {
		align-self: flex-end;
		background: var(--accent-subtle);
	}
	.sender {
		margin: 0;
		font: var(--text-caption-12-medium);
		color: var(--info);
	}
	.reply {
		margin: 0;
		padding-left: var(--space-2);
		border-left: 2px solid var(--border-strong);
		font: var(--text-caption-12-regular);
		color: var(--text-secondary);
		overflow-wrap: anywhere;
	}
	.text {
		margin: 0;
		font: var(--text-body-15-regular);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.deleted,
	.placeholder {
		margin: 0;
		font: var(--text-label-13-regular);
		color: var(--text-secondary);
		font-style: italic;
	}
	.reactions {
		margin: 0;
		font: var(--text-caption-12-regular);
		color: var(--text-secondary);
	}
	.meta {
		margin: 0;
		align-self: flex-end;
		font: var(--text-caption-12-regular);
		color: var(--text-secondary);
	}
</style>
