import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const EXT_BY_TYPE: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/heic": "heic",
	"text/plain": "txt",
	"application/pdf": "pdf",
};

const MAGIC: Array<{ ext: string; bytes: number[]; offset?: number }> = [
	{ ext: "png", bytes: [0x89, 0x50, 0x4e, 0x47] },
	{ ext: "jpg", bytes: [0xff, 0xd8, 0xff] },
	{ ext: "gif", bytes: [0x47, 0x49, 0x46, 0x38] },
	{ ext: "webp", bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
	{ ext: "pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
];

function sniff(buf: Buffer): string | undefined {
	for (const m of MAGIC) {
		const off = m.offset ?? 0;
		if (buf.length < off + m.bytes.length) continue;
		if (m.bytes.every((b, i) => buf[off + i] === b)) return m.ext;
	}
	return undefined;
}

function safeExt(name: string | null, contentType: string | undefined, buf: Buffer): string {
	const sniffed = sniff(buf);
	if (sniffed) return sniffed;
	const byType = contentType ? EXT_BY_TYPE[contentType.split(";")[0]!.trim()] : undefined;
	if (byType) return byType;
	const m = name?.match(/\.([A-Za-z0-9]{1,8})$/);
	return m ? m[1]!.toLowerCase() : "bin";
}

export function readBody(req: IncomingMessage, limit = MAX_UPLOAD_BYTES): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > limit) {
				reject(new Error("payload too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/** Store an uploaded blob as a 0600 file and return its absolute path. */
export function storeUpload(stateDir: string, buf: Buffer, name: string | null, contentType?: string): string {
	const dir = join(stateDir, "uploads");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const file = join(dir, `${stamp}-${randomBytes(4).toString("hex")}.${safeExt(name, contentType, buf)}`);
	writeFileSync(file, buf, { mode: 0o600 });
	return file;
}
