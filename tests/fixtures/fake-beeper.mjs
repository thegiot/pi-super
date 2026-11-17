// A stand-in for Beeper Desktop's Client API (spec 5.0.0), with synthetic data only.
// Every request is recorded so tests can prove which endpoints were touched.
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

export const ACCOUNTS = [
	{ accountID: "acc-wa", network: "WhatsApp", status: "connected", user: { id: "@self-wa:wa.test", fullName: "Me WA" } },
	{ accountID: "acc-tg", network: "Telegram", status: "connected", user: { id: "@self-tg:tg.test", fullName: "Me TG" } },
	{ accountID: "acc-wc", network: "WeChat", status: "connected", user: { id: "@self-wc:wc.test", fullName: "Me WC" } },
	{ accountID: "acc-mx", network: "Beeper", status: "connected", user: { id: "@self-mx:mx.test", fullName: "Me MX" } },
];

const ME = {
	"acc-wa": "@self-wa:wa.test",
	"acc-tg": "@self-tg:tg.test",
	"acc-wc": "@self-wc:wc.test",
	"acc-mx": "@self-mx:mx.test",
};

export const MEDIA_PNG = Buffer.from(
	"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",
	"base64",
);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Builds the synthetic world relative to `now`, so the classifier's time window is exercised for real. */
export function buildWorld(now = Date.now()) {
	const at = (ago) => new Date(now - ago).toISOString();
	const chats = [];
	const messages = {};

	const msg = (chatID, acc, id, who, ago, extra = {}) => {
		const isSender = who === "me";
		return {
			id,
			chatID,
			accountID: acc,
			senderID: isSender ? ME[acc] : `@${who}:${acc}.test`,
			senderName: isSender ? "Me" : who,
			timestamp: at(ago),
			sortKey: String(now - ago).padStart(15, "0"),
			type: "TEXT",
			text: `synthetic text ${id}`,
			isSender,
			isHidden: false,
			isDeleted: false,
			attachments: [],
			mentions: null,
			reactions: [],
			...extra,
		};
	};

	const chat = (id, acc, opts) => {
		const network = ACCOUNTS.find((a) => a.accountID === acc).network;
		const self = ME[acc];
		const others = opts.others ?? [];
		chats.push({
			id,
			localChatID: null,
			accountID: acc,
			network,
			title: opts.title,
			type: opts.type ?? "single",
			isReadOnly: opts.isReadOnly ?? false,
			participants: {
				items: [
					{ id: self, fullName: "Me", isSelf: true },
					...others.map((o) => ({ id: `@${o}:${acc}.test`, fullName: `Name ${o}`, isSelf: false })),
				],
				hasMore: false,
				total: others.length + 1,
			},
			lastActivity: opts.lastActivity ?? null,
			unreadCount: opts.unreadCount ?? 0,
			unreadMentionsCount: opts.unreadMentionsCount ?? 0,
			isArchived: opts.isArchived ?? false,
			isMarkedUnread: opts.isMarkedUnread ?? false,
			isMuted: opts.isMuted ?? false,
			isPinned: opts.isPinned ?? false,
			isLowPriority: opts.isLowPriority ?? false,
			capabilities: { maxTextLength: opts.maxTextLength ?? 65536 },
			...(opts.mergedIntoChatID ? { mergedIntoChatID: opts.mergedIntoChatID } : {}),
		});
		messages[id] = opts.messages ?? [];
		if (opts.messages?.length) {
			const last = opts.messages.at(-1);
			chats.at(-1).lastActivity = last.timestamp;
		}
	};

	// 1. WhatsApp DM waiting for a reply since two hours
	chat("!wa-ana:wa.test", "acc-wa", {
		title: "Ana Test",
		others: ["ana"],
		unreadCount: 1,
		messages: [msg("!wa-ana:wa.test", "acc-wa", "m-ana-1", "ana", 2 * HOUR)],
	});
	// 2. DM whose last word is 30 days old: outside the window
	chat("!wa-old:wa.test", "acc-wa", {
		title: "Old Contact",
		others: ["old"],
		messages: [msg("!wa-old:wa.test", "acc-wa", "m-old-1", "old", 30 * DAY)],
	});
	// 3. DM where the user spoke last
	chat("!tg-bob:tg.test", "acc-tg", {
		title: "Bob Test",
		others: ["bob"],
		messages: [msg("!tg-bob:tg.test", "acc-tg", "m-bob-1", "me", 1 * HOUR)],
	});
	// 4. Telegram group with a mention of the user
	chat("!tg-friends:tg.test", "acc-tg", {
		title: "Friends Test",
		type: "group",
		others: ["p1", "p2"],
		unreadCount: 2,
		unreadMentionsCount: 1,
		messages: [
			msg("!tg-friends:tg.test", "acc-tg", "m-fr-1", "p1", 3 * HOUR),
			msg("!tg-friends:tg.test", "acc-tg", "m-fr-2", "p2", 1 * HOUR, { mentions: [ME["acc-tg"]], text: "@me look" }),
		],
	});
	// 5. Muted WeChat group, unread but never mentioned
	chat("!wc-muted:wc.test", "acc-wc", {
		title: "Muted Group WC",
		type: "group",
		others: ["q1"],
		isMuted: true,
		unreadCount: 5,
		messages: [msg("!wc-muted:wc.test", "acc-wc", "m-mu-1", "q1", 4 * HOUR)],
	});
	// 6. Noisy WeChat group, no mention, no reply
	chat("!wc-noise:wc.test", "acc-wc", {
		title: "Noise Group WC",
		type: "group",
		others: ["q2", "q3"],
		unreadCount: 20,
		messages: [msg("!wc-noise:wc.test", "acc-wc", "m-no-1", "q2", 10 * MIN)],
	});
	// 7. Read-only Matrix channel whose last event is a service notice
	chat("!mx-news:mx.test", "acc-mx", {
		title: "Announcements",
		type: "group",
		others: ["r1"],
		isReadOnly: true,
		messages: [
			msg("!mx-news:mx.test", "acc-mx", "m-nw-1", "r1", 5 * HOUR, { type: "NOTICE", text: "room created" }),
		],
	});
	// 8. Archived DM with unread messages
	chat("!wa-arch:wa.test", "acc-wa", {
		title: "Archived Person",
		others: ["arch"],
		isArchived: true,
		unreadCount: 2,
		messages: [msg("!wa-arch:wa.test", "acc-wa", "m-ar-1", "arch", 6 * HOUR)],
	});
	// 9. DM whose newest event is a reaction: the real question is one message earlier
	chat("!wa-react:wa.test", "acc-wa", {
		title: "Reactor WA",
		others: ["react"],
		unreadCount: 1,
		messages: [
			msg("!wa-react:wa.test", "acc-wa", "m-re-1", "react", 1 * HOUR, { text: "are you there?" }),
			msg("!wa-react:wa.test", "acc-wa", "m-re-2", "react", 20 * MIN, {
				type: "REACTION",
				text: undefined,
				reactions: [],
			}),
		],
	});
	// 10. DM with an image carrying an mxc:// asset and a file:// source that must never be served
	chat("!wa-media:wa.test", "acc-wa", {
		title: "Media WA",
		others: ["media"],
		unreadCount: 1,
		messages: [
			msg("!wa-media:wa.test", "acc-wa", "m-md-1", "media", 40 * MIN, {
				type: "IMAGE",
				text: "look at this",
				attachments: [
					{
						id: "mxc://fake.test/photo-1",
						type: "img",
						srcURL: "mxc://fake.test/photo-1",
						mimeType: "image/png",
						fileName: "photo.png",
						fileSize: MEDIA_PNG.length,
						size: { width: 96, height: 72 },
					},
					{
						id: "file:///tmp/secret.txt",
						type: "img",
						srcURL: "file:///tmp/secret.txt",
						mimeType: "image/png",
						fileName: "evil.png",
					},
				],
			}),
		],
	});
	// 11. WeChat group where someone replies to the user's message
	chat("!wc-reply:wc.test", "acc-wc", {
		title: "Reply Group WC",
		type: "group",
		others: ["s1", "s2"],
		unreadCount: 2,
		messages: [
			msg("!wc-reply:wc.test", "acc-wc", "m-rp-1", "me", 5 * HOUR, { text: "shall we meet?" }),
			msg("!wc-reply:wc.test", "acc-wc", "m-rp-2", "s1", 3 * HOUR, {
				text: "ok",
				attachments: [
					{
						id: "mxc://fake.test/photo-1",
						type: "img",
						srcURL: "mxc://fake.test/photo-1",
						mimeType: "image/png",
						fileName: "foto.png",
						fileSize: MEDIA_PNG.length,
						size: { width: 96, height: 72 },
					},
				],
			}),
			msg("!wc-reply:wc.test", "acc-wc", "m-rp-3", "s2", 1 * HOUR, {
				text: "+1 to that",
				linkedMessageID: "m-rp-1",
				attachments: [
					{
						id: "mxc://fake.test/ricetta-1",
						type: "unknown",
						srcURL: "mxc://fake.test/ricetta-1",
						mimeType: "application/pdf",
						fileName: "ricetta.pdf",
						fileSize: 12_288,
					},
				],
			}),
		],
	});
	// 12. Duplicate that Beeper merged into another chat: must not be listed
	chat("!tg-dup:tg.test", "acc-tg", {
		title: "Merged Dup",
		others: ["dup"],
		mergedIntoChatID: "!tg-bob:tg.test",
		unreadCount: 1,
		messages: [msg("!tg-dup:tg.test", "acc-tg", "m-dup-1", "dup", 2 * HOUR)],
	});
	// 13. DM the user marked unread by hand
	chat("!wa-marked:wa.test", "acc-wa", {
		title: "Marked WA",
		others: ["mk"],
		isMarkedUnread: true,
		messages: [msg("!wa-marked:wa.test", "acc-wa", "m-mk-1", "mk", 8 * HOUR)],
	});

	return { chats, messages };
}

/**
 * Starts a fake Beeper on 127.0.0.1. Options: `pageCap` forces smaller chat pages (to
 * exercise pagination), `scope` is what introspection returns.
 */
export async function startFakeBeeper(opts = {}) {
	const state = {
		token: opts.token ?? "fake-token-0123456789abcdefghijklmnopqrstuvwxyz",
		scope: opts.scope ?? "read",
		pageCap: opts.pageCap ?? 50,
		world: buildWorld(),
		latency: new Map(),
		rejectAll: false,
		lostEvents: 0,
		calls: [],
		sockets: new Set(),
		seq: 0,
		// POST /messages scripting: sendStatus cycles once per GET of the pending message
		sendPlan: { http: 200, statuses: ["PENDING", "SUCCESS"], hang: false, deliver: true },
		sends: [],
		pendingSends: new Map(),
	};
	let port = opts.port ?? 0;
	let server;

	const reply = (res, status, body, headers = {}) => {
		const data = body === undefined ? "" : JSON.stringify(body);
		res.writeHead(status, { "content-type": "application/json", "x-beeper-desktop-version": "5.0.0-fake", ...headers });
		res.end(data);
	};

	const latencyFor = (path) => {
		for (const [prefix, ms] of state.latency) if (path.startsWith(prefix)) return ms;
		return 0;
	};

	const authorized = (req) => req.headers.authorization === `Bearer ${state.token}`;

	const emitDomain = (type, chatID, ids) => {
		if (state.lostEvents > 0) {
			state.lostEvents--;
			return;
		}
		for (const ws of state.sockets) {
			if (ws.readyState === ws.OPEN) ws.emitDomain({ type, chatID, ids });
		}
	};

	const handle = async (req, res) => {
		const url = new URL(req.url, "http://fake");
		state.calls.push({ method: req.method, path: url.pathname });
		const delay = latencyFor(url.pathname);
		if (delay) await new Promise((r) => setTimeout(r, delay));
		if (url.pathname === "/oauth/introspect" && req.method === "POST") {
			let body = "";
			for await (const c of req) body += c;
			const token = new URLSearchParams(body).get("token");
			return reply(res, 200, { active: token === state.token, scope: state.scope, token_type: "Bearer" });
		}
		if (state.rejectAll || !authorized(req)) return reply(res, 401, { error: "unauthorized" });
		if (req.method !== "GET") {
			// the one and only write the fake honours; anything else must stay a 405 so a
			// suite notices if the inbox learns a new write
			const sendMatch = req.method === "POST" ? /^\/v1\/chats\/([^/]+)\/messages$/.exec(url.pathname) : null;
			if (!sendMatch) return reply(res, 405, { error: "fake: write endpoints other than POST /messages are not implemented" });
			return sendMessage(res, decodeURIComponent(sendMatch[1]), await readJson(req));
		}

		if (url.pathname === "/v1/info") return reply(res, 200, { app: { version: "5.0.0-fake" } });
		if (url.pathname === "/v1/accounts") return reply(res, 200, ACCOUNTS);
		if (url.pathname === "/v1/chats") return reply(res, 200, listChats(url));
		if (url.pathname === "/v1/assets/serve") return serveAsset(url, res);
		const msgMatch = /^\/v1\/chats\/([^/]+)\/messages\/([^/]+)$/.exec(url.pathname);
		if (msgMatch) {
			const chatID = decodeURIComponent(msgMatch[1]);
			const messageID = decodeURIComponent(msgMatch[2]);
			const msg = (state.world.messages[chatID] ?? []).find((m) => m.id === messageID);
			if (!msg) return reply(res, 404, { error: "not found" });
			const ps = state.pendingSends.get(messageID);
			// each poll advances the scripted sendStatus one step, then sticks on the last
			if (ps) {
				msg.sendStatus = { status: ps.statuses[Math.min(ps.i, ps.statuses.length - 1)], timestamp: new Date().toISOString() };
				if (ps.i < ps.statuses.length) ps.i++;
			}
			return reply(res, 200, msg);
		}
		const chatMatch = /^\/v1\/chats\/([^/]+)(\/messages)?$/.exec(url.pathname);
		if (chatMatch) {
			const id = decodeURIComponent(chatMatch[1]);
			const chat = state.world.chats.find((c) => c.id === id);
			if (!chat) return reply(res, 404, { error: "not found" });
			if (!chatMatch[2]) return reply(res, 200, withoutPreview(chat));
			return reply(res, 200, listMessages(id, url));
		}
		return reply(res, 404, { error: "not found" });
	};

	const withoutPreview = (chat) => {
		const { preview: _p, ...rest } = chat;
		return rest;
	};

	const listChats = (url) => {
		const items = [...state.world.chats]
			.sort((a, b) => (Date.parse(b.lastActivity ?? "") || 0) - (Date.parse(a.lastActivity ?? "") || 0))
			.map((c) => ({ ...c, preview: state.world.messages[c.id]?.at(-1) ?? null }));
		const limit = Math.min(Number(url.searchParams.get("limit") ?? 25), state.pageCap);
		const offset = Number(String(url.searchParams.get("cursor") ?? "o:0").split(":")[1]);
		const page = items.slice(offset, offset + limit);
		const hasMore = offset + limit < items.length;
		return {
			items: page,
			hasMore,
			oldestCursor: hasMore ? `o:${offset + limit}` : null,
			newestCursor: offset > 0 ? `o:${Math.max(0, offset - limit)}` : null,
		};
	};

	const listMessages = (chatID, url) => {
		const all = state.world.messages[chatID] ?? [];
		const pageSize = 20;
		const cursor = url.searchParams.get("cursor");
		const end = cursor ? Number(cursor.split(":")[1]) : all.length;
		const start = Math.max(0, end - pageSize);
		return {
			items: all.slice(start, end),
			hasMore: start > 0,
			oldestCursor: start > 0 ? `m:${start}` : null,
			newestCursor: end < all.length ? `m:${end}` : null,
		};
	};

	const readJson = async (req) => {
		let body = "";
		for await (const c of req) body += c;
		try {
			return JSON.parse(body || "{}");
		} catch {
			return {};
		}
	};

	/**
	 * POST /v1/chats/{id}/messages — the only write the fake performs, scripted by
	 * `sendPlan`: `http` fails the call itself, `hang` never answers (deliver decides
	 * whether the network still got it), `statuses` is the sendStatus cycle each poll
	 * steps through.
	 */
	const sendMessage = (res, chatID, body) => {
		const chat = state.world.chats.find((c) => c.id === chatID);
		if (!chat) return reply(res, 404, { error: "not found" });
		const plan = state.sendPlan;
		const resolved = chat.mergedIntoChatID ?? chatID;
		const id = `pm-${state.sends.length + 1}`;
		state.sends.push({ chatID, resolvedChatID: resolved, body });
		const deliver = () => {
			const msg = {
				id,
				chatID: resolved,
				accountID: chat.accountID,
				senderID: ME[chat.accountID],
				senderName: "Me",
				timestamp: new Date().toISOString(),
				sortKey: String(Date.now()).padStart(15, "0"),
				type: "TEXT",
				text: body.text,
				isSender: true,
				isHidden: false,
				isDeleted: false,
				attachments: [],
				mentions: null,
				reactions: [],
				sendStatus: { status: plan.statuses[0] ?? "PENDING", timestamp: new Date().toISOString() },
				...(body.replyToMessageID ? { linkedMessageID: body.replyToMessageID } : {}),
			};
			state.world.messages[resolved].push(msg);
			state.pendingSends.set(id, { statuses: plan.statuses, i: 0 });
			const target = state.world.chats.find((c) => c.id === resolved);
			target.lastActivity = msg.timestamp;
			emitDomain("message.upserted", resolved, [id]);
		};
		if (plan.hang) {
			// the request leaves and the response never comes: deliver decides the truth
			if (plan.deliver !== false) deliver();
			return;
		}
		if (plan.http !== 200) return reply(res, plan.http, { error: "scripted send failure" });
		if (plan.deliver !== false) deliver();
		return reply(res, 200, { chatID: resolved, pendingMessageID: id });
	};

	const serveAsset = (url, res) => {
		const src = url.searchParams.get("url") ?? "";
		// Like the real endpoint: it accepts file:// too (hypothesis I3), so the inbox must filter.
		if (/^(mxc|localmxc):\/\//.test(src)) {
			res.writeHead(200, { "content-type": "image/png", "content-length": String(MEDIA_PNG.length) });
			return res.end(MEDIA_PNG);
		}
		if (src.startsWith("file://")) {
			res.writeHead(200, { "content-type": "text/plain" });
			return res.end("FAKE-LOCAL-FILE-CONTENT");
		}
		return reply(res, 400, { error: "bad url" });
	};

	server = createServer((req, res) => {
		handle(req, res).catch(() => {
			if (!res.headersSent) reply(res, 500, { error: "fake crash" });
		});
	});

	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (req, socket, head) => {
		if (new URL(req.url, "http://fake").pathname !== "/v1/ws" || !authorized(req) || state.rejectAll) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			state.sockets.add(ws);
			let seq = 0;
			ws.on("close", () => state.sockets.delete(ws));
			ws.on("error", () => {});
			ws.send(JSON.stringify({ type: "ready", version: 1, chatIDs: [], app: { state: false } }));
			ws.on("message", (data) => {
				const m = JSON.parse(String(data));
				if (m.type === "subscriptions.set") {
					ws.send(JSON.stringify({ type: "subscriptions.updated", requestID: m.requestID, chatIDs: m.chatIDs, app: m.app }));
				}
			});
			ws.emitDomain = (ev) => ws.send(JSON.stringify({ ...ev, seq: ++seq, ts: new Date().toISOString() }));
		});
	});

	await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
	port = server.address().port;

	return {
		url: `http://127.0.0.1:${port}`,
		get token() {
			return state.token;
		},
		world: state.world,
		calls: state.calls,
		/** the payloads the server would send for a change: `ids` are chat ids for chat.*, message ids for message.* */
		emit(type, chatID, ids) {
			emitDomain(type, chatID, ids);
		},
		/** the next n events are dropped on the floor, as at-most-once delivery allows */
		loseEvents(n) {
			state.lostEvents += n;
		},
		/** what the real app does on a socket drop: nothing is replayed afterwards */
		dropSockets() {
			for (const ws of state.sockets) ws.terminate();
		},
		/** a tracked chat/message change; does not emit an event unless asked */
		addMessage(chatID, message, { emit = true, unread = true } = {}) {
			const list = state.world.messages[chatID];
			const full = { isSender: false, isHidden: false, isDeleted: false, attachments: [], mentions: null, reactions: [], type: "TEXT", ...message, chatID };
			list.push(full);
			const chat = state.world.chats.find((c) => c.id === chatID);
			chat.lastActivity = full.timestamp;
			if (unread && !full.isSender) chat.unreadCount += 1;
			if (emit) this.emit("message.upserted", chatID, [full.id]);
			return full;
		},
		setToken(token) {
			state.token = token;
		},
		setRejectAll(on) {
			state.rejectAll = on;
		},
		setLatency(ms, pathPrefix = "") {
			if (ms) state.latency.set(pathPrefix, ms);
			else state.latency.delete(pathPrefix);
		},
		/** every POST /messages body, in order */
		get sends() {
			return state.sends;
		},
		/** see sendMessage: http, statuses, hang, deliver */
		setSendPlan(plan) {
			state.sendPlan = { statuses: ["PENDING", "SUCCESS"], hang: false, deliver: true, http: 200, ...plan };
		},
		async down() {
			for (const ws of state.sockets) ws.terminate();
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
		async up() {
			await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
		},
		async close() {
			for (const ws of state.sockets) ws.terminate();
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
