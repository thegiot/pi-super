# Inbox M4 — consegna e verifica (17 novembre 2026)

## Decisioni del proprietario

- **D13: importanza solo on-demand**, dalla chat aperta. Nessun batch, scheduler, refresh o evento WS invia contenuti al modello.
- **D14: Web Push nella SPA**, non nel wrapper Android. Richiede browser compatibile e contesto sicuro; la consegna a pagina chiusa dipende dal browser/OS, non è una garanzia di esecuzione continua.
- **D15: titoli chat autorizzati** nel payload e sulla lockscreen. Mai testi dei messaggi o motivi derivati dal modello. L'interfaccia esplicita questa esposizione prima dell'attivazione.

## Implementazione

### Importanza e privacy

`POST /api/inbox/chats/:id/importance` valuta esclusivamente la chat richiesta, se ancora in «Da rispondere». Schema `{importanza, motivo, fiducia}`; evidenza solo `alta` con fiducia non bassa. L'ordinamento mette prima livello 1/alta, poi normale/non valutata/bassa fiducia, infine bassa con fiducia sufficiente. Nessuna valutazione cambia l'appartenenza a «Da rispondere».

«Perché è importante» è nel pannello assistente. Il motivo è testo inerte nella riga conversazione. Cache solo RAM: TTL 5 minuti, massimo 120 chat, invalidazione su revisioni/eventi/correzioni; massimo 2 chiamate simultanee e 6 avvii/minuto, nessuna coda o retry. Contesto fino a 40 messaggi/24k caratteri, `<` escapato nel blocco `chat_data`, Responses API `store:false`, zero strumenti, risposta limitata e validata. Nessun motivo o valutazione su disco.

`POST /api/inbox/chats/:id/model-exclusion` con `{scope:"chat"|"network",on:boolean}` aggiorna `inbox-corrections.json` v1 (flag `modelExcluded`, elenco opzionale `modelExcludedNetworks`). Esclude anche l'assistente generico, non la chat dalla lista. Revoca e riabilitazione invalidano risultati pendenti; controlli prima/dopo lettura e provider, sequenze client impediscono che GET o WS tardivi ripristinino dati revocati. I contenuti già trasmessi prima della revoca non possono essere ritirati dal provider.

### Web Push

- `GET /api/inbox/notifications`: sola chiave VAPID **pubblica**.
- `POST /api/inbox/notifications/subscriptions`: iscrizione browser, autenticata e con controllo Origin.
- `DELETE /api/inbox/notifications/subscriptions`: revoca per endpoint.
- Il service worker `/inbox/inbox-sw.js`, scope `/inbox/`, gestisce solo push e click: nessun fetch handler, cache offline, messaggio o credenziale salvata.
- Attivazione esplicita; una normale visita non registra il worker né chiede permessi. Disattivazione tenta separatamente revoca browser e server, con errore/retry visibile.
- Stato `inbox-notifications.json`: VAPID, iscrizioni e proprietario di autenticazione (id sessione/hash token), scrittura atomica 0600. Nessun titolo, testo, motivo o storico notifiche. Revoca sessione/token verificata prima di ogni invio.
- Solo chat importanti livello 1 o livello 2 valide e ancora da rispondere, con nuovo ultimo messaggio significativo in entrata. Primo snapshot silenzioso; deduplica RAM, nessuna raffica dello storico al riavvio/iscrizione. Una promozione on-demand successiva può notificare una versione nuova non consumata.
- Fino a 20 iscrizioni, scadenza locale 90 giorni, cooldown 30 secondi, massimo 60 tentativi/ora, 3 invii simultanei, timeout totale 8 secondi, TTL push 300 secondi. Nessun retry automatico; 404/410 rimuovono l'iscrizione.
- Endpoint HTTPS consentiti solo FCM, Mozilla, Apple e sottodomini Windows previsti; DNS pubblico verificato e fissato alla connessione, nessun redirect/proxy. Provider self-hosted non supportati senza modifica esplicita server.
- Payload singolo: titolo chat e frase fissa; multiplo: conteggio e fino a tre titoli sanitizzati. Click limitato alla inbox dello stesso origin, mai al terminale o a URL esterni.

## Verifiche eseguite

- `npm run typecheck`: PASS.
- `timeout 300 npm test`: **229/229 PASS** (188 pre-M4, 41 aggiunti).
- `npm run build`: PASS, incluso bundle statico e service worker.
- `cd inbox && ~/.local/bin/bun run check`: 0 errori, 0 warning.
- Autofixer Svelte eseguito sui componenti/moduli modificati: nessun issue; effetti imperativi di focus/lifecycle/privacy mantenuti intenzionalmente.
- `git diff --check`: PASS.
- `SHOTS_PORT=18796 SHOTS_CDP_PORT=19334 CHROME_BIN=/usr/bin/chromium timeout 180 node tests/mobile-shots.mjs --inbox-only`: PASS, exit 0, solo server e provider finti locali.

Screenshot inbox 01–23 (24 immagini contando entrambe le larghezze di 23), in `/tmp/pi-super-shots/`, guardati singolarmente: filtri, DM/gruppo/media, snooze, stati Beeper, badge, assistente/errori, composer/review/invio, importanza, esclusioni e disclosure push. Mobile 412×915 CSS, desktop 1440 e 1024. L'ispezione ha trovato il terzo pannello tagliato a 1024: ora tre colonne da 1280, sheet a 1024, più asserzione geometrica dei bordi. Screenshot chiave: `inbox-19-importance-mobile.png`, `inbox-21-excluded-mobile.png`, `inbox-22-notifications-mobile.png`, `inbox-23-m4-desktop-1440.png`, `inbox-23-m4-desktop-1024.png`.

Test nuovi: schema/limiti/cache/budget modello; chat ostili e isolamento tra chat; assenza di scritture Beeper e contenuti su disco/log; esclusioni persistenti/rete/revoca in-flight; eventi edit/notice/reaction; auth/Origin; transport push cifrato/DNS/SSRF; dedup/budget/scadenza/stop; service worker e click; race client GET/WS.

## Deviazioni e limiti dichiarati

1. Nessun batch in background: escluso dalla decisione D13, non una parte mancante da attivare automaticamente.
2. Nessun canale Android né APK modificato. Non provata la ricezione Web Push su dispositivo reale o provider esterno: cifratura/trasporto verificati con mock deterministici; serve smoke su HTTPS/browser dopo il deploy del proprietario.
3. **Outbox WeChat lasciata invariata**: nessun accesso live/invio reale. Non è prudente trasformare un match testuale ancora pending in successo o fare retry senza osservare pendingMessageID/eventi reali. Il candidato fallback automatico resta follow-up, non una garanzia di M4.
4. Nessuna nuova osservazione del formato `ids` WS su reti reali; restano fake fixture e comportamento M1 esistente.
5. Deduplica push non persistita per non conservare storico delle chat: il riavvio usa una baseline silenziosa; guasti, budget e browser/OS possono perdere notifiche, mai causare reinvii di messaggi.
6. Suite screenshot isolata `--inbox-only`: non attraversa il blocco terminale preesistente dopo `03g-peek-markdown`. Porte configurabili e socket tmux per processo evitano interferenze con altri harness.
7. Nessun push, deploy, accesso K29 o riavvio live. Commit con hook disabilitati per questa singola operazione: il proprietario revisiona e distribuisce.

## Smoke successivo al deploy (proprietario)

Aprire `/inbox/` via HTTPS nel browser supportato, espandere Notifiche, attivare esplicitamente e confermare il permesso. Dopo la baseline, ricevere un messaggio in una chat importante ancora da rispondere; verificare titolo/conteggio senza testo, ricezione a pagina chiusa e click che apre solo la inbox. Disattivare e verificare assenza di altre notifiche. Su una chat non esclusa chiedere l'importanza, poi escludere chat/rete: risultato sparisce e nessuna azione modello resta disponibile. Non usare un invio reale come test senza autorizzazione separata.
