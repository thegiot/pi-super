/**
 * Dictation mode: the same realtime session as a voice call, told to be a microphone.
 *
 * The reason this is worth doing at all is that the realtime model's *instructions bias its
 * transcript*: naming `pi-super` in the prompt is the difference between "pi-super" and
 * "PySuper" in the text (measured — see docs/dictation.md). So we prime every session with
 * the jargon that is actually on the user's screen, which is something the phone keyboard
 * structurally cannot know.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Words a recogniser never needs help with. Terminal output is mostly English prose and
 * shell noise; what we want to keep is the rest.
 */
const STOPWORDS = new Set(
	`the and for with that this from have has had been will you your are was not but all can its into when then than more only some they them what which there here just like over also does done make made use used using run get got one two new out add set see now off why how who may per via yes ok error warn info true false null none name type file line time date size args argv main test tests src lib bin usr var tmp home root user local etc opt dev proc sys log logs data conf config
	 total size mode last modified rows cols lines page done ready done`
		.trim()
		.split(/\s+/),
);

/** Jargon we want primed even when the screen happens not to show it right now. */
const CORE = ["pi-super", "pi", "tmux", "systemd", "git", "npm", "ssh", "grep", "rebase", "commit", "worktree"];

/** Identifier-ish runs: letters first, then anything an identifier or path may contain. */
const TOKEN = /[A-Za-z][A-Za-z0-9._/@-]{2,31}/g;

const MAX_TOKENS = 48;
const MAX_CHARS = 500;

/**
 * Pick the vocabulary worth priming from what is on screen. Window names count for much
 * more than pane text: they are the user's own words for their own work, whereas a pane is
 * mostly whatever the last command happened to print.
 */
export function buildVocabulary(paneText: string, windowNames: string[] = []): string {
	const counts = new Map<string, number>();
	const spelling = new Map<string, string>();
	const add = (raw: string, weight: number): void => {
		// prose punctuation clings to the end of a token ("build," "dist/.")
		const token = raw.replace(/[._/@-]+$/, "");
		if (token.length < 3) return;
		const key = token.toLowerCase();
		if (STOPWORDS.has(key)) return;
		if (!spelling.has(key)) spelling.set(key, token);
		counts.set(key, (counts.get(key) ?? 0) + weight);
	};
	for (const name of windowNames) for (const m of name.match(TOKEN) ?? []) add(m, 8);
	for (const m of paneText.match(TOKEN) ?? []) add(m, 1);

	const ranked = [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([key]) => spelling.get(key) as string)
		.filter((word) => !CORE.some((c) => c.toLowerCase() === word.toLowerCase()));

	const out: string[] = [...CORE];
	let chars = out.join(", ").length;
	for (const word of ranked) {
		if (out.length >= MAX_TOKENS || chars + word.length + 2 > MAX_CHARS) break;
		out.push(word);
		chars += word.length + 2;
	}
	return out.join(", ");
}

const FALLBACK = `You are a dictation microphone. Never speak, never acknowledge, never respond, never call
tools. Transcribe exactly what the user says, spelling technical terms the way a developer
writes them.`;

/** Instructions for a dictation session: the prompt file, primed with on-screen jargon. */
export function dictationInstructions(metaDir: string, vocabulary: string): string {
	let base: string;
	try {
		base = readFileSync(join(metaDir, "dictation-prompt.md"), "utf8");
	} catch {
		base = FALLBACK;
	}
	if (!vocabulary) return base;
	return `${base}\n## Vocabulary\n\nThe user is working on this right now, and will say these words. Spell them exactly as\nwritten here:\n\n${vocabulary}\n`;
}
