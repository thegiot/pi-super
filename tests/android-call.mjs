#!/usr/bin/env node
/**
 * The Android wrapper, tested on a real Android: boots a headless emulator, installs the
 * debug APK, points it at a throwaway page that drives the JS bridge, and then checks
 * what the *system* thinks — `dumpsys telecom` for a real self-managed call, `dumpsys
 * activity services` for the foreground service.
 *
 *   node tests/android-call.mjs [--keep]
 *
 * Needs an Android SDK (ANDROID_HOME or ANDROID_SDK_ROOT) with `emulator`,
 * `platform-tools` and a system image, plus KVM. Skips politely (exit 0) if the SDK is
 * not there, since this is not something CI on a random box can do.
 *
 * What it cannot tell us, and what therefore still needs a phone: whether WebView's own
 * WebRTC audio actually follows the Telecom route onto a Bluetooth headset.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEEP = process.argv.includes("--keep");
const SDK = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(process.env.HOME, "opt/android-sdk");
const ADB = join(SDK, "platform-tools/adb");
const EMULATOR = join(SDK, "emulator/emulator");
const AVDMANAGER = join(SDK, "cmdline-tools/latest/bin/avdmanager");
const APK = new URL("../android/app/build/outputs/apk/debug/app-debug.apk", import.meta.url).pathname;
const PKG = "dev.pasky.pisuper";
const AVD = "pi-super-test";
const IMAGE = process.env.ANDROID_IMAGE ?? "system-images;android-34;google_apis;x86_64";
const PORT = 8891;
/** the host, as seen from inside the emulator */
const HOST = `http://10.0.2.2:${PORT}`;

const log = (...a) => console.log("·", ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...args) => spawnSync(ADB, args, { encoding: "utf8" });
const cleanups = [];
const cleanup = async () => {
	for (const fn of cleanups.reverse()) {
		try {
			await fn();
		} catch {
			/* best effort */
		}
	}
};

const failures = [];
const check = (ok, what) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
	if (!ok) failures.push(what);
};

if (!existsSync(EMULATOR) || !existsSync(ADB)) {
	console.log(`SKIP  no Android SDK at ${SDK} (set ANDROID_HOME)`);
	process.exit(0);
}
if (!existsSync(APK)) {
	console.log("SKIP  no debug APK — run `npm run build:android` first");
	process.exit(0);
}

// ------------------------------------------------------------------ the driven page

/** events the page reported, in order */
const reports = [];
/** commands the page should run next, drained by its poll */
const commands = [];

const PAGE = `<!doctype html><meta charset=utf-8><title>bridge</title><body><pre id=out></pre><script>
const out = document.getElementById("out");
const say = (o) => { out.textContent += JSON.stringify(o) + "\\n";
	fetch("/report", { method: "POST", body: JSON.stringify(o) }); };
say({ type: "loaded", bridge: typeof window.PiNative?.postMessage === "function" });
window.addEventListener("pi-native", (e) => say({ type: "event", detail: e.detail }));
setInterval(async () => {
	const cmd = await (await fetch("/cmd")).json();
	if (cmd) window.PiNative.postMessage(JSON.stringify(cmd));
}, 300);
</script>`;

const server = createServer((req, res) => {
	if (req.url === "/report") {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			try {
				const ev = JSON.parse(body);
				// A reload (WebView restoring state, the activity being recreated) would otherwise
				// leave a command queued for a page instance that is already gone.
				if (ev.type === "loaded") commands.length = 0;
				reports.push(ev);
				log("page:", JSON.stringify(ev));
			} catch {
				/* ignore */
			}
			res.writeHead(204).end();
		});
		return;
	}
	if (req.url === "/cmd") {
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(commands.shift() ?? null));
		return;
	}
	res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
});

/** wait for a reported event matching `pred`, or throw */
async function expect(pred, what, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const hit = reports.find(pred);
		if (hit) return hit;
		await wait(200);
	}
	throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------- the emulator

function ensureAvd() {
	const have = spawnSync(EMULATOR, ["-list-avds"], { encoding: "utf8" }).stdout ?? "";
	if (have.split("\n").includes(AVD)) return;
	log(`creating avd ${AVD}`);
	const r = spawnSync(AVDMANAGER, ["create", "avd", "-n", AVD, "-k", IMAGE, "-d", "pixel_6", "--force"], {
		encoding: "utf8",
		input: "no\n",
		env: { ...process.env, ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK },
	});
	if (r.status !== 0) throw new Error(`avdmanager failed: ${r.stdout}${r.stderr}`);
}

async function boot() {
	log("booting emulator (headless)");
	const emu = spawn(
		EMULATOR,
		// -wipe-data: a previous run's telecom/permission state must not decide this one
		[
			"-avd",
			AVD,
			"-no-window",
			"-no-audio",
			"-no-boot-anim",
			"-no-snapshot",
			"-wipe-data",
			"-gpu",
			"swiftshader_indirect",
		],
		{ stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK } },
	);
	emu.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(String(d)));
	emu.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(String(d)));
	cleanups.push(() => {
		adb("emu", "kill");
		emu.kill("SIGTERM");
	});

	adb("start-server");
	const deadline = Date.now() + 300_000;
	while (Date.now() < deadline) {
		const booted = adb("shell", "getprop", "sys.boot_completed").stdout?.trim();
		if (booted === "1") {
			log("emulator up");
			await wait(2000);
			return;
		}
		await wait(2000);
	}
	throw new Error("emulator did not boot in five minutes");
}

/**
 * Just the live calls out of a telecom dump. The rest of it names our phone *account*
 * (registered for good) and keeps a history full of the word ACTIVE, so a naive grep
 * passes whether or not a call exists.
 */
function callsRegion(dump) {
	return dump.split("mCalls:")[1]?.split("mCallAudioManager:")[0] ?? "";
}

// --------------------------------------------------------------------------- the run

async function main() {
	await new Promise((r) => server.listen(PORT, "0.0.0.0", r));
	cleanups.push(() => new Promise((r) => server.close(r)));
	ensureAvd();
	await boot();

	log("installing apk");
	const install = adb("install", "-r", "-g", APK);
	if (!/Success/.test(install.stdout ?? "")) throw new Error(`install failed: ${install.stdout}${install.stderr}`);
	cleanups.push(() => {
		if (!KEEP) adb("uninstall", PKG);
	});

	// Seed the server URL the way the setup screen would, so the run needs no typing.
	const prefs = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map><string name="url">${HOST}/</string></map>`;
	adb("shell", "run-as", PKG, "mkdir", "-p", `/data/data/${PKG}/shared_prefs`);
	adb(
		"shell",
		`run-as ${PKG} sh -c "cat > /data/data/${PKG}/shared_prefs/pi-super.xml" <<'EOF'\n${prefs}\nEOF`,
	);
	const wrote = adb("shell", "run-as", PKG, "cat", `/data/data/${PKG}/shared_prefs/pi-super.xml`).stdout ?? "";
	if (!wrote.includes(HOST)) throw new Error(`could not seed prefs: ${wrote}`);

	adb("logcat", "-c");
	log("launching");
	adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);

	const loaded = await expect((e) => e.type === "loaded", "the page to load", 120_000);
	check(loaded.bridge === true, "the page sees the native bridge");

	// --- a call, from the page's point of view and from the system's ------------------
	await wait(1500); // let any reload settle, so the command reaches the page that stays
	commands.push({ type: "startCall", callId: "test1" });
	const ready = await expect((e) => e.detail?.type === "callReady", "callReady");
	check(ready.detail.mode === "telecom", `the OS gave us a telecom call (got ${ready.detail.mode})`);
	check(ready.detail.callId === "test1", "the call id round-trips");

	const telecom = adb("shell", "dumpsys", "telecom").stdout ?? "";
	writeFileSync("/tmp/pi-super-telecom.txt", telecom);
	check(callsRegion(telecom).includes(PKG), "telecom has a live pi-super call");
	check(/self_mng|SELF_MANAGED/.test(callsRegion(telecom)), "…and it is a self-managed one");

	const services = adb("shell", "dumpsys", "activity", "services", PKG).stdout ?? "";
	check(/CallService/.test(services), "the foreground call service is running");
	check(/isForeground=true/.test(services), "…and it is actually in the foreground");

	commands.push({ type: "markActive", callId: "test1" });
	await wait(2000);
	const active = adb("shell", "dumpsys", "telecom").stdout ?? "";
	writeFileSync("/tmp/pi-super-telecom-active.txt", active);
	check(/state=ACTIVE/.test(callsRegion(active)), "the call goes active once WebRTC is up");

	const audioBefore = adb("shell", "dumpsys", "audio").stdout ?? "";
	check(/mode.*IN_COMMUNICATION|MODE_IN_COMMUNICATION/.test(audioBefore), "audio mode is in-communication");

	commands.push({ type: "endCall", callId: "test1" });
	await wait(3000);
	const after = adb("shell", "dumpsys", "telecom").stdout ?? "";
	check(!callsRegion(after).includes(PKG), "hanging up leaves no call behind");
	const servicesAfter = adb("shell", "dumpsys", "activity", "services", PKG).stdout ?? "";
	check(!/CallService/.test(servicesAfter), "the foreground service is gone with it");

	const crash = adb("logcat", "-d", "-s", "AndroidRuntime:E").stdout ?? "";
	check(!crash.includes(PKG), "nothing crashed");
}

main()
	.then(async () => {
		if (!KEEP) await cleanup();
		console.log(failures.length ? `\n${failures.length} failure(s)` : "\nall good");
		process.exit(failures.length ? 1 : 0);
	})
	.catch(async (err) => {
		console.error("ERROR", err.message);
		if (!KEEP) await cleanup();
		process.exit(1);
	});
