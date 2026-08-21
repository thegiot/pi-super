import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The ⇊ ribbon key must press whatever *this* pi installation binds to "scroll viewport
 * to bottom" — stock pi says End, but ~/.pi/agent/keybindings.json can (and here does)
 * move it to ctrl+end so that plain End stays the editor's end-of-line. Reading pi's own
 * config beats a pi-super option that would have to be kept in sync with it by hand.
 */

/** pi key names whose tmux spelling is not just the lowercase name. */
const TMUX_KEY_NAMES: Record<string, string> = {
	end: "End",
	home: "Home",
	pageup: "PageUp",
	pagedown: "PageDown",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
	enter: "Enter",
	escape: "Escape",
	tab: "Tab",
	space: "Space",
	backspace: "BSpace",
	delete: "DC",
	insert: "IC",
};

/** Translate a pi keybinding id ("ctrl+shift+end") to a tmux key name ("C-S-End"). */
export function piKeyToTmux(key: string): string | undefined {
	const parts = key.toLowerCase().split("+");
	const base = parts.pop() ?? "";
	let mods = "";
	for (const mod of parts) {
		if (mod === "ctrl") mods += "C-";
		else if (mod === "shift") mods += "S-";
		else if (mod === "alt" || mod === "meta" || mod === "option") mods += "M-";
		else return undefined;
	}
	const name =
		TMUX_KEY_NAMES[base] ??
		(/^[a-z0-9]$/.test(base) ? base : /^f\d{1,2}$/.test(base) ? base.toUpperCase() : undefined);
	return name === undefined ? undefined : mods + name;
}

/**
 * The tmux key for pi's `tui.altScreen.bottom`. Read per call, not cached: it is a
 * rarely pressed key and re-reading means an edited keybindings.json works without a
 * server restart (the exact trap AGENTS.md warns about for everything else).
 */
export function scrollBottomKey(configDir = join(homedir(), ".pi", "agent")): string {
	try {
		const raw = readFileSync(join(configDir, "keybindings.json"), "utf8");
		const bound: unknown = JSON.parse(raw)["tui.altScreen.bottom"];
		const keys = Array.isArray(bound) ? bound : typeof bound === "string" ? [bound] : [];
		for (const key of keys) {
			const tmuxKey = piKeyToTmux(String(key));
			if (tmuxKey !== undefined) return tmuxKey;
		}
	} catch {
		// no config, unreadable, or unparsable — stock pi it is
	}
	return "End";
}
