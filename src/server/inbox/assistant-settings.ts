import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type AssistantEngine = "flash" | "pi" | "hermes";
export interface AssistantSelection { engine: AssistantEngine; provider: string; model: string }

export function isAssistantSelection(value: unknown): value is AssistantSelection {
	if (!value || typeof value !== "object" || !("engine" in value) || !("provider" in value) || !("model" in value)) return false;
	return (value.engine === "flash" || value.engine === "pi" || value.engine === "hermes") && validModelID(value.provider) && validModelID(value.model);
}

export function validModelID(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,199}$/.test(value);
}

export class AssistantSettings {
	private selections = new Map<string, AssistantSelection>();
	private revisions = new Map<string, number>();

	constructor(private readonly file: string, private readonly log: (message: string) => void) {
		if (!existsSync(file)) return;
		try {
			const data: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1 || !("chats" in data) || !data.chats || typeof data.chats !== "object" || Array.isArray(data.chats)) throw new Error("invalid settings");
			for (const [id, selection] of Object.entries(data.chats)) {
				if (!isAssistantSelection(selection)) throw new Error("invalid selection");
				this.selections.set(id, { engine: selection.engine, provider: selection.provider, model: selection.model });
			}
			chmodSync(file, 0o600);
		} catch {
			this.selections.clear();
			renameSync(file, `${file}.corrupt-${Date.now()}`);
			this.log("inbox: assistant settings unreadable, moved aside");
		}
	}

	get(chatID: string, fallback: AssistantSelection): AssistantSelection {
		return { ...(this.selections.get(chatID) ?? fallback) };
	}

	revision(chatID: string): number { return this.revisions.get(chatID) ?? 0; }

	set(chatID: string, selection: AssistantSelection): void {
		const previous = this.selections.get(chatID);
		if (previous?.engine === selection.engine && previous.provider === selection.provider && previous.model === selection.model) return;
		const next = new Map(this.selections);
		next.set(chatID, { engine: selection.engine, provider: selection.provider, model: selection.model });
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		const temporary = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ version: 1, chats: Object.fromEntries(next) }, null, "\t")}\n`, { mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, this.file);
		this.selections = next;
		this.revisions.set(chatID, this.revision(chatID) + 1);
	}
}
