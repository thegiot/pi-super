import type { MessageView } from "./api";
import { kindLabel } from "./format";

/*
 * The composer draft of each chat, in page memory only (PRD §13: the text in the
 * field must survive an inbox reconnect; nothing is persisted to storage).
 * Typing and requested assistant drafts update the field. Sending clears only its captured revision.
 */

export interface QuoteRef {
	id: string;
	author?: string;
	snippet: string;
}

export interface Draft {
	text: string;
	replyTo?: QuoteRef;
}

const EMPTY: Draft = { text: "" };

export function quoteOf(m: MessageView): QuoteRef {
	const body = m.deleted ? "Messaggio eliminato" : (m.text ?? kindLabel(m.kind));
	return {
		id: m.id,
		...(m.senderName ? { author: m.senderName } : m.isSender ? { author: "tu" } : {}),
		snippet: body.length > 90 ? `${body.slice(0, 90)}…` : body,
	};
}

class ComposerStore {
	drafts = $state<Record<string, Draft>>({});
	focusRequest = $state<{ chatID: string; sequence: number } | null>(null);
	private revisions = new Map<string, number>();
	revision(chatID: string): number {
		return this.revisions.get(chatID) ?? 0;
	}
	focus(chatID: string): void {
		this.focusRequest = { chatID, sequence: (this.focusRequest?.sequence ?? 0) + 1 };
	}
	clearIfRevision(chatID: string, revision: number): void {
		if (this.revision(chatID) === revision) this.clear(chatID);
	}

	draft(chatID: string): Draft {
		return this.drafts[chatID] ?? EMPTY;
	}

	setText(chatID: string, text: string): void {
		this.revisions.set(chatID, this.revision(chatID) + 1);
		this.drafts[chatID] = { ...this.draft(chatID), text };
	}

	setReply(chatID: string, replyTo: QuoteRef | undefined): void {
		this.revisions.set(chatID, this.revision(chatID) + 1);
		this.drafts[chatID] = { ...this.draft(chatID), ...(replyTo ? { replyTo } : { replyTo: undefined }) };
	}

	clear(chatID: string): void {
		this.revisions.set(chatID, this.revision(chatID) + 1);
		delete this.drafts[chatID];
	}
}

export const composer = new ComposerStore();

export function sendsOnEnter(event: Pick<KeyboardEvent, "key" | "shiftKey" | "repeat" | "isComposing" | "keyCode">): boolean {
	return event.key === "Enter" && !event.shiftKey && !event.repeat && !event.isComposing && event.keyCode !== 229;
}
