import type { MessageView } from "./api";
import { kindLabel } from "./format";

/*
 * The composer draft of each chat, in page memory only (PRD §13: the text in the
 * field must survive an inbox reconnect; nothing is persisted to storage).
 * Written by typing and by the assistant's «Usa come bozza» — nothing else (RF14).
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

	draft(chatID: string): Draft {
		return this.drafts[chatID] ?? EMPTY;
	}

	setText(chatID: string, text: string): void {
		this.drafts[chatID] = { ...this.draft(chatID), text };
	}

	setReply(chatID: string, replyTo: QuoteRef | undefined): void {
		this.drafts[chatID] = { ...this.draft(chatID), ...(replyTo ? { replyTo } : { replyTo: undefined }) };
	}

	clear(chatID: string): void {
		delete this.drafts[chatID];
	}
}

export const composer = new ComposerStore();
