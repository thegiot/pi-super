import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Corrections } from "./classify.js";

/*
 * The user's word on a chat (PRD §10.1, RF26). Stored as chat ids and timestamps only:
 * nothing here may be message text, names or titles. Written on every change so that a
 * dismissal survives a restart (CA5).
 */

interface StoredFile {
	version: 1;
	chats: Record<string, Partial<Corrections>>;
	/** Account/network identifiers, never display names. Legacy v1 files omit this. */
	modelExcludedNetworks?: string[];
}

export type CorrectionsPatch = Partial<Omit<Corrections, "marked" | "priority">> & {
	marked?: boolean;
	priority?: boolean;
};

export class CorrectionsStore {
	private chats = new Map<string, Partial<Corrections>>();
	private modelExcludedNetworks = new Set<string>();

	constructor(
		private readonly file: string,
		private readonly log: (msg: string) => void = () => {},
	) {
		this.load();
	}

	get(chatID: string): Corrections {
		const c = this.chats.get(chatID) ?? {};
		return { ...c, marked: c.marked === true, priority: c.priority === true };
	}

	/** An explicit `undefined` clears a field; a cleared chat drops out of the file entirely. */
	update(chatID: string, patch: CorrectionsPatch): Corrections {
		const next: Partial<Corrections> = { ...this.chats.get(chatID) };
		for (const [k, v] of Object.entries(patch) as [keyof Corrections, unknown][]) {
			if (v === undefined || v === false) delete next[k];
			else (next as Record<string, unknown>)[k] = v;
		}
		if (Object.keys(next).length === 0) this.chats.delete(chatID);
		else this.chats.set(chatID, next);
		this.save();
		return this.get(chatID);
	}

	networkExcluded(networkID: string): boolean {
		return this.modelExcludedNetworks.has(networkID);
	}

	excludeNetwork(networkID: string, on: boolean): void {
		if (on) this.modelExcludedNetworks.add(networkID);
		else this.modelExcludedNetworks.delete(networkID);
		this.save();
	}

	private load(): void {
		if (!existsSync(this.file)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StoredFile;
			if (parsed.version !== 1 || typeof parsed.chats !== "object") throw new Error("unexpected shape");
			for (const [id, c] of Object.entries(parsed.chats)) {
				if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("unexpected correction");
				// Whitelist persisted fields: unknown keys cannot become a content store.
				const clean: Partial<Corrections> = {};
				for (const field of ["marked", "priority", "modelExcluded"] as const) if (c[field] === true) clean[field] = true;
				for (const field of ["noReplyAt", "snoozeUntil"] as const) {
					if (typeof c[field] === "string" && Number.isFinite(Date.parse(c[field]!))) clean[field] = new Date(c[field]!).toISOString();
				}
				this.chats.set(id, clean);
			}
			if (parsed.modelExcludedNetworks !== undefined) {
				if (!Array.isArray(parsed.modelExcludedNetworks) || parsed.modelExcludedNetworks.some((n) => typeof n !== "string" || n.length > 512)) throw new Error("unexpected networks");
				this.modelExcludedNetworks = new Set(parsed.modelExcludedNetworks);
			}
		} catch {
			// Not silently discarded: moved aside so a human can look at it before the next save overwrites it.
			const aside = `${this.file}.corrupt-${Date.now()}`;
			renameSync(this.file, aside);
			this.log(`inbox: corrections file unreadable — moved aside to ${aside}`);
		}
	}

	private save(): void {
		const data: StoredFile = { version: 1, chats: Object.fromEntries(this.chats),
			...(this.modelExcludedNetworks.size ? { modelExcludedNetworks: [...this.modelExcludedNetworks] } : {}) };
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.file);
	}
}
