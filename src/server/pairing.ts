import { randomBytes, timingSafeEqual } from "node:crypto";

const TICKET_TTL_MS = 2 * 60 * 1000;

/** One pending ticket per server: issuing again invalidates every older QR. */
export class PairingTickets {
	#pending: { ticket: string; expiresAt: number } | undefined;
	#now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	issue(): { ticket: string; expiresAt: number } {
		const issued = { ticket: randomBytes(32).toString("base64url"), expiresAt: this.#now() + TICKET_TTL_MS };
		// Do not return the stored object: callers must not be able to extend its TTL.
		this.#pending = { ...issued };
		return issued;
	}

	redeem(ticket: string): boolean {
		const pending = this.#pending;
		if (!pending) return false;
		if (this.#now() >= pending.expiresAt) {
			this.#pending = undefined;
			return false;
		}
		// Bound work before allocating a buffer from unauthenticated input.
		if (typeof ticket !== "string" || ticket.length !== pending.ticket.length || !/^[A-Za-z0-9_-]+$/.test(ticket)) return false;
		if (!timingSafeEqual(Buffer.from(ticket), Buffer.from(pending.ticket))) return false;
		this.#pending = undefined;
		return true;
	}
}

/** No credentials are interpolated into this page, including for authenticated browsers. */
export function pairingPage(authed: boolean, advertisedOrigin?: string): string {
	return `<!doctype html>
<html lang="it">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta name="referrer" content="no-referrer">
	<title>Collega un dispositivo · pi-super</title>
	<script>
	(() => {
		const authed = ${authed ? "true" : "false"};
		const advertisedOrigin = ${JSON.stringify(advertisedOrigin ?? null).replaceAll("<", "\\u003c")};
		let ticket = authed ? null : new URLSearchParams(location.hash.slice(1)).get("pair");
		// Remove the fragment before rendering or making any request; keep it only in this closure.
		history.replaceState(null, "", "/pair");
		document.addEventListener("DOMContentLoaded", () => {
			const button = document.getElementById("action");
			const status = document.getElementById("status");
			const help = document.getElementById("help");
			const result = document.getElementById("result");
			const image = document.getElementById("qr");
			const link = document.getElementById("pair-link");
			const countdown = document.getElementById("countdown");
			let timer;
			function clearResult() {
				clearInterval(timer);
				result.hidden = true;
				image.removeAttribute("src");
				link.removeAttribute("href");
				link.textContent = "";
				countdown.textContent = "";
			}
			function passkeyRequired() {
				status.textContent = "Collegamento non valido, scaduto oppure bloccato dalla policy passkey. Se è richiesta una passkey, apri la pagina principale e accedi normalmente: il terminale locale non può aggirarla. Altrimenti genera un nuovo QR sul dispositivo autorizzato.";
				help.hidden = false;
			}
			if (!authed && !ticket) {
				button.hidden = true;
				help.hidden = false;
				status.textContent = "Per collegare questo dispositivo, apri un collegamento temporaneo o scansiona il QR generato da un dispositivo autorizzato.";
			}
			button.addEventListener("click", async () => {
				button.disabled = true;
				clearResult();
				status.textContent = authed ? "Generazione in corso…" : "Collegamento in corso…";
				try {
					if (!authed) {
						if (!ticket) return;
						const redeemTicket = ticket;
						ticket = null;
						const response = await fetch("/api/auth/pair/redeem", {
							method: "POST",
							credentials: "same-origin",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ ticket: redeemTicket }),
						});
						if (response.ok) {
							location.replace("/inbox/");
							return;
						}
						if (response.status === 403) passkeyRequired();
						else status.textContent = "Collegamento scaduto o già utilizzato. Genera un nuovo QR e riprova.";
						help.hidden = false;
						return;
					}
					const response = await fetch("/api/auth/pair/issue", {
						method: "POST",
						credentials: "same-origin",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ origin: location.origin }),
					});
					if (response.status === 403) {
						passkeyRequired();
						return;
					}
					if (!response.ok) throw new Error("issue failed");
					const data = await response.json();
					const url = new URL(data.url);
					if (url.origin !== (advertisedOrigin ?? location.origin) || url.pathname !== "/pair" || url.search || !url.hash.startsWith("#pair=") || typeof data.svg !== "string" || !Number.isFinite(data.expiresAt)) throw new Error("invalid response");
					image.src = "data:image/svg+xml," + encodeURIComponent(data.svg);
					link.href = url.href;
					link.textContent = url.href;
					result.hidden = false;
					status.textContent = "Scansiona il QR sull'altro dispositivo e conferma il collegamento. Un nuovo QR sostituisce il precedente.";
					function tick() {
						const seconds = Math.ceil((data.expiresAt - Date.now()) / 1000);
						if (seconds <= 0) {
							clearResult();
							status.textContent = "QR scaduto. Genera un nuovo collegamento.";
							return;
						}
						countdown.textContent = "Scade tra " + seconds + " s";
					}
					timer = setInterval(tick, 1000);
					tick();
				} catch {
					clearResult();
					status.textContent = "Impossibile completare il collegamento. Controlla la connessione e genera un nuovo QR.";
					help.hidden = false;
				} finally {
					button.disabled = !authed && !ticket;
				}
			});
		});
	})();
	</script>
	<style>
		:root { color-scheme: dark; font-family: system-ui, sans-serif; background: #10131b; color: #edf1fa; }
		* { box-sizing: border-box; }
		body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px; }
		main { width: 100%; max-width: 500px; padding: clamp(20px, 5vw, 36px); background: #1b2130; border: 1px solid #34405a; border-radius: 20px; }
		h1 { font-size: clamp(1.6rem, 6vw, 2rem); margin: 0 0 16px; }
		p { line-height: 1.6; }
		button { width: 100%; min-height: 48px; padding: 12px 18px; border: 0; border-radius: 10px; background: #a9c5ff; color: #101a30; font: inherit; font-weight: 700; cursor: pointer; }
		button:disabled { opacity: .6; cursor: default; }
		button:focus-visible, a:focus-visible { outline: 3px solid #fbd879; outline-offset: 4px; }
		a { color: #b6ceff; overflow-wrap: anywhere; }
		code { display: block; padding: 12px; background: #10131b; border-radius: 8px; overflow-wrap: anywhere; white-space: normal; }
		#qr { display: block; width: min(100%, 300px); height: auto; margin: 20px auto; padding: 12px; background: white; border-radius: 10px; }
		#countdown { font-variant-numeric: tabular-nums; }
		[hidden] { display: none !important; }
	</style>
</head>
<body>
	<main>
		<h1>Collega un dispositivo</h1>
		<p id="status" role="status" aria-live="polite">${authed ? "Genera un QR temporaneo per collegare un altro dispositivo. Il collegamento è monouso e dura due minuti." : "Conferma per collegare questo dispositivo a pi-super. Il collegamento è monouso e dura due minuti."}</p>
		<button id="action" type="button">${authed ? "Genera QR" : "Collega questo dispositivo"}</button>
		<section id="result" aria-label="Collegamento temporaneo" hidden>
			<img id="qr" alt="QR per collegare un dispositivo">
			<p><a id="pair-link" rel="noreferrer">Collegamento temporaneo</a></p>
			<p id="countdown" aria-live="off"></p>
		</section>
		<p><a href="/">Apri pi-super / accesso con passkey</a> · <a href="/inbox/">Torna all’inbox</a></p>
		<section id="help" hidden>
			<p>Dal terminale locale sul computer che esegue pi-super, avvia:</p>
			<code>pi-super --pair-url https://&lt;host&gt;</code>
			<p>Sostituisci &lt;host&gt; con il tuo indirizzo HTTPS. Apri il collegamento generato sul dispositivo da autorizzare. Non condividere il QR o il collegamento con altre persone.</p>
		</section>
		<noscript>Attiva JavaScript per confermare il collegamento. Nessun dispositivo viene collegato automaticamente.</noscript>
	</main>
</body>
</html>`;
}
