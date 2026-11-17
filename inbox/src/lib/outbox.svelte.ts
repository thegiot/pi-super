import { api, ApiError, type OutboxIntent, type OutboxState } from "./api";
import { composer } from "./composer.svelte";

export interface ReviewSession {
	intent: OutboxIntent;
	text: string;
	composerRevision: number;
	confirmToken: string;
	expiresAt?: string;
	outcome: boolean;
	stale: boolean;
	busy: boolean;
	error?: string;
}
const NON_FINAL_BUBBLE: ReadonlySet<OutboxState> = new Set(["sending", "pending", "uncertain", "failed", "not_found"]);
function describe(err: unknown): string {
	return err instanceof ApiError ? err.message : "network";
}
class OutboxStore {
	intents = $state<Record<string, OutboxIntent>>({});
	private texts = new Map<string, string>();
	private keys = new Map<string, string>();
	private intentKeys = new Map<string, { dedupe: string; key: string }>();
	private handedOff = new Set<string>();
	review = $state<ReviewSession | null>(null);
	lastError = $state<string | null>(null);
	directBusy = $state<Record<string, boolean>>({});
	apply(intent: OutboxIntent): void {
		// The socket can report delivery before an older HTTP response arrives.
		const current = this.intents[intent.id];
		if (current?.state === "sent") intent = current;
		this.intents[intent.id] = intent;
		if (this.review?.intent.id === intent.id) this.review.intent = intent;
		// A lost confirm response leaves the original composer text available to retry.
		// Keep its key until the client has also acknowledged the handoff.
		if (intent.state === "sent" && this.handedOff.has(intent.id)) {
			const registered = this.intentKeys.get(intent.id);
			if (registered && this.keys.get(registered.dedupe) === registered.key) this.keys.delete(registered.dedupe);
			this.intentKeys.delete(intent.id);
			this.handedOff.delete(intent.id);
		}
	}
	textOf(intentID: string): string | undefined { return this.texts.get(intentID); }
	pendingFor(chatID: string): { intent: OutboxIntent; text: string }[] {
		return Object.values(this.intents)
			.filter((intent) => intent.chatID === chatID && NON_FINAL_BUBBLE.has(intent.state))
			.map((intent) => ({ intent, text: this.texts.get(intent.id) ?? "" }))
			.filter((pending) => pending.text !== "");
	}
	private async createSession(chatID: string, text: string, replyToMessageID?: string): Promise<ReviewSession | null> {
		const composerRevision = composer.revision(chatID);
		this.lastError = null;
		const dedupe = JSON.stringify([chatID, text, replyToMessageID ?? null]);
		let key = this.keys.get(dedupe);
		if (!key) {
			key = crypto.randomUUID();
			this.keys.set(dedupe, key);
		}
		try {
			const created = await api.createIntent({ key, chatID, text, ...(replyToMessageID ? { replyToMessageID } : {}) });
			this.intentKeys.set(created.intent.id, { dedupe, key });
			this.apply(created.intent);
			this.texts.set(created.intent.id, text);
			return {
				intent: created.intent, text, composerRevision,
				confirmToken: created.confirmToken ?? "",
				expiresAt: created.expiresAt,
				outcome: created.intent.state !== "pending_confirm",
				stale: !created.confirmToken, busy: false,
			};
		} catch (err) {
			this.lastError = describe(err);
			return null;
		}
	}
	async openReview(chatID: string, text: string, replyToMessageID?: string): Promise<boolean> {
		const session = await this.createSession(chatID, text, replyToMessageID);
		if (!session) return false;
		this.review = session;
		return true;
	}
	async sendDirect(chatID: string, text: string, replyToMessageID?: string): Promise<boolean> {
		if (this.directBusy[chatID]) return false;
		this.directBusy[chatID] = true;
		try {
			const session = await this.createSession(chatID, text, replyToMessageID);
			if (!session) return false;
			const accepted = await this.confirmSession(session);
			this.review = session;
			if (accepted) composer.clearIfRevision(chatID, session.composerRevision);
			return accepted;
		} finally {
			this.directBusy[chatID] = false;
		}
	}
	closeReview(): void { this.review = null; }
	async confirm(): Promise<boolean> {
		const session = this.review;
		return session ? this.confirmSession(session) : false;
	}
	private async confirmSession(session: ReviewSession): Promise<boolean> {
		if (session.intent.state === "sent") {
			this.handedOff.add(session.intent.id);
			this.apply(session.intent);
			return true;
		}
		if (session.stale || session.busy || session.outcome) return false;
		session.busy = true;
		session.error = undefined;
		try {
			const intent = await api.confirm(session.intent.id, session.confirmToken);
			this.handedOff.add(intent.id);
			this.apply(intent);
			session.intent = this.intents[intent.id] ?? intent;
			session.outcome = true;
			return true;
		} catch (err) {
			if (err instanceof ApiError && (err.status === 409 || err.status === 410)) session.stale = true;
			session.error = describe(err);
			return false;
		} finally {
			session.busy = false;
		}
	}
	async reissue(): Promise<boolean> {
		const session = this.review;
		if (!session || session.busy) return false;
		session.busy = true;
		session.error = undefined;
		try {
			const created = await api.reissue(session.intent.id, session.text);
			this.apply(created.intent);
			session.intent = created.intent;
			session.confirmToken = created.confirmToken ?? "";
			session.expiresAt = created.expiresAt;
			session.outcome = false;
			session.stale = !created.confirmToken;
			return true;
		} catch (err) {
			session.error = describe(err);
			return false;
		} finally {
			session.busy = false;
		}
	}
	async reconcile(): Promise<void> {
		const session = this.review;
		if (!session || session.busy) return;
		session.busy = true;
		session.error = undefined;
		try {
			this.apply(await api.reconcile(session.intent.id));
		} catch (err) {
			session.error = describe(err);
		} finally {
			session.busy = false;
		}
	}
}
export const outbox = new OutboxStore();

/** Italian copy for the outbox error codes and failure reasons. */
export function outboxErrorText(code: string): string {
	switch (code) {
		case "confirm_invalid":
		case "confirm_expired":
			return "Testo cambiato o conferma scaduta, controlla e riprova.";
		case "outbox_rate_limited":
			return "Troppe conferme in un minuto: attendi e riprova.";
		case "beeper_unavailable":
			return "Beeper non risponde: l'invio non è partito. Riprova quando torna.";
		case "chat_not_sendable":
			return "In questa chat non puoi scrivere.";
		case "unauthorized":
			return "Beeper ha rifiutato il token.";
		default:
			if (code.startsWith("beeper_http_")) return `Beeper ha rifiutato l'invio (${code.slice(12)}).`;
			if (code.startsWith("fail_")) return `La rete non ha consegnato il messaggio (${code}).`;
			return "Errore di rete. Riprova.";
	}
}
