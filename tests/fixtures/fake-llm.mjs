// A stand-in for the model provider's Responses API. Records every request so tests can see
// exactly what the assistant sent, and can be programmed to be slow, failing or garbled.
import { createServer } from "node:http";

export const GOOD_ANSWER = { reply: "Ti chiede di confermare giovedì sera.", draft_text: "Ciao, sì: confermo per giovedì sera.", draft_language: "it" };

export async function startFakeLlm() {
	const state = { requests: [], next: undefined, latencyMs: 0, key: undefined };

	const completed = (text) =>
		JSON.stringify({
			status: "completed",
			output: [
				{ type: "reasoning", summary: [] },
				{ type: "message", role: "assistant", content: [{ type: "output_text", text }] },
			],
			usage: { input_tokens: 123, output_tokens: 45 },
		});

	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const c of req) raw += c;
		state.requests.push({ method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
		if (state.latencyMs) await new Promise((r) => setTimeout(r, state.latencyMs));
		if (state.next) {
			const next = state.next;
			state.next = undefined;
			res.writeHead(next.status ?? 200, { "content-type": "application/json" });
			return res.end(next.body);
		}
		if (req.url !== "/api/v1/responses" && req.url !== "/responses") {
			res.writeHead(404);
			return res.end("{}");
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(completed(JSON.stringify(GOOD_ANSWER)));
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	return {
		url: `http://127.0.0.1:${port}/api/v1`,
		requests: state.requests,
		/** the next call answers with this body (and status) instead of the default */
		respondOnce({ status = 200, body }) {
			state.next = { status, body: typeof body === "string" ? body : JSON.stringify(body) };
		},
		respondWithAnswer(answer, extra = {}) {
			state.next = { status: 200, body: completed(JSON.stringify(answer)), ...extra };
		},
		setLatency(ms) {
			state.latencyMs = ms;
		},
		completed,
		async close() {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
