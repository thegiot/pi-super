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
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
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
						size: { width: 1, height: 1 },
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
			msg("!wc-reply:wc.test", "acc-wc", "m-rp-2", "s1", 3 * HOUR, { text: "ok" }),
			msg("!wc-reply:wc.test", "acc-wc", "m-rp-3", "s2", 1 * HOUR, {
				text: "+1 to that",
				linkedMessageID: "m-rp-1",
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
		if (req.method !== "GET") return reply(res, 405, { error: "fake: write endpoints are not implemented" });

		if (url.pathname === "/v1/info") return reply(res, 200, { app: { version: "5.0.0-fake" } });
		if (url.pathname === "/v1/accounts") return reply(res, 200, ACCOUNTS);
		if (url.pathname === "/v1/chats") return reply(res, 200, listChats(url));
		if (url.pathname === "/v1/assets/serve") return serveAsset(url, res);
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
			if (state.lostEvents > 0) {
				state.lostEvents--;
				return;
			}
			for (const ws of state.sockets) {
				if (ws.readyState === ws.OPEN) ws.emitDomain({ type, chatID, ids });
			}
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
