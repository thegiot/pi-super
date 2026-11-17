import { api, ApiError, type OutboxIntent, type OutboxState } from "./api";

/*
 * Controlled send, client side (PRD §12.2, F5–F6). The store tracks every intent the
 * server reports over /ws/inbox and keeps — in page memory only — the exact text the
 * user wrote, so the review sheet and the pending bubble can show it without the
 * server ever sending text back.
 */

export interface ReviewSession {
	/** the intent under review; replaced by every WS/API update */
	intent: OutboxIntent;
	/** the exact text the sheet shows; also what a retry re-presents to reissue */
	text: string;
	confirmToken: string;
	expiresAt?: string;
	/** true once "Invia" was pressed: the sheet shows the outcome instead of the fields */
	outcome: boolean;
	/** token refused or expired: this confirmation is dead, re-review to send */
	stale: boolean;
	busy: boolean;
	error?: string;
}

const NON_FINAL_BUBBLE: ReadonlySet<OutboxState> = new Set(["sending", "pending", "uncertain", "failed", "not_found"]);

function describe(err: unknown): string {
	if (err instanceof ApiError) return err.message;
	return "network";
}

class OutboxStore {
	intents = $state<Record<string, OutboxIntent>>({});
	/** intent id → the text the user reviewed; page memory only */
	private texts = new Map<string, string>();
	/** (chat+text+reply) → idempotency key, so a retried create is the same intent */
	private keys = new Map<string, string>();
	review = $state<ReviewSession | null>(null);
	lastError = $state<string | null>(null);

	apply(intent: OutboxIntent): void {
		this.intents[intent.id] = intent;
		if (this.review?.intent.id === intent.id) this.review.intent = intent;
	}

	textOf(intentID: string): string | undefined {
		return this.texts.get(intentID);
	}

	/** The draft-turned-send shown in the thread until its outcome is final. */
	pendingFor(chatID: string): { intent: OutboxIntent; text: string }[] {
		return Object.values(this.intents)
			.filter((i) => i.chatID === chatID && NON_FINAL_BUBBLE.has(i.state))
			.map((i) => ({ intent: i, text: this.texts.get(i.id) ?? "" }))
			.filter((p) => p.text !== "");
	}

	/** Rivedi pressed: ask the server to register the intent and open the sheet. */
	async openReview(chatID: string, text: string, replyToMessageID?: string): Promise<boolean> {
		this.lastError = null;
		const dedupe = `${chatID}${text}${replyToMessageID ?? ""}`;
		let key = this.keys.get(dedupe);
		if (!key) {
			key = crypto.randomUUID();
			this.keys.set(dedupe, key);
		}
		try {
			const created = await api.createIntent({ key, chatID, text, ...(replyToMessageID ? { replyToMessageID } : {}) });
			this.apply(created.intent);
			this.texts.set(created.intent.id, text);
			this.review = {
				intent: created.intent,
				text,
				confirmToken: created.confirmToken ?? "",
				expiresAt: created.expiresAt,
				outcome: false,
				stale: !created.confirmToken,
				busy: false,
			};
			return true;
		} catch (err) {
			this.lastError = describe(err);
			return false;
		}
	}

	closeReview(): void {
		this.review = null;
	}

	/** The one and only call that can send. True when the confirm was accepted. */
	async confirm(): Promise<boolean> {
		const r = this.review;
		if (!r || r.stale) return false;
		r.busy = true;
		r.error = undefined;
		try {
			const intent = await api.confirm(r.intent.id, r.confirmToken);
			this.apply(intent);
			r.outcome = true;
			return true;
		} catch (err) {
			if (err instanceof ApiError && (err.status === 409 || err.status === 410)) {
				r.stale = true;
				r.error = err.message;
			} else {
				r.error = describe(err);
			}
			return false;
		} finally {
			r.busy = false;
		}
	}

	/** Riprova: back to the review fields with a fresh token; the sheet re-confirms. */
	async reissue(): Promise<boolean> {
		const r = this.review;
		if (!r) return false;
		r.busy = true;
		r.error = undefined;
		try {
			const created = await api.reissue(r.intent.id, r.text);
			this.apply(created.intent);
			r.intent = created.intent;
			r.confirmToken = created.confirmToken ?? "";
			r.expiresAt = created.expiresAt;
			r.outcome = false;
			r.stale = !created.confirmToken;
			return true;
		} catch (err) {
			r.error = describe(err);
			return false;
		} finally {
			r.busy = false;
		}
	}

	/** Controlla nella cronologia: asks the server to reconcile an uncertain send. */
	async reconcile(): Promise<void> {
		const r = this.review;
		if (!r) return;
		r.busy = true;
		r.error = undefined;
		try {
			this.apply(await api.reconcile(r.intent.id));
		} catch (err) {
			r.error = describe(err);
		} finally {
			r.busy = false;
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
