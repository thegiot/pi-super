import type { ChatSummary, MessageKind, Reason } from "./api";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "ora", "5 min", "3 h", "ieri", "2 g", then a short date (PRD §9 RF4). */
export function relativeShort(iso: string | undefined, now = Date.now()): string {
	if (!iso) return "";
	const diff = now - Date.parse(iso);
	if (diff < MIN) return "ora";
	if (diff < HOUR) return `${Math.floor(diff / MIN)} min`;
	if (diff < DAY) return `${Math.floor(diff / HOUR)} h`;
	if (diff < 2 * DAY) return "ieri";
	if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} g`;
	return new Intl.DateTimeFormat("it", { day: "numeric", month: "short" }).format(new Date(iso));
}

/** Words used inside reason chips: "Ti ha scritto {…}". */
export function waitingSince(iso: string, now = Date.now()): string {
	const diff = now - Date.parse(iso);
	if (diff < MIN) return "ora";
	if (diff < HOUR) {
		const m = Math.floor(diff / MIN);
		return m === 1 ? "1 minuto fa" : `${m} minuti fa`;
	}
	if (diff < DAY) {
		const h = Math.floor(diff / HOUR);
		return h === 1 ? "1 ora fa" : `${h} ore fa`;
	}
	if (diff < 2 * DAY) return "ieri";
	return `${Math.floor(diff / DAY)} giorni fa`;
}

export interface ChipText {
	text: string;
	tone: "accent" | "warn" | "neutral";
}

/** Reason and importance chips, in the order the list shows them. */
export function reasonChips(chat: ChatSummary, now = Date.now()): ChipText[] {
	const chips: ChipText[] = [];
	for (const r of chat.labels.reasons) chips.push({ text: reasonText(r, now), tone: "accent" });
	for (const r of chat.labels.important) {
		if (r.code === "mention" && chat.labels.reasons.some((x) => x.code === "mention")) continue;
		if (r.code === "pinned") chips.push({ text: "Fissata", tone: "warn" });
		if (r.code === "priority") chips.push({ text: "Prioritaria", tone: "warn" });
	}
	if (chat.labels.incomplete) chips.push({ text: "Dati incompleti", tone: "neutral" });
	if (chat.labels.longPending) chips.push({ text: "In sospeso da tempo", tone: "neutral" });
	return chips;
}

export function reasonText(r: Reason, now = Date.now()): string {
	switch (r.code) {
		case "dm_waiting":
			return `Ti ha scritto ${waitingSince(r.since, now)}`;
		case "mention":
			return "Ti hanno menzionato";
		case "reply_to_you":
			return "Hanno risposto a un tuo messaggio";
		case "marked":
			return "Segnata da te";
		case "pinned":
			return "Fissata";
		case "priority":
			return "Prioritaria";
	}
}

/** Placeholder text for a message that is not plain text (RF8: never silently omitted). */
export function kindLabel(kind: MessageKind): string {
	switch (kind) {
		case "image":
			return "Foto";
		case "video":
			return "Video";
		case "audio":
			return "Audio";
		case "file":
			return "File";
		case "sticker":
			return "Sticker";
		case "location":
			return "Posizione";
		case "notice":
			return "Avviso";
		case "reaction":
			return "Reazione";
		case "unknown":
			return "Contenuto";
		case "text":
			return "";
	}
}

export function previewLine(chat: ChatSummary): string {
	const p = chat.preview;
	if (!p) return "";
	const body = p.kind === "text" || p.kind === "notice" ? (p.text ?? "") : `[${kindLabel(p.kind)}]`;
	const who = chat.type === "group" && !p.isSender && p.senderName ? `${p.senderName}: ` : p.isSender ? "Tu: " : "";
	return `${who}${body}`;
}

export function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	const letters = words.length === 0 ? "?" : words.length === 1 ? words[0]!.slice(0, 2) : words[0]![0]! + words[1]![0]!;
	return letters.toUpperCase();
}

/** Token name of a network's dot colour. */
export function networkTone(network: string): string {
	const n = network.toLowerCase();
	if (n.includes("whatsapp")) return "whatsapp";
	if (n.includes("telegram")) return "telegram";
	if (n.includes("wechat")) return "wechat";
	if (n.includes("linkedin")) return "linkedin";
	if (n.includes("beeper") || n.includes("matrix")) return "matrix";
	return "neutral";
}

export function clock(iso: string): string {
	return new Intl.DateTimeFormat("it", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function dayLabel(iso: string, now = new Date()): string {
	const d = new Date(iso);
	const sameDay = (a: Date, b: Date) =>
		a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
	if (sameDay(d, now)) return "Oggi";
	const yesterday = new Date(now.getTime() - DAY);
	if (sameDay(d, yesterday)) return "Ieri";
	if (now.getTime() - d.getTime() < 7 * DAY) return new Intl.DateTimeFormat("it", { weekday: "long" }).format(d);
	return new Intl.DateTimeFormat("it", { day: "numeric", month: "long" }).format(d);
}

export function sameDay(a: string, b: string): boolean {
	const x = new Date(a);
	const y = new Date(b);
	return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function fileSize(bytes: number | undefined): string {
	if (bytes === undefined) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Italian label for an account status as reported by Beeper. */
export function accountStatusText(status: string): string {
	return status === "connected" ? "connesso" : status === "backfilling" ? "in sincronizzazione" : "disconnesso";
}

/** Subtitle clause for how fresh the list is (F1, §13). */
export function updatedText(iso: string | undefined, now = Date.now()): string {
	if (!iso) return "in caricamento";
	const diff = now - Date.parse(iso);
	if (diff < MIN) return "aggiornato ora";
	if (diff < HOUR) return `aggiornato ${Math.floor(diff / MIN)} min fa`;
	if (diff < DAY) return `aggiornato ${Math.floor(diff / HOUR)} h fa`;
	return `aggiornato da ${relativeShort(iso, now)}`;
}

/** Long preview for the chat footer: "Rimandata a sab 18:00". */
export function snoozeText(iso: string): string {
	return new Intl.DateTimeFormat("it", { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export interface SnoozeOption {
	label: string;
	until: string;
}

/** The fixed "Rimanda" choices (PRD F7), computed from the moment the menu opens. */
export function snoozeOptions(now: Date): SnoozeOption[] {
	const at = (day: number, hour: number) => {
		const d = new Date(now);
		d.setDate(d.getDate() + day);
		d.setHours(hour, 0, 0, 0);
		return d;
	};
	const monday = at(0, 9);
	monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
	return [
		{ label: "Tra 1 ora", until: new Date(now.getTime() + HOUR).toISOString() },
		{ label: "Stasera alle 18", until: (now.getHours() < 18 ? at(0, 18) : at(1, 18)).toISOString() },
		{ label: "Domani alle 9", until: at(1, 9).toISOString() },
		{ label: "Lunedì alle 9", until: monday.toISOString() },
	];
}
