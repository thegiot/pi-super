<script lang="ts">
	import type { IconName } from "$lib/icon-name";

	/** Lucide-style 24 px strokes, hand-written: no icon dependency. */
	const paths: Record<IconName, string[]> = {
		"arrow-left": ["M19 12H5", "m12 19-7-7 7-7"],
		search: ["M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0", "m20 20-3.5-3.5"],
		x: ["M18 6 6 18", "m6 6 12 12"],
		check: ["M20 6 9 17l-5-5"],
		clock: ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0", "M12 7v5l3 2"],
		"alert-triangle": [
			"M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
			"M12 9v4",
			"M12 17h.01",
		],
		"cloud-off": [
			"m2 2 20 20",
			"M5.8 5.8A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.3-8.8 7 7 0 0 0-1.7-2.2",
		],
		"refresh-cw": ["M3 12a9 9 0 0 1 15-6.7L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-15 6.7L3 16", "M8 16H3v5"],
		"more-vertical": ["M12 5h.01", "M12 12h.01", "M12 19h.01"],
		"eye-off": [
			"M9.9 4.2A10.7 10.7 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.2 3.2",
			"M6.6 6.6A18 18 0 0 0 2 12s3 8 10 8a10.6 10.6 0 0 0 5.4-1.5",
			"m2 2 20 20",
		],
		terminal: ["m4 17 6-6-6-6", "M12 19h8"],
		image: [
			"M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
			"M9 9a2 2 0 1 0 0.01 0",
			"m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21",
		],
		paperclip: [
			"m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5",
		],
		users: [
			"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
			"M9 7a4 4 0 1 0 0.01 0",
			"M22 21v-2a4 4 0 0 0-3-3.9",
			"M16 3.1a4 4 0 0 1 0 7.8",
		],
		star: ["m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"],
		pin: ["M12 17v5", "M9 10.8V4h6v6.8l2.4 2.7H6.6z"],
		"corner-up-left": ["M9 14 4 9l5-5", "M20 20v-7a4 4 0 0 0-4-4H4"],
	};

	let { name, size = 24 }: { name: IconName; size?: number } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	focusable="false"
>
	{#each paths[name] as d, i (i)}
		<path {d} />
	{/each}
</svg>
