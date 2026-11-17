// The Inbox entry in the top bar, badged with how many chats wait for a reply. The
// inbox is a separate page under /inbox/, so this is the only thing the main app does
// with it. A 404 means the server runs with --no-inbox: the button stays hidden.
const POLL_MS = 60_000;

export function startInboxBadge(button: HTMLElement, badge: HTMLElement): void {
	const poll = async (): Promise<void> => {
		try {
			const res = await fetch("/api/inbox/state", { credentials: "same-origin" });
			if (!res.ok) {
				button.hidden = true;
				return;
			}
			const state = (await res.json()) as { counts?: { reply?: number } };
			const n = state.counts?.reply ?? 0;
			button.hidden = false;
			badge.hidden = n === 0;
			badge.textContent = String(n);
			button.setAttribute("aria-label", `Inbox, ${n} da rispondere`);
		} catch {
			// offline or restarting: keep what is shown until the next poll
		}
	};
	void poll();
	setInterval(() => void poll(), POLL_MS);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") void poll();
	});
}
