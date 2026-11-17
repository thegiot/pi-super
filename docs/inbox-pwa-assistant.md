# PWA e assistente informativo — 17 novembre 2026

## Flusso

- Apri la inbox in Chrome Android. Il pulsante **Installa app** usa il prompt nativo quando Chrome lo mette a disposizione; altrimenti spiega il menu ⋮ → Installa app / Aggiungi a schermata Home.
- Manifest stabile con identità e avvio `/inbox/`, modalità standalone, icone 192 e 512. Anche la pagina di associazione pubblicizza lo stesso manifest.
- Installare non autentica un dispositivo. Se la PWA non conserva una sessione autorizzata, occorre il QR generato da un browser autorizzato. Nessun token da modificare a mano.
- Le chat richiedono connessione. Nessuna cache offline o copia persistente delle conversazioni. Il worker rimane dedicato alle notifiche e non viene registrato automaticamente dall'installazione.

## Assistente

L'icona con le scintille nella barra della chat apre il pannello. Le domande libere, **Riassumi** e **Di cosa hanno parlato?** producono risposte informative, non bozze. **Proponi risposta** e **Riformula** richiedono esplicitamente una bozza; **Usa come bozza** resta un passaggio separato verso il composer, seguito da revisione e conferma prima dell'invio.

L'API accetta `intent: "answer" | "draft"`, predefinito `answer`. Server e client eliminano eventuali bozze restituite erroneamente dal modello in modalità informativa. Non vengono introdotti strumenti, chiamate in background o accesso ad altre chat. Le istruzioni chiedono italiano naturale, distinzione tra fatti e interpretazioni e trasparenza sui limiti della cronologia e sulle immagini non visibili.

Il pannello separa intestazione, contenuto scorrevole e comandi fissi. Le bolle non si restringono sotto il testo. Il contenitore tiene conto del visual viewport; il comportamento della tastiera fisica Android resta da confermare sul telefono. I controlli di importanza/privacy seguono la conversazione senza occupare l'inizio della risposta.

## Verifica

Test HTTP e store coprono domande informative anche quando il provider restituisce una bozza, intento non valido, bozze esplicite e revoca durante una risposta pendente. Test PWA verificano manifest/icone senza cookie, MIME, HEAD, confini di autenticazione e installabilità CDP Chromium sia sulla inbox autorizzata sia sulla pagina pairing senza cookie. Screenshot mobili aggiuntivi coprono risposta lunga, viewport bassa e istruzioni d'installazione; nessuna chat reale viene inviata al modello durante le prove.

## Revisione finale locale

Ripresa dal commit `8e84d1e` nel worktree `/workspace/tools/pi-super-inbox`, branch `inbox-m1`, conservando e revisionando il diff esistente e tutti i file nuovi. Nessun difetto bloccante emerso dalla revisione di allowlist, autenticazione, intento e privacy. Il worker notifiche non è modificato e non contiene handler fetch o cache delle chat. Le chiamate al modello restano su richiesta, senza strumenti; i test verificano anche isolamento della chat e rifiuto delle risposte dopo revoca privacy.

Confronto visivo con il [pannello assistente Figma](https://www.figma.com/design/b0R0Ha4H3ZFeasfSJYciqj?node-id=11-234): mantenuti tema, sheet, gerarchia e azione esplicita per usare una bozza. Il footer separato risolve il caso lungo senza spostare i controlli privacy davanti alla conversazione.

Verifiche ripetute il 17 novembre 2026:

- `npm run typecheck`: PASS, incluso `bun run check`, 0 errori e 0 warning.
- `timeout 300 npm test`: 254/254 PASS, nessun test saltato. Inclusi HTTP, auth token/passkey, client store e CDP Chromium.
- `npm run build`: PASS.
- `SHOTS_PORT=18796 SHOTS_CDP_PORT=19334 CHROME_BIN=/usr/bin/chromium timeout 180 node tests/mobile-shots.mjs --inbox-only`: PASS. Screenshot finali 28/29/30 rigenerati e ispezionati singolarmente, insieme alle viste desktop 13/23; risposta subito visibile, contenuto scorrevole e footer senza sovrapposizioni.
- `git diff --check`: PASS.
- Autofixer Svelte su pannello, installazione, lista e store: nessun issue; suggerimenti generici sugli effect del pannello valutati per focus, privacy e visual viewport.

### Prova Android e distribuzione

Installabilità CDP e viewport emulata non dimostrano l'installazione sul telefono fisico. Dopo il deploy autorizzato su HTTPS, resta da verificare in Chrome Android installazione dal pulsante/menu, apertura standalone dall'icona, sessione o pairing QR e risposta lunga con tastiera aperta, scorrendo fino alla fine. Verificare che una domanda informativa non mostri una bozza e che solo «Proponi risposta» ne richieda una. La prova di consegna Web Push resta un follow-up M4 separato.

La prima consegna locale `b8e7fac` è stata creata con hook disabilitati in attesa della conferma del proprietario. Le prove di conversazione usano fixture isolate.

## Deploy autorizzato su K29

Il proprietario ha confermato push e deploy. Il 17 novembre 2026 `b8e7fac` è stato pubblicato su `origin/inbox-m1` e applicato con fast-forward al checkout pulito `/workspace/pi-super` su K29, sempre su `inbox-m1`. Eseguiti `npm ci`, typecheck con Bun check a zero errori/warning, build completa e `timeout 300 npm test`, 254/254 PASS senza skip. La prima suite aveva letto il vecchio `dist/inbox/index.html` e Chromium aveva superato gli 8 secondi di startup. Dopo build aggiornata e verifica separata dell'avvio Chromium, la suite completa è passata. Per questa procedura eseguire la build prima dei test che consumano `dist/inbox`.

`pi-super.service` è stato riavviato esplicitamente alle **20:06:07 CET**, con stato `active/running`. Lo smoke su [super.thegiot.com](https://super.thegiot.com/inbox/) ha verificato manifest pubblico e contenuto delle icone 192/512 con GET/HEAD, CSP della pagina pairing, accesso autenticato a inbox/bundle/worker e blocco senza credenziali di API, app e worker. Il worker mantiene il solo comportamento notifiche. Beeper e assistente risultano `ok`, con cinque account. Una richiesta con intento non valido riceve 400 prima di raggiungere il modello. Nessuna domanda valida è stata inviata al provider e nessun messaggio è stato inviato.

Chromium headless, con profilo temporaneo e senza cookie, ha verificato sul vero HTTPS `/pair` manifest e installabilità senza errori. L'installazione e la tastiera del telefono fisico restano da provare.

La verifica ha rilevato che il proxy HTTPS normalizza `/inbox/%6danifest.webmanifest` al manifest pubblico. Il server diretto rifiuta quell'alias senza autenticazione come previsto dalla propria allowlist raw. Il contenuto pubblico coincide con il manifest previsto e gli endpoint protetti restano bloccati, anche attraverso un alias codificato della API.
