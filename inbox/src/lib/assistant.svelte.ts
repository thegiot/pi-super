import { api, ApiError, type AssistantAnswer } from "./api";
import { inbox } from "./inbox.svelte";

/*
 * The assistant's conversations, in page memory only (RF16): nothing is written to storage,
 * and each chat keeps its own thread, so switching chats switches what the assistant knows.
 */

export interface Turn {
	role: "user" | "assistant";
	text: string;
	draft?: AssistantAnswer["draft"];
	error?: string;
}

interface Thread {
	turns: Turn[];
	contextMessages: number | null;
	busy: boolean;
}

const HISTORY_TURNS = 10;
const EMPTY: Thread = { turns: [], contextMessages: null, busy: false };

class AssistantStore {
	open = $state(false);
	/** three columns (≥1024 px) rather than a bottom sheet */
	columns = $state(false);
	threads = $state<Record<string, Thread>>({});
	private generation = 0;

	/** Privacy changes discard history and invalidate any answer already in flight. */
	clear(): void {
		this.generation++;
		this.threads = {};
		this.close();
	}

	thread(chatID: string | undefined): Thread {
		return (chatID && this.threads[chatID]) || EMPTY;
	}

	toggle(): void {
		this.open = !this.open;
	}

	close(): void {
		this.open = false;
	}

	async ask(chatID: string, prompt: string): Promise<void> {
		const chat = inbox.chat;
		if (chat?.id !== chatID || inbox.modelPrivacyBusy || chat.modelPrivacy?.chatExcluded || chat.modelPrivacy?.networkExcluded) return;
		const generation = this.generation;
		const text = prompt.trim();
		const current = this.threads[chatID] ?? { turns: [], contextMessages: null, busy: false };
		if (!text || current.busy) return;
		// the history is the earlier answers and questions of this chat only; error turns are not replayed
		const history = current.turns
			.filter((t) => !t.error)
			.slice(-HISTORY_TURNS)
			.map((t) => ({ role: t.role, text: t.text }));
		this.threads[chatID] = { ...current, turns: [...current.turns, { role: "user", text }], busy: true };
		try {
			const answer = await api.assistant(chatID, { prompt: text, history });
			if (generation !== this.generation) return;
			this.patch(chatID, {
				turns: [...this.threads[chatID]!.turns, { role: "assistant", text: answer.reply, draft: answer.draft }],
				contextMessages: answer.context.messages,
			});
		} catch (err) {
			if (generation !== this.generation) return;
			const code = err instanceof ApiError ? err.message : "network";
			this.patch(chatID, { turns: [...this.threads[chatID]!.turns, { role: "assistant", text: "", error: code }] });
		} finally {
			if (generation === this.generation) this.patch(chatID, { busy: false });
		}
	}

	reformulate(chatID: string): Promise<void> {
		return this.ask(chatID, "Riformula la bozza in modo diverso.");
	}

	private patch(chatID: string, change: Partial<Thread>): void {
		this.threads[chatID] = { ...(this.threads[chatID] ?? EMPTY), ...change };
	}
}

export const assistant = new AssistantStore();

/** Italian copy for the error codes the server can answer with. */
export function assistantErrorText(code: string): string {
	switch (code) {
		case "assistant_unconfigured":
			return "L'assistente non è configurato: manca la chiave del modello.";
		case "assistant_timeout":
			return "L'assistente non ha risposto in tempo.";
		case "assistant_busy":
			return "L'assistente è occupato: riprova tra poco.";
		case "beeper_unavailable":
			return "Non riesco a leggere la chat da Beeper. Il resto dell'inbox funziona.";
		case "assistant_failed":
			return "L'assistente ha risposto in modo non valido. Riprova.";
		default:
			return "Errore di rete. Riprova.";
	}
}
