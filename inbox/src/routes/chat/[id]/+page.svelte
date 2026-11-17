<script lang="ts">
	import { page } from "$app/state";
	import ChatPane from "$lib/components/ChatPane.svelte";

	const id = $derived(page.params.id ?? "");
</script>

<ChatPane {id} />
