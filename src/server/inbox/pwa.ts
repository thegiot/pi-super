import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

export const INBOX_MANIFEST_PATH = "/inbox/manifest.webmanifest";

// Browser installability checks do not carry login credentials. Only these build-owned,
// secret-free files are public; never expose the app bundle or the notification worker.
const PUBLIC_ASSETS = new Map([
	[INBOX_MANIFEST_PATH, { file: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" }],
	["/inbox/icons/inbox-192.png", { file: "icons/inbox-192.png", type: "image/png" }],
	["/inbox/icons/inbox-512.png", { file: "icons/inbox-512.png", type: "image/png" }],
]);

export function serveInboxPwaAsset(
	req: IncomingMessage,
	res: ServerResponse,
	dir: string,
	securityHeaders: Record<string, string>,
): boolean {
	if (req.method !== "GET" && req.method !== "HEAD") return false;
	// Compare the original path, not a decoded/normalized URL: encoded aliases, suffixes
	// and traversal must go through the ordinary auth gate, not expand this allowlist.
	const asset = PUBLIC_ASSETS.get((req.url ?? "").split("?", 1)[0]!);
	if (!asset) return false;
	let data: Buffer;
	try {
		data = readFileSync(join(dir, asset.file));
	} catch {
		res.writeHead(404, { ...securityHeaders, "cache-control": "no-store" }).end();
		return true;
	}
	res.writeHead(200, {
		...securityHeaders,
		"content-type": asset.type,
		"content-length": data.length,
		"cache-control": "public, max-age=300",
	});
	res.end(req.method === "HEAD" ? undefined : data);
	return true;
}
