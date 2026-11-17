import { api, ApiError } from "./api";

function describe(err: unknown): string {
	return err instanceof ApiError || err instanceof Error ? err.message : "Errore di rete";
}

function activation(registration: ServiceWorkerRegistration): Promise<void> {
	if (registration.active) return Promise.resolve();
	const worker = registration.installing ?? registration.waiting;
	if (!worker) return Promise.reject(new Error("Service worker non disponibile."));
	return new Promise((resolve, reject) => {
		const finish = (error?: Error) => {
			clearTimeout(timer);
			worker.removeEventListener("statechange", changed);
			if (error) reject(error); else resolve();
		};
		const changed = () => {
			if (worker.state === "activated") finish();
			else if (worker.state === "redundant") finish(new Error("Service worker non attivato."));
		};
		const timer = setTimeout(() => finish(new Error("Attivazione notifiche scaduta: riprova.")), 15_000);
		worker.addEventListener("statechange", changed);
		changed();
	});
}

function applicationKey(publicKey: string): Uint8Array<ArrayBuffer> {
	const value = publicKey.replace(/-/g, "+").replace(/_/g, "/");
	const decoded = atob(value.padEnd(Math.ceil(value.length / 4) * 4, "="));
	if (decoded.length !== 65) throw new Error("Chiave pubblica notifiche non valida.");
	return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

class NotificationControls {
	supported = $state(false);
	checked = $state(false);
	busy = $state(false);
	subscribed = $state(false);
	permission = $state<NotificationPermission>("default");
	error = $state<string | null>(null);
	message = $state<string | null>(null);
	// Kept only in page memory, so a failed server revocation can be retried after navigating chats.
	pendingDelete = $state<string | null>(null);

	async inspect(): Promise<void> {
		this.supported = typeof window !== "undefined" && window.isSecureContext && "Notification" in window && "PushManager" in window && "serviceWorker" in navigator;
		this.checked = true;
		if (!this.supported || this.busy) return;
		this.permission = Notification.permission;
		try {
			const registration = await navigator.serviceWorker.getRegistration("/inbox/");
			const own = registration?.scope === new URL("/inbox/", location.origin).href ? registration : undefined;
			const subscription = await own?.pushManager.getSubscription();
			if (!this.busy) this.subscribed = Boolean(subscription);
		} catch (err) {
			this.error = `Impossibile verificare le notifiche: ${describe(err)}`;
		}
	}

	async enable(): Promise<void> {
		if (!this.supported || this.busy) return;
		this.busy = true;
		this.error = null;
		this.message = null;
		try {
			// This call stays before the first await/network request: only the explicit gesture asks permission.
			this.permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
			if (this.permission !== "granted") throw new Error(this.permission === "denied" ? "Permesso negato. Puoi modificarlo nelle impostazioni del browser." : "Permesso non concesso: notifiche non attivate.");
			if (this.pendingDelete) {
				await api.unsubscribe(this.pendingDelete);
				this.pendingDelete = null;
			}
			const { publicKey } = await api.notifications();
			const registration = await navigator.serviceWorker.register("/inbox/inbox-sw.js", { scope: "/inbox/" });
			await activation(registration);
			const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationKey(publicKey) });
			this.subscribed = true;
			await api.subscribe(subscription.toJSON());
			this.message = "Notifiche attivate su questo browser.";
		} catch (err) {
			this.error = `Attivazione non completata: ${describe(err)} Puoi riprovare o disattivare.`;
		} finally {
			this.busy = false;
		}
	}

	async disable(): Promise<void> {
		if (!this.supported || this.busy) return;
		this.busy = true;
		this.error = null;
		this.message = null;
		try {
			const registration = await navigator.serviceWorker.getRegistration("/inbox/");
			const own = registration?.scope === new URL("/inbox/", location.origin).href ? registration : undefined;
			const subscription = await own?.pushManager.getSubscription();
			this.subscribed = Boolean(subscription);
			if (subscription) this.pendingDelete = subscription.endpoint;
			const errors: string[] = [];
			if (subscription) {
				try {
					const removed = await subscription.unsubscribe();
					this.subscribed = Boolean(await own?.pushManager.getSubscription());
					if (!removed && this.subscribed) throw new Error("Il browser non ha revocato l'iscrizione.");
				} catch (err) { errors.push(`Revoca browser: ${describe(err)}`); }
			} else this.subscribed = false;
			if (this.pendingDelete) {
				try {
					await api.unsubscribe(this.pendingDelete);
					this.pendingDelete = null;
				} catch (err) { errors.push(`Revoca server: ${describe(err)}`); }
			}
			if (errors.length) throw new Error(`${errors.join(" ")} Riprova Disattiva per completare la revoca.`);
			this.message = "Notifiche disattivate su questo browser. Il permesso del browser resta gestibile dalle sue impostazioni.";
		} catch (err) {
			this.error = describe(err);
		} finally {
			this.busy = false;
		}
	}
}

export const notifications = new NotificationControls();
