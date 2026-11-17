import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { runAssistantProcess } from "./assistant-process.js";
import { validModelID, type AssistantEngine, type AssistantSelection } from "./assistant-settings.js";

export interface AssistantModel { provider: string; id: string; label: string }
export interface AssistantEngineOption {
	id: AssistantEngine;
	label: string;
	available: boolean;
	profile?: string;
	models: AssistantModel[];
	default: { provider: string; model: string };
}
export interface AssistantCatalog { engines: AssistantEngineOption[]; default: AssistantSelection }
export interface AssistantRuntimePaths {
	piBin?: string;
	piAgentDir?: string;
	hermesBin?: string;
	hermesProfileDir?: string;
	hermesPython?: string;
}

export function runtimePaths(overrides: AssistantRuntimePaths = {}): Required<AssistantRuntimePaths> {
	return {
		piBin: overrides.piBin ?? "pi",
		piAgentDir: overrides.piAgentDir ?? join(homedir(), ".pi", "agent"),
		hermesBin: overrides.hermesBin ?? join(homedir(), ".local", "bin", "hermes"),
		hermesProfileDir: overrides.hermesProfileDir ?? join(homedir(), ".hermes", "profiles", "chatassistant"),
		hermesPython: overrides.hermesPython ?? "python3",
	};
}

function executable(command: string): boolean {
	const candidates = command.includes("/") ? [command] : (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, command));
	return candidates.some((file) => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } });
}

function readObject(file: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	} catch { return {}; }
}

/** Project only identifiers. Runtime files can also contain keys, endpoints and headers. */
function modelsFromStore(store: Record<string, unknown>, authenticated: Set<string>): AssistantModel[] {
	const models: AssistantModel[] = [];
	for (const [provider, entry] of Object.entries(store)) {
		if (!validModelID(provider) || !authenticated.has(provider) || !entry || typeof entry !== "object" || !("models" in entry) || !Array.isArray(entry.models)) continue;
		for (const model of entry.models) {
			if (!model || typeof model !== "object" || !validModelID(model.id)) continue;
			models.push({ provider, id: model.id, label: typeof model.name === "string" ? model.name.slice(0, 120) : model.id });
		}
	}
	return models;
}

// Parsing YAML with the installed Hermes interpreter avoids initializing its agent,
// credential lifecycle, MCP servers or a network-backed model catalog.
const HERMES_CATALOG = `import json, pathlib, sys, yaml
p = pathlib.Path(sys.argv[1])
c = yaml.safe_load((p / "config.yaml").read_text()) or {}
default = c.get("model") or {}
if not isinstance(default, dict): default = {"default": default}
models = []
wire_modes = {"chat_completions", "codex_responses", "anthropic_messages", "bedrock_converse"}
def supported(settings):
    return isinstance(settings, dict) and not settings.get("command") and not settings.get("args") and settings.get("api_mode", "chat_completions") in wire_modes
for provider, settings in (c.get("providers") or {}).items():
    if not supported(settings): continue
    if provider in {"openai", "openai-codex"} and default.get("openai_runtime"): continue
    for model in settings.get("models") or []:
        mid = model.get("id") if isinstance(model, dict) else model
        if isinstance(mid, str): models.append({"provider": provider, "id": mid, "label": mid})
provider, model = default.get("provider"), default.get("default")
if isinstance(provider, str) and isinstance(model, str) and supported(default) and supported((c.get("providers") or {}).get(provider, {})) and not (provider in {"openai", "openai-codex"} and default.get("openai_runtime")) and not any(m["provider"] == provider and m["id"] == model for m in models):
    models.append({"provider": provider, "id": model, "label": model})
print(json.dumps({"models": models, "default": {"provider": provider, "model": model}}))
`;

export async function discoverAssistantCatalog(args: {
	model: string;
	providerLabel?: string;
	provider?: string;
	flashAvailable: boolean;
	paths: Required<AssistantRuntimePaths>;
}): Promise<AssistantCatalog> {
	const { paths } = args;
	const flashDefault = { provider: args.provider ?? "responses", model: args.model };
	const piModels = modelsFromStore(readObject(join(paths.piAgentDir, "models-store.json")), new Set(Object.keys(readObject(join(paths.piAgentDir, "auth.json")))));
	const piSettings = readObject(join(paths.piAgentDir, "settings.json"));
	const piDefault = piModels.find((m) => m.provider === piSettings.defaultProvider && m.id === piSettings.defaultModel) ?? piModels[0];
	let hermesModels: AssistantModel[] = [];
	let hermesDefault = { provider: "", model: "" };
	if (executable(paths.hermesBin) && executable(paths.hermesPython)) {
		try {
			const raw = await runAssistantProcess({ command: paths.hermesPython, argv: ["-c", HERMES_CATALOG, paths.hermesProfileDir], cwd: paths.hermesProfileDir, timeoutMs: 5000, maxBytes: 256 * 1024 });
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && "models" in parsed && Array.isArray(parsed.models)) {
				hermesModels = parsed.models.filter((m): m is AssistantModel => !!m && typeof m === "object" && validModelID(m.provider) && validModelID(m.id) && typeof m.label === "string").map((m) => ({ provider: m.provider, id: m.id, label: m.label.slice(0, 120) }));
				if ("default" in parsed && parsed.default && typeof parsed.default === "object" && "provider" in parsed.default && "model" in parsed.default && validModelID(parsed.default.provider) && validModelID(parsed.default.model)) hermesDefault = { provider: parsed.default.provider, model: parsed.default.model };
			}
		} catch { /* An absent profile is an unavailable engine, never a server failure. */ }
	}
	return {
		default: { engine: "flash", ...flashDefault },
		engines: [
			{ id: "flash", label: "Flash", available: args.flashAvailable, models: [{ provider: flashDefault.provider, id: args.model, label: `${args.providerLabel ?? "Responses API"} · ${args.model}` }], default: flashDefault },
			{ id: "pi", label: "Pi", available: executable(paths.piBin) && piModels.length > 0, models: piModels, default: { provider: piDefault?.provider ?? "", model: piDefault?.id ?? "" } },
			{ id: "hermes", label: "Hermes", profile: "chatassistant", available: hermesModels.length > 0, models: hermesModels, default: hermesDefault },
		],
	};
}
