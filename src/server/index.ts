#!/usr/bin/env node
import { networkInterfaces } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureToken } from "./auth.js";
import { defaultClientDir, defaultMetaDir, helpText, migrateLegacyStateDir, parseArgs } from "./config.js";
import { LOCAL, herdrRun, savedMachines } from "./herdr.js";
import { createServer } from "./server.js";
import { Tmux } from "./tmux.js";
import { PasskeyStore } from "./webauthn.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
	let args: ReturnType<typeof parseArgs>;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`pi-super: ${String((err as Error).message)}\n\n${helpText()}`);
		process.exit(2);
	}
	if (args.help) {
		process.stdout.write(helpText());
		return;
	}

	migrateLegacyStateDir(args.stateDir);
	const token = ensureToken(args.stateDir, args.resetToken);
	if (args.resetToken) {
		process.stdout.write(`new token: ${token}\n`);
		return;
	}
	if (args.printUrl) {
		// Printing ?token=… once passkeys are the gate advertises a credential the server
		// will refuse — and invites pasting a still-powerful secret into a chat window.
		const store = new PasskeyStore(args.stateDir);
		// same rule the startup banner uses: in `passkey` mode the token opens nothing at
		// all, enrolled or not
		const tokenUsable = args.authMode === "token" || args.allowToken || (args.authMode === "auto" && !store.enrolled);
		process.stdout.write(
			tokenUsable
				? `http://${args.host}:${args.port}/?token=${token}\n`
				: `http://${args.host}:${args.port}/\n# passkey unlock — the token no longer opens the app (--allow-token to keep it working)\n`,
		);
		return;
	}

	if (args.listPasskeys || args.removePasskey || args.logout) {
		const store = new PasskeyStore(args.stateDir);
		if (args.removePasskey) {
			const removed = store.removeCredential(args.removePasskey);
			process.stdout.write(removed ? `removed ${args.removePasskey}\n` : `no such passkey: ${args.removePasskey}\n`);
		}
		if (args.logout) {
			store.revokeAllSessions();
			process.stdout.write("all passkey sessions revoked\n");
		}
		if (args.listPasskeys) {
			if (store.credentials.length === 0) process.stdout.write("no passkeys enrolled\n");
			for (const c of store.credentials) {
				process.stdout.write(`${c.label}\t${c.id.slice(0, 16)}…\tadded ${c.createdAt}\tlast used ${c.lastUsedAt ?? "never"}\n`);
			}
		}
		return;
	}

	const cfg = { ...args, clientDir: defaultClientDir(moduleDir), metaDir: defaultMetaDir(moduleDir) };
	const tmux = new Tmux(cfg.socketArgs);
	try {
		await tmux.version();
	} catch {
		process.stderr.write("pi-super: cannot talk to tmux — is a tmux server running?\n");
		process.exit(1);
	}
	const sessions = await tmux.listSessions();
	if (sessions.length === 0) {
		process.stderr.write("pi-super: no tmux sessions found — start tmux first\n");
		process.exit(1);
	}

	// tmux is mandatory; herdr is opportunistic — probe it once here so the meta
	// agent gets its fleet tools only when herdr can actually answer.
	if (cfg.herdrEnabled) {
		try {
			await herdrRun(LOCAL, ["status"], { bin: cfg.herdrBin, timeoutMs: 8000 });
		} catch {
			process.stdout.write("pi-super: herdr not available — meta agent runs without fleet tools\n");
			cfg.herdrEnabled = false;
		}
	}
	if (cfg.herdrEnabled) {
		if (cfg.herdrMachines === "auto") {
			const saved = await savedMachines({ bin: cfg.herdrBin }).catch(() => [] as string[]);
			cfg.herdrMachines = [LOCAL, ...saved].join(",");
		} else {
			cfg.herdrMachines = cfg.herdrMachines
				.split(",")
				.map((m) => m.trim())
				.filter(Boolean)
				.join(",");
		}
		if (!cfg.herdrMachines) cfg.herdrEnabled = false;
	}

	const server = createServer(cfg, token);
	server.http.listen(cfg.port, cfg.host, () => {
		server.resumeMeta();
		process.stdout.write(`pi-super listening on http://${cfg.host}:${cfg.port}\n`);
		const store = new PasskeyStore(cfg.stateDir);
		const tokenUsable = cfg.authMode === "token" || cfg.allowToken || (cfg.authMode === "auto" && !store.enrolled);
		process.stdout.write(
			tokenUsable
				? `  open: http://${displayHost(cfg.host)}:${cfg.port}/?token=${token}\n`
				: `  open: http://${displayHost(cfg.host)}:${cfg.port}/ (passkey unlock)\n`,
		);
		if (store.enrolled && cfg.authMode !== "token") {
			process.stdout.write(
				`  passkey required (${store.credentials.length} enrolled${cfg.allowToken ? ", token still accepted" : ""})\n`,
			);
		} else {
			process.stdout.write("  no passkey enrolled yet — open the app and add one from the menu\n");
		}
		if (cfg.herdrEnabled) {
			process.stdout.write(`  herdr machines: ${cfg.herdrMachines}\n`);
		}
		if (cfg.host !== "127.0.0.1" && cfg.host !== "localhost") {
			process.stdout.write("  ! bound off-loopback: terminal access == shell access, use TLS/VPN\n");
		}
	});

	const shutdown = () => {
		void server.close().then(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

function displayHost(host: string): string {
	if (host !== "0.0.0.0" && host !== "::") return host;
	for (const addrs of Object.values(networkInterfaces())) {
		for (const a of addrs ?? []) {
			if (a.family === "IPv4" && !a.internal) return a.address;
		}
	}
	return "localhost";
}

main().catch((err) => {
	process.stderr.write(`pi-super: ${String(err?.stack ?? err)}\n`);
	process.exit(1);
});
