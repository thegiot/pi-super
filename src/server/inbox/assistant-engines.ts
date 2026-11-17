import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Assistant, AssistantError, assistantInstructions, validateAssistantAnswer, type AssistantAnswer, type AssistantRequest } from "./assistant.js";
import { discoverAssistantCatalog, runtimePaths, type AssistantCatalog, type AssistantRuntimePaths } from "./assistant-catalog.js";
import { AssistantSettings, type AssistantSelection } from "./assistant-settings.js";
import { runAssistantProcess } from "./assistant-process.js";

export type { AssistantCatalog } from "./assistant-catalog.js";
export type { AssistantSelection } from "./assistant-settings.js";

export interface InboxAssistantRuntime {
	/** Synthetic catalogs and runners are injected by acceptance tests, never by HTTP. */
	catalog?: AssistantCatalog;
	run?: (selection: AssistantSelection, request: AssistantRequest) => Promise<AssistantAnswer>;
	paths?: AssistantRuntimePaths;
	timeoutMs?: number;
}

export class AssistantEngines {
	readonly settings: AssistantSettings;
	private catalog: Promise<AssistantCatalog> | undefined;
	private catalogAt = 0;
	private inFlight = 0;
	private readonly cwd: string;
	private readonly paths: Required<AssistantRuntimePaths>;

	constructor(private readonly flash: Assistant, args: { stateDir: string; log: (message: string) => void; runtime?: InboxAssistantRuntime }) {
		this.settings = new AssistantSettings(join(args.stateDir, "inbox-assistant-settings.json"), args.log);
		this.runtime = args.runtime ?? {};
		this.paths = runtimePaths(this.runtime.paths);
		this.cwd = join(args.stateDir, "inbox-assistant-workspace");
	}
	private readonly runtime: InboxAssistantRuntime;

	configured(): boolean { return this.flash.configured(); }

	options(): Promise<AssistantCatalog> {
		if (this.runtime.catalog) return Promise.resolve(structuredClone(this.runtime.catalog));
		if (!this.catalog || Date.now() - this.catalogAt > 60_000) {
			this.catalogAt = Date.now();
			this.catalog = discoverAssistantCatalog({ model: this.flash.model, provider: this.flash.provider, providerLabel: this.flash.providerLabel, flashAvailable: this.flash.configured(), paths: this.paths });
		}
		return this.catalog.then((catalog) => ({ ...catalog, engines: catalog.engines.map((engine) => engine.id === "flash" ? { ...engine, available: this.flash.configured() } : engine) }));
	}

	async selection(chatID: string): Promise<AssistantSelection> {
		return this.settings.get(chatID, (await this.options()).default);
	}

	async accepts(selection: AssistantSelection): Promise<boolean> {
		const engine = (await this.options()).engines.find((option) => option.id === selection.engine);
		return engine?.available === true && engine.models.some((model) => model.provider === selection.provider && model.id === selection.model);
	}

	async ask(selection: AssistantSelection, request: AssistantRequest, assertCurrent: () => void = () => {}): Promise<AssistantAnswer & { engine: string; provider: string }> {
		if (!await this.accepts(selection)) throw new AssistantError("assistant_unconfigured");
		assertCurrent();
		if (this.inFlight >= 2) throw new AssistantError("assistant_busy");
		this.inFlight++;
		try {
			const answer = selection.engine === "flash" ? await this.flash.ask(request)
				: this.runtime.run ? await this.runtime.run(selection, request) : await this.run(selection, request, assertCurrent);
			return { ...answer, ...(request.intent === undefined || request.intent === "answer" ? { draftText: "", draftLanguage: "" } : {}), ...selection };
		} finally { this.inFlight--; }
	}

	private async run(selection: AssistantSelection, request: AssistantRequest, assertCurrent: () => void): Promise<AssistantAnswer> {
		mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
		const instructions = assistantInstructions(request.intent);
		const history = JSON.stringify(request.history).replace(/</g, "\\u003c");
		const prompt = `${instructions}\n\nCronologia dell'assistente, solo per continuità:\n${history}\n\n<chat_data>\n${request.context.data}\n</chat_data>\n\nRichiesta attuale del proprietario: ${request.prompt}`;
		const pi = selection.engine === "pi";
		const hermes = pi ? undefined : await hermesPolicyCommand(this.paths.hermesBin, this.cwd);
		assertCurrent();
		const raw = await runAssistantProcess({
			command: pi ? this.paths.piBin : hermes!.command,
			argv: pi ? ["--print", "--mode", "json", "--no-session", "--no-tools", "--no-mcp", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--provider", selection.provider, "--model", selection.model, "--system-prompt", instructions]
				: [...hermes!.argv, "--profile", "chatassistant", "--provider", selection.provider, "--model", selection.model],
			input: prompt,
			cwd: this.cwd,
			timeoutMs: this.runtime.timeoutMs,
			env: pi ? { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: this.paths.piAgentDir } : process.env,
		});
		return { ...parseRuntimeAnswer(raw, pi ? "pi" : "hermes"), model: selection.model };
	}
}

/** The install exports its current isolated interpreter and dependency bootstrap. */
export async function hermesPolicyCommand(binary: string, cwd: string): Promise<{ command: string; argv: string[] }> {
	const raw = await runAssistantProcess({ command: binary, argv: ["--print-runtime-command"], cwd, timeoutMs: 10_000, maxBytes: 128 * 1024 });
	try {
		const command: unknown = JSON.parse(raw);
		const entry = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";
		if (!Array.isArray(command) || command.length !== 4 || command.some((part) => typeof part !== "string") || command[1] !== "-I" || command[2] !== "-c" || !command[3].endsWith(entry)) throw new Error("unsupported runtime");
		const bootstrap = `${command[3].slice(0, -entry.length)}runpy.run_path(sys.argv.pop(1), run_name='__main__')`;
		return { command: command[0], argv: ["-I", "-c", bootstrap, fileURLToPath(new URL("../../../contrib/inbox-hermes.py", import.meta.url))] };
	} catch { throw new AssistantError("assistant_unconfigured"); }
}

/** Consume only authoritative final records. Tool output and progress never become a draft. */
export function parseRuntimeAnswer(raw: string, engine: "pi" | "hermes"): Omit<AssistantAnswer, "model"> {
	let text: string | undefined;
	let completed = false;
	let guarded = engine === "pi";
	try {
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			const event: unknown = JSON.parse(line);
			if (!event || typeof event !== "object" || !("type" in event)) continue;
			if (event.type === "inbox_policy" && "version" in event && event.version === 1) guarded = true;
			if (engine === "hermes" && event.type === "result") {
				if (!("exit_code" in event) || event.exit_code !== 0 || !("text" in event) || typeof event.text !== "string" || ("error" in event && event.error)) throw new Error("failed result");
				text = event.text;
				completed = true;
			}
			if (engine === "pi" && event.type === "message_end" && "message" in event && event.message && typeof event.message === "object" && "role" in event.message && event.message.role === "assistant") {
				const message = event.message;
				if ("stopReason" in message && (message.stopReason === "error" || message.stopReason === "aborted")) throw new Error("failed message");
				if ("content" in message && Array.isArray(message.content)) text = message.content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("");
			}
			if (engine === "pi" && event.type === "agent_settled") {
				if ("aborted" in event && event.aborted === true) throw new Error("aborted");
				completed = true;
			}
		}
		if (!guarded || !completed || !text || text.length > 32_000) throw new Error("missing result");
		const json = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
		return validateAssistantAnswer(JSON.parse(json));
	} catch { throw new AssistantError("assistant_failed"); }
}
