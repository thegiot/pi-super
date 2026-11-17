<script lang="ts">
	import { fileSize, kindLabel } from "$lib/format";
	import type { MessageView } from "$lib/api";
	import Icon from "./Icon.svelte";

	let { attachment }: { attachment: MessageView["attachments"][number] } = $props();
	let failed = $state(false);
	const isImage = $derived(attachment.kind === "image" || attachment.kind === "sticker");
	const label = $derived(
		[kindLabel(attachment.kind), attachment.name, fileSize(attachment.size)].filter(Boolean).join(" · "),
	);
</script>

{#if isImage && !failed}
	<a class="image" href={attachment.url} target="_blank" rel="noopener noreferrer" aria-label="Apri immagine in una nuova scheda">
		<img
			src={attachment.url}
			alt={attachment.name ?? kindLabel(attachment.kind)}
			loading="lazy"
			width={attachment.width}
			height={attachment.height}
			onerror={() => (failed = true)}
		/>
	</a>
{:else}
	<p class="placeholder">
		<Icon name={attachment.kind === "image" ? "image" : "paperclip"} size={16} />
		<span>[{label}]</span>
	</p>
{/if}

<style>
	.image {
		display: block;
		max-width: 100%;
		border-radius: var(--radius-12);
		overflow: hidden;
	}
	img {
		display: block;
		max-width: 100%;
		max-height: 320px;
		height: auto;
		background: var(--bg-raised);
	}
	.placeholder {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-12);
		background: var(--bg-surface);
		color: var(--text-secondary);
		font: var(--text-label-13-regular);
		overflow-wrap: anywhere;
	}
</style>
