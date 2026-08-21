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
	return: "Enter",
	escape: "Escape",
	esc: "Escape",
	tab: "Tab",
	space: "Space",
	backspace: "BSpace",
	delete: "DC",
	insert: "IC",
};

/**
 * Translate a pi keybinding id ("ctrl+shift+end") to a tmux key name ("C-S-End").
 * Undefined for anything tmux cannot express: the super modifier, and a bare ";" —
 * tmux parses that argument as a command separator, not a key.
 */
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
		(/^f\d{1,2}$/.test(base)
			? base.toUpperCase()
			: /^[!-~]$/.test(base) && base !== ";"
				? base
				: undefined);
	return name === undefined ? undefined : mods + name;
}

/**
 * The tmux key for pi's `tui.altScreen.bottom`, or undefined when pi has it unbound (an
 * explicit `[]` means the user removed the shortcut on purpose — falling back to End
 * would poke the editor with a key they took away) or bound only to chords tmux cannot
 * type. No config, or a config that does not mention the binding, is stock pi: End.
 *
 * Read per call, not cached: it is a rarely pressed key and re-reading means an edited
 * keybindings.json works without a server restart (the exact trap AGENTS.md warns about
 * for everything else). The default dir mirrors pi's getAgentDir(), including its
 * PI_CODING_AGENT_DIR override.
 */
export function scrollBottomKey(configDir?: string): string | undefined {
	const dir = configDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	let bindings: Record<string, unknown>;
	try {
		bindings = JSON.parse(readFileSync(join(dir, "keybindings.json"), "utf8"));
	} catch {
		return "End"; // no config, unreadable, or unparsable — stock pi
	}
	if (!bindings || typeof bindings !== "object" || !("tui.altScreen.bottom" in bindings)) return "End";
	const bound = bindings["tui.altScreen.bottom"];
	const keys = Array.isArray(bound) ? bound : typeof bound === "string" ? [bound] : [];
	for (const key of keys) {
		const tmuxKey = piKeyToTmux(String(key));
		if (tmuxKey !== undefined) return tmuxKey;
	}
	return undefined;
}
