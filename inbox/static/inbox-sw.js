/* Notifications only: no fetch handler, cache, message history or credential storage. */
function inboxURL(value) {
	if (typeof value !== "string" || !value.startsWith("/inbox/") || /[\\\u0000-\u0020]/.test(value)) return "/inbox/";
	try {
		const url = new URL(value, self.location.origin);
		if (url.origin === self.location.origin && url.pathname.startsWith("/inbox/")) return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		// Invalid notification targets stay inside the inbox.
	}
	return "/inbox/";
}

self.addEventListener("push", (event) => {
	let payload;
	try { payload = event.data?.json(); } catch { return; }
	if (!payload || typeof payload.title !== "string" || typeof payload.body !== "string" || typeof payload.url !== "string" || typeof payload.tag !== "string") return;
	// The server's title/body contract is counts and authorized chat titles only, never message text.
	event.waitUntil(self.registration.showNotification(payload.title, {
		body: payload.body,
		tag: payload.tag,
		data: { url: inboxURL(payload.url) },
	}));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = inboxURL(event.notification.data?.url);
	event.waitUntil((async () => {
		const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
		for (const client of windows) {
			const current = new URL(client.url);
			if (current.origin !== self.location.origin || !current.pathname.startsWith("/inbox/")) continue;
			try {
				const navigated = current.href === new URL(url, self.location.origin).href ? client : await client.navigate(url);
				if (navigated) { await navigated.focus(); return; }
			} catch {
				// A closing tab must not prevent opening a valid inbox destination.
			}
		}
		await self.clients.openWindow(url);
	})());
});
