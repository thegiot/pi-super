# Assistente per chat e invio diretto

## Flusso approvato

In «Modello e privacy» si scelgono motore, provider e modello per la conversazione. Flash è il predefinito. Pi usa le credenziali e i modelli configurati sul server. Hermes usa il profilo `chatassistant`, nel quale il proprietario può collegare in seguito knowledge base e MCP. Il pannello mostra la selezione e identifica il motore usato per ogni risposta.

Le domande libere usano la modalità automatica. Una richiesta esplicita come «Scrivigli un messaggio in inglese» può produrre una bozza che arriva nel campo della chat. Una domanda informativa produce una risposta nel pannello. I suggerimenti informativi mantengono la modalità `answer`, che scarta eventuali campi bozza. L'intento omesso dall'API conserva il precedente valore `answer`.

Una bozza sostituisce automaticamente un campo vuoto. Con testo già presente, il proprietario sceglie «Sostituire» oppure «Accodare». Una modifica del campo o un cambio chat durante la richiesta impedisce che una risposta tardiva sovrascriva il nuovo lavoro.

Invio spedisce il testo presente nel campo. Maiusc+Invio inserisce una nuova riga. La composizione IME e la ripetizione del tasto mantengono il testo nel campo. Il pulsante «Invia» usa lo stesso percorso. «Rivedi» rimane disponibile per aprire la revisione facoltativa. L'esito usa le indicazioni e i controlli dell'outbox esistente.

## Scelte d'integrazione

Le selezioni vengono salvate sul server per ID chat, con provider e modello, in un file con permessi `0600`. Il catalogo espone identificatori e nomi dei modelli configurati. Le credenziali vengono risolte dai runtime sul server. Le esclusioni privacy valgono prima della costruzione del contesto e prima della consegna della risposta, per tutti i motori.

Pi viene usato per richieste con il provider e modello selezionati. Hermes aggiunge memoria, skill e MCP del profilo e salva le proprie sessioni. Il testo dell'inbox può quindi entrare nelle sessioni e nei log di Hermes quando il proprietario sceglie tale modalità. La knowledge base viene gestita dal profilo Hermes.

Per conservare l'invio tramite il gesto del proprietario, l'invocazione Hermes dell'inbox applica una politica degli strumenti per singola richiesta. Sono ammessi gli strumenti di lettura verificati, mentre scritture Beeper, shell, delegazione e strumenti sconosciuti vengono rifiutati. La lettura delle skill deve usare testo grezzo, senza eseguire preprocessing o installare dipendenze. Questa scelta limita gli strumenti disponibili a Hermes nell'inbox. Il profilo condiviso resta configurabile per i suoi altri utilizzi.

L'outbox mantiene la stessa identità dell'invio quando la risposta HTTP viene persa o l'esito è ancora incerto. Un successivo messaggio identico può ottenere una nuova identità dopo la consegna accertata e il passaggio completato dal campo di scrittura. Una notifica di consegna arrivata prima della risposta HTTP conserva la protezione dai duplicati durante quel passaggio.

## Verifica e distribuzione

La review indipendente ha verificato autenticazione, cataloghi, salvataggio delle scelte, invio diretto e confine degli strumenti Hermes. Sono stati corretti la gestione di una conferma HTTP persa dopo consegna via WebSocket, una dipendenza reattiva che chiudeva il pannello e il collegamento degli hook al processo effettivo Hermes.

Il browser Chromium con metriche Pixel verifica riassunto lungo, viewport da 520 px, bozza inglese nel composer con focus, scelta sostituire/accodare, selettori e un solo invio tramite Invio. Maiusc+Invio inserisce una nuova riga, mentre composizione IME e tasti ripetuti conservano il testo. Screenshot 12, 13, 23, 28, 29 e 31–33 ispezionati singolarmente.

La prova del runtime Hermes installato su K29 ha verificato hook reali, chiamate concorrenti e differite, provenienza MCP, annotazioni di lettura, rifiuto di Beeper con alias e modifica degli argomenti dopo gli hook del profilo. Le prove di policy usano un profilo sintetico temporaneo.

Le prove di invio del browser usano Beeper e modelli sintetici. Risultati finali di test e deploy seguono nel registro. L'installazione PWA e la tastiera su Android fisico restano nella card dedicata.

## Verifiche finali locali

- `npm run typecheck` PASS, incluso Bun/Svelte check con 0 errori e 0 warning.
- `timeout 300 npm test` PASS, 278/278 con nessuno skip.
- `PYTHONDONTWRITEBYTECODE=1 python3 tests/inbox-hermes-policy.py` PASS, 6/6.
- `npm run build` PASS.
- `SHOTS_PORT=18796 SHOTS_CDP_PORT=19334 CHROME_BIN=/usr/bin/chromium timeout 240 node tests/mobile-shots.mjs --inbox-only` PASS.
- Autofixer Svelte senza issue sui componenti e moduli modificati.
- Review indipendente completata senza rilievi aperti.

Catalogo del runtime K29 verificato in lettura con 74 modelli Pi su 8 provider autenticati e 11 modelli Hermes su 4 provider configurati. La compatibilità del costruttore SDK Hermes, del database sessioni e della chiusura è stata provata con un profilo sintetico e inferenza sostituita da fixture. La verifica del provider reale usa un contesto tecnico sintetico separato dalle chat.

## Registro di distribuzione

Il 17 novembre 2026 `e9cb817` è stato pubblicato su `origin/inbox-m1` e applicato con fast-forward al checkout pulito `/workspace/pi-super` su K29. Eseguiti dipendenze, typecheck/Bun check, build completa, 278 test Node sotto timeout e 6 test Python della policy, tutti PASS.

Il servizio utente `pi-super.service` è stato riavviato esplicitamente alle **21:08:22 CET** ed è `active/running`. Lo smoke su [Inbox live](https://super.thegiot.com/inbox/) ha verificato autenticazione per catalogo/settings/API/bundle/worker, catalogo con tre motori disponibili, impostazione predefinita Flash, rifiuto di scelte e intenti non validi e corrispondenza del bundle servito con quello appena costruito. Beeper e assistente risultano `ok`, con cinque account.

Una prova con contesto esclusivamente sintetico e directory di lavoro temporanea ha eseguito inferenza reale attraverso tutti e tre i motori. Flash ha usato `open.bigmodel.cn / glm-5.3-flash`, Pi `deepseek / deepseek-flash`, Hermes `zai-coding-cn / glm-5.3-flash`. Ogni risposta ha confermato il testo tecnico atteso e l'identità del motore/modello selezionato. Le prove hanno usato i runtime reali e le credenziali configurate, separatamente dalle chat. L'invocazione Hermes conserva una sessione tecnica sintetica nel proprio profilo, coerentemente con il comportamento dichiarato in interfaccia.

L'invio è stato esercitato end-to-end con Beeper sintetico nel browser. Restano da provare sulla tastiera Android fisica Invio/Maiusc+Invio e l'apertura PWA installata, già tracciati nella card dedicata.
