# Ambulatorio · èpaca Coldiretti – Apulia Diagnostic

Applicazione web responsive (desktop, tablet, smartphone) per gestire richieste, documenti e appuntamenti ambulatoriali, con sincronizzazione in tempo reale tra tutti gli utenti.

## Avvio rapido

Serve Node.js 22.13 o successivo.

```bash
npm install
npm run build
npm start
```

Apri `http://localhost:3000`. Al primo avvio viene creato l'account del Capo: utente `capo`, password stampata nel log (oppure quella impostata in `ADMIN_PASSWORD`). Al primo accesso il sistema chiede di cambiarla.

Per lo sviluppo: `npm run dev` (server) e in un altro terminale `npm run dev:web` (interfaccia con ricarica automatica su `http://localhost:5173`).

### Logo
Il logo si carica da **Amministrazione → Impostazioni → Carica nuovo logo** (PNG/JPG/WEBP/SVG). In alternativa puoi copiarlo in `branding/logo.png`. Finché non lo carichi viene mostrato un segnaposto.

## Funzioni

| Area | Cosa fa |
|---|---|
| Benvenuto | Logo, le due regole, pulsante **Entra** |
| Richieste | Titolo, descrizione, cliente, data, stato, allegati, autore. Ogni inserimento o modifica resta in **BOZZA** visibile solo all'autore fino a **Pubblica** |
| Ambulatorio | Calendario settimanale lunedì–sabato, settimana precedente/successiva, **Oggi**, vista calendario o tabella, filtri per medico, operatrice e documenti controllati. Stessa logica bozza → Pubblica |
| Archivio | Tutto il pubblicato e i calendari settimanali, ricerca per testo, cliente, medico, operatore e date, cronologia delle versioni con autore, data e ora. Solo il Capo può eliminare (con conferma) |
| Amministrazione | Utenti (crea, modifica, disattiva), medici, interruttore **IA attiva / IA disattivata** con assistente, esportazione Excel settimanale e mensile, registro attività, logo |

**Blocchi del Capo.** Il Capo può bloccare e sbloccare una singola richiesta, un singolo appuntamento o un'intera settimana. Gli operatori vedono il badge rosso con lucchetto **BLOCCATO DAL CAPO** e l'elemento in sola lettura. Se un operatore lo sta modificando proprio in quel momento, la modifica viene interrotta e compare l'avviso. Il server rifiuta comunque qualsiasi modifica (HTTP 423). Il Capo può sempre modificare anche gli elementi bloccati.

**Esportazione Excel.** I file si chiamano `Ambulatorio_Settimana_2026-W45.xlsx` e `Ambulatorio_Novembre_2026.xlsx`. Le intestazioni sono formattate in giallo, i filtri sono attivi e la prima riga è bloccata. Si esportano solo gli appuntamenti pubblicati.

**Intelligenza artificiale (Anthropic Claude).** Con l'IA attiva il Capo può riassumere una richiesta e i suoi allegati (PDF, immagini, testo), fare domande in linguaggio naturale sull'archivio, cercare conflitti tra appuntamenti (stesso medico, stesso orario) e generare il riepilogo della settimana o del mese. Con l'IA disattivata le funzioni spariscono dall'interfaccia e il server rifiuta ogni chiamata: nessun dato esce. Per usarla serve la variabile `ANTHROPIC_API_KEY` sul server.

## Archivio su Google Drive dell'amministratore

L'archivio viene copiato automaticamente nel Google Drive del Capo, nella cartella **Ambulatorio – Archivio**, pochi secondi dopo ogni modifica e comunque ogni 10 minuti:

```
Ambulatorio – Archivio/
  Database (backup)/      ambulatorio.db (sempre aggiornato) + ambulatorio_AAAA-MM-GG.db (una al giorno, 30 giorni)
  Allegati/               "Richiesta 12 - referto.pdf" … (solo richieste pubblicate)
  Calendari settimanali/  Ambulatorio_Settimana_2026-W45.xlsx …
  Calendari mensili/      Ambulatorio_Novembre_2026.xlsx …
  Richieste/              Registro_richieste.xlsx
```

Un file viene ricaricato solo se è cambiato. Il file si aggiorna dove si trova, senza creare doppioni, e un calendario eliminato dall'app sparisce anche dal Drive. Le bozze non pubblicate non vengono mai copiate. L'app usa il permesso `drive.file`, quindi vede soltanto i file che crea lei e non il resto del Drive.

### Configurazione (una sola volta, circa 10 minuti)
1. Vai su [console.cloud.google.com](https://console.cloud.google.com) con l'account Google del Capo e crea un progetto (es. "Ambulatorio").
2. **API e servizi → Libreria**: abilita **Google Drive API**.
3. **API e servizi → Schermata di consenso OAuth**: tipo *Esterno* (o *Interno* con Google Workspace). Inserisci nome app ed email, poi tra gli *Utenti di test* aggiungi l'email del Capo. Pubblica l'app ("In produzione"): in modalità *Test* l'autorizzazione scade dopo 7 giorni.
4. **API e servizi → Credenziali → Crea credenziali → ID client OAuth**, tipo *Applicazione web*. Come **URI di reindirizzamento autorizzato** inserisci `https://IL-TUO-DOMINIO/api/drive/callback`.
5. Imposta sul server `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `PUBLIC_URL=https://IL-TUO-DOMINIO`, poi riavvia.
6. Nell'app: **Amministrazione → Archivio Google Drive → Collega il Google Drive dell'amministratore** e accedi con l'account del Capo.

### Ripristino automatico
Se l'app gira su un servizio senza disco permanente, nella stessa scheda premi **Mostra il codice** e copialo nella variabile `GOOGLE_REFRESH_TOKEN`. A ogni avvio con database assente, l'app scarica l'ultima copia `ambulatorio.db` dal Drive. Gli allegati vengono riscaricati la prima volta che servono. Se il ripristino fallisce, la sincronizzazione si sospende per non sovrascrivere l'archivio sul Drive.

> Privacy: si tratta di dati sanitari. È preferibile un account **Google Workspace** con accordo sul trattamento dei dati (DPA) anziché un Gmail personale, e la verifica degli adempimenti GDPR con il proprio responsabile.

## Architettura

- **Server**: Node.js con Express. Database SQLite persistente (`data/ambulatorio.db`, modalità WAL), allegati in `data/uploads/`.
- **Tempo reale**: Server-Sent Events (`/api/events`). Ogni pubblicazione, blocco o eliminazione arriva subito a tutti i client, senza ricaricare. Le bozze vengono notificate solo al loro autore.
- **Client**: React, compilato con Vite in `dist/`, servito dallo stesso server.
- **Permessi lato server**: ogni rotta verifica sessione e ruolo. Bozze, blocchi, esportazione, IA, registro e cancellazioni sono controllati nel backend, non solo nell'interfaccia.

## Sicurezza (dati sanitari)

- Accesso solo autenticato: senza login non è visibile alcun dato, ad eccezione del logo e della pagina di benvenuto.
- Password cifrate con scrypt, minimo 10 caratteri con lettere e numeri, cambio obbligatorio al primo accesso.
- La sessione è un cookie `HttpOnly` + `SameSite=Strict` (`Secure` in HTTPS). Scade dopo 2 ore di inattività, comunque al massimo dopo 12 ore. La sessione viene chiusa subito se l'account viene disattivato.
- Protezione CSRF, limite ai tentativi di accesso falliti e header di sicurezza con Helmet (CSP, HSTS in HTTPS).
- Registro attività: accessi, bozze, pubblicazioni, blocchi, eliminazioni, esportazioni e uso dell'IA, con utente, data, ora e IP.

### HTTPS in produzione
Scegli una delle due strade:
1. **Reverse proxy** (consigliato: Caddy, nginx o una piattaforma come Render o Railway) che termina TLS. Imposta `TRUST_PROXY=true FORCE_HTTPS=true COOKIE_SECURE=true`. Con nginx disattiva il buffering su `/api/events` (l'header `X-Accel-Buffering: no` è già inviato).
2. **Certificati diretti**: `TLS_CERT_FILE` e `TLS_KEY_FILE`.

### Backup
Basta copiare la cartella `data/` (database e allegati). Con il server in funzione usa `sqlite3 data/ambulatorio.db ".backup backup.db"`.

## Docker

```bash
docker build -t ambulatorio .
```

```bash
docker run -d -p 3000:3000 -v ambulatorio-data:/data -e ADMIN_PASSWORD=... -e ANTHROPIC_API_KEY=... ambulatorio
```

Le altre variabili sono descritte in `.env.example`.
