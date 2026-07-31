import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type VoiceProvider = "codex" | "openai" | "none";

export interface VoiceConfig {
	provider: VoiceProvider;
	model: string;
	voice: string;
	/** how the realtime model reaches the meta agent: private delegation vs a function tool */
	delegation: "codex" | "tool";
}

const CODEX_BASE = process.env.PI_SUPER_CODEX_BASE ?? "https://chatgpt.com/backend-api/codex";
// The Codex desktop app ships `gpt-live-1-codex`; `gpt-live-1-boulder-alpha` was its alpha
// codename and is still accepted (and still what the open-source codex repo hardcodes), but
// it is no longer what OpenAI's own client asks for. Both pass the server-side allowlist.
const CODEX_MODEL = process.env.PI_SUPER_VOICE_MODEL ?? "gpt-live-1-codex";
const OPENAI_MODEL = process.env.PI_SUPER_VOICE_MODEL ?? "gpt-realtime-2.1-mini";

// The voice sets must not be mixed: asking a gpt-live (V3) session for a V2 voice such as
// `marin` is rejected as `403 Voice session access denied`, which looks exactly like an
// account-entitlement failure and is not one.
const CODEX_VOICES = ["cove", "juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol"];
const CODEX_DEFAULT_VOICE = "sol";
const OPENAI_DEFAULT_VOICE = "marin";

function pickVoice(provider: "codex" | "openai"): string {
	const wanted = process.env.PI_SUPER_VOICE;
	if (provider === "openai") return wanted ?? OPENAI_DEFAULT_VOICE;
	if (wanted && !CODEX_VOICES.includes(wanted)) {
		process.stderr.write(
			`pi-super: voice "${wanted}" is not a gpt-live voice (${CODEX_VOICES.join(", ")}), using ${CODEX_DEFAULT_VOICE}\n`,
		);
		return CODEX_DEFAULT_VOICE;
	}
	return wanted ?? CODEX_DEFAULT_VOICE;
}

interface CodexAuth {
	access: string;
	accountId: string;
	expires: number;
}

/**
 * The user's ChatGPT/Codex OAuth, as stored by pi. Using it means voice runs on the
 * ChatGPT subscription (gpt-live / "codex voice") instead of API billing — which is the
 * only option on a box with no OPENAI_API_KEY. pi refreshes this token; we only read it.
 */
export function readCodexAuth(): CodexAuth | undefined {
	const file = join(process.env.PI_CONFIG_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");
	if (!existsSync(file)) return undefined;
	try {
		const auth = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
		const codex = auth["openai-codex"];
		if (!codex || typeof codex.access !== "string" || typeof codex.accountId !== "string") return undefined;
		return { access: codex.access, accountId: codex.accountId, expires: Number(codex.expires ?? 0) };
	} catch {
		return undefined;
	}
}

export function detectVoiceConfig(): VoiceConfig {
	// Prefer the ChatGPT subscription: gpt-live is what the user actually wants, and it
	// costs nothing extra. An API key is the fallback, not the other way round.
	if (readCodexAuth()) {
		return { provider: "codex", model: CODEX_MODEL, voice: pickVoice("codex"), delegation: "codex" };
	}
	if (process.env.OPENAI_API_KEY) {
		return { provider: "openai", model: OPENAI_MODEL, voice: pickVoice("openai"), delegation: "tool" };
	}
	return { provider: "none", model: "", voice: "", delegation: "tool" };
}

export interface OfferResult {
	ok: boolean;
	sdp?: string;
	status: number;
	error?: string;
}

/**
 * Proxy the browser's WebRTC offer to the realtime backend and return the answer.
 *
 * The browser never sees a credential: it POSTs its SDP here, we attach the account's
 * auth plus the trusted session configuration (instructions, voice, tools) and hand back
 * only the answer SDP.
 */
export async function negotiateOffer(cfg: VoiceConfig, sdp: string, instructions: string): Promise<OfferResult> {
	if (cfg.provider === "codex") {
		const auth = readCodexAuth();
		if (!auth) return { ok: false, status: 503, error: "no ChatGPT/Codex login found in pi's auth.json" };
		if (auth.expires && auth.expires < Date.now()) {
			return { ok: false, status: 401, error: "ChatGPT token expired — run pi once to refresh it" };
		}
		const res = await fetch(`${CODEX_BASE}/realtime/calls?intent=quicksilver&architecture=avas`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${auth.access}`,
				"chatgpt-account-id": auth.accountId,
				originator: "pi",
				"user-agent": "pi-super",
				// the query params are mandatory whenever openai-alpha is sent
				"openai-alpha": "quicksilver=v2",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				sdp,
				session: {
					model: cfg.model,
					instructions,
					audio: { output: { voice: cfg.voice } },
					// "client" delegation: the model hands substantive work to us
					// (pi-super -> meta agent) instead of doing it itself.
					delegation: { type: "client" },
				},
			}),
		});
		const body = await res.text();
		if (res.status !== 201 && res.status !== 200) return { ok: false, status: res.status, error: body.slice(0, 500) };
		return { ok: true, status: res.status, sdp: body };
	}

	if (cfg.provider === "openai") {
		const key = process.env.OPENAI_API_KEY;
		if (!key) return { ok: false, status: 503, error: "OPENAI_API_KEY not set" };
		const form = new FormData();
		form.set("sdp", sdp);
		form.set(
			"session",
			JSON.stringify({
				type: "realtime",
				model: cfg.model,
				instructions,
				audio: {
					input: { turn_detection: { type: "semantic_vad" } },
					output: { voice: cfg.voice },
				},
				tools: [
					{
						type: "function",
						name: "ask_super",
						description:
							"Hand a request to super, the agent that manages the tmux and its coding sessions. Returns immediately; super's answers arrive as spoken updates. Use for anything about projects, sessions, code, or machine state.",
						parameters: {
							type: "object",
							properties: {
								request: {
									type: "string",
									description: "what the user wants, in their words, plus any relevant context",
								},
							},
							required: ["request"],
						},
					},
				],
			}),
		);
		const res = await fetch("https://api.openai.com/v1/realtime/calls", {
			method: "POST",
			headers: { authorization: `Bearer ${key}` },
			body: form,
		});
		const body = await res.text();
		if (!res.ok) return { ok: false, status: res.status, error: body.slice(0, 500) };
		return { ok: true, status: res.status, sdp: body };
	}

	return { ok: false, status: 503, error: "no voice provider configured" };
}
