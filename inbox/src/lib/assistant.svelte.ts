import { api, ApiError, type AssistantAnswer, type AssistantIntent, type AssistantOptions, type AssistantSettings } from "./api";
import { inbox } from "./inbox.svelte";
import { composer } from "./composer.svelte";

export interface Turn {
	role: "user" | "assistant";
	text: string;
	draft?: AssistantAnswer["draft"];
	identity?: string;
	error?: string;
}
interface Thread {
	turns: Turn[];
	contextMessages: number | null;
	busy: boolean;
	pendingDraft: string | null;
}
const HISTORY_TURNS = 10;
const EMPTY: Thread = { turns: [], contextMessages: null, busy: false, pendingDraft: null };

// Conversation text remains in page memory. Only engine selections are persisted by the server.
class AssistantStore {
	open = $state(false);
	columns = $state(false);
	threads = $state<Record<string, Thread>>({});
	options = $state<AssistantOptions | null>(null);
	settings = $state<Record<string, AssistantSettings>>({});
	settingsBusy = $state<Record<string, boolean>>({});
	settingsErrors = $state<Record<string, string | null>>({});
	private generation = 0;
	private chatGenerations = new Map<string, number>();
	private settingsRequests = new Map<string, number>();

	clear(): void {
		this.generation++;
		this.threads = {};
		this.close();
	}
	thread(chatID: string | undefined): Thread {
		return (chatID && this.threads[chatID]) || EMPTY;
	}
	deactivate(chatID: string): void {
		this.chatGenerations.set(chatID, (this.chatGenerations.get(chatID) ?? 0) + 1);
		if (this.threads[chatID]) this.patch(chatID, { busy: false, pendingDraft: null });
	}
	toggle(): void {
		if (this.open) this.close();
		else this.open = true;
	}
	close(): void {
		this.open = false;
		for (const [chatID, thread] of Object.entries(this.threads)) {
			if (thread.busy || thread.pendingDraft !== null) this.deactivate(chatID);
		}
	}
	available(chatID: string): boolean {
		const selection = this.settings[chatID];
		if (selection && this.options) return this.options.engines.some((engine) => engine.id === selection.engine && engine.available);
		return inbox.state?.assistant.status === "ok";
	}
	identity(chatID: string): string {
		const selection = this.settings[chatID];
		if (!selection) return "";
		const label = this.options?.engines.find((engine) => engine.id === selection.engine)?.label ?? selection.engine;
		return `${label} · ${selection.provider} · ${selection.model}`;
	}
	async loadSettings(chatID: string): Promise<void> {
		if (this.settings[chatID] || this.settingsBusy[chatID]) return;
		const request = (this.settingsRequests.get(chatID) ?? 0) + 1;
		this.settingsRequests.set(chatID, request);
		this.settingsBusy[chatID] = true;
		this.settingsErrors[chatID] = null;
		try {
			const [options, settings] = await Promise.all([api.assistantOptions(), api.assistantSettings(chatID)]);
			if (this.settingsRequests.get(chatID) !== request) return;
			this.options = options;
			this.settings[chatID] = settings;
		} catch (err) {
			if (this.settingsRequests.get(chatID) === request) this.settingsErrors[chatID] = err instanceof ApiError ? err.message : "Impostazioni non disponibili.";
		} finally {
			if (this.settingsRequests.get(chatID) === request) this.settingsBusy[chatID] = false;
		}
	}
	async select(chatID: string, selection: AssistantSettings): Promise<void> {
		if (this.settingsBusy[chatID]) return;
		const request = (this.settingsRequests.get(chatID) ?? 0) + 1;
		this.settingsRequests.set(chatID, request);
		this.chatGenerations.set(chatID, (this.chatGenerations.get(chatID) ?? 0) + 1);
		delete this.threads[chatID];
		this.settingsBusy[chatID] = true;
		this.settingsErrors[chatID] = null;
		try {
			const settings = await api.setAssistantSettings(chatID, selection);
			if (this.settingsRequests.get(chatID) === request) this.settings[chatID] = settings;
		} catch (err) {
			if (this.settingsRequests.get(chatID) === request) this.settingsErrors[chatID] = err instanceof ApiError ? err.message : "Impossibile salvare le impostazioni.";
		} finally {
			if (this.settingsRequests.get(chatID) === request) this.settingsBusy[chatID] = false;
		}
	}
	async ask(chatID: string, prompt: string, intent: AssistantIntent = "auto"): Promise<void> {
		const chat = inbox.chat;
		if (chat?.id !== chatID || inbox.modelPrivacyBusy || this.settingsBusy[chatID] || chat.modelPrivacy?.chatExcluded || chat.modelPrivacy?.networkExcluded) return;
		const composerRevision = composer.revision(chatID);
		const selection = this.settings[chatID];
		const generation = this.generation;
		const chatGeneration = this.chatGenerations.get(chatID) ?? 0;
		const valid = () => generation === this.generation && chatGeneration === (this.chatGenerations.get(chatID) ?? 0);
		const text = prompt.trim();
		const current = this.threads[chatID] ?? { ...EMPTY, turns: [] };
		if (!text || current.busy) return;
		const history = current.turns.filter((turn) => !turn.error).slice(-HISTORY_TURNS).map((turn) => ({ role: turn.role, text: turn.text }));
		this.threads[chatID] = { ...current, pendingDraft: null, turns: [...current.turns, { role: "user", text }], busy: true };
		try {
			const answer = await api.assistant(chatID, { prompt: text, intent, history });
			if (!valid()) return;
			const draft = intent === "answer" ? null : answer.draft;
			const identity = [answer.engine ?? selection?.engine, answer.provider ?? selection?.provider, answer.model ?? selection?.model].filter(Boolean).join(" · ");
			this.patch(chatID, {
				turns: [...this.thread(chatID).turns, { role: "assistant", text: answer.reply, draft, identity }],
				contextMessages: answer.context.messages,
			});
			// A late answer may stay in its own thread, but never moves a different chat's composer.
			if (draft && (composer.revision(chatID) === composerRevision || composer.draft(chatID).text !== "") && inbox.chat?.id === chatID && !inbox.modelPrivacyBusy && !inbox.chat.modelPrivacy?.chatExcluded && !inbox.chat.modelPrivacy?.networkExcluded) this.useDraft(chatID, draft.text);
		} catch (err) {
			if (!valid()) return;
			const code = err instanceof ApiError ? err.message : "network";
			this.patch(chatID, { turns: [...this.thread(chatID).turns, { role: "assistant", text: "", error: code }] });
		} finally {
			if (valid()) this.patch(chatID, { busy: false });
		}
	}
	useDraft(chatID: string, text: string): void {
		if (inbox.chat?.id !== chatID || inbox.modelPrivacyBusy || inbox.chat.modelPrivacy?.chatExcluded || inbox.chat.modelPrivacy?.networkExcluded) return;
		if (composer.draft(chatID).text !== "") {
			this.patch(chatID, { pendingDraft: text });
			return;
		}
		composer.setText(chatID, text);
		this.patch(chatID, { pendingDraft: null });
		this.close();
		composer.focus(chatID);
	}
	applyDraft(chatID: string, mode: "replace" | "append" | "cancel"): void {
		const text = this.thread(chatID).pendingDraft;
		if (text === null || inbox.chat?.id !== chatID || inbox.modelPrivacyBusy || inbox.chat.modelPrivacy?.chatExcluded || inbox.chat.modelPrivacy?.networkExcluded) return;
		this.patch(chatID, { pendingDraft: null });
		if (mode === "cancel") return;
		const current = composer.draft(chatID).text;
		composer.setText(chatID, mode === "replace" || current === "" ? text : `${current}${current.endsWith("\n") ? "" : "\n"}${text}`);
		this.close();
		composer.focus(chatID);
	}
	reformulate(chatID: string): Promise<void> {
		return this.ask(chatID, "Riformula la bozza in modo diverso.", "draft");
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
			return "Il motore o il modello selezionato non è disponibile.";
		case "assistant_settings_changed":
			return "La scelta del modello è cambiata. Invia di nuovo la richiesta.";
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
