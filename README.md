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
| Amministrazione | Utenti (crea, modifica, disattiva), medici, interruttore **IA attiva / IA disattivata** con assistente, esportazione Excel settimanale e mensile, invio mensile automatico del calendario per email, backup e ripristino, registro attività, logo |

**Blocchi del Capo.** Il Capo può bloccare e sbloccare una singola richiesta, un singolo appuntamento o un'intera settimana. Gli operatori vedono il badge rosso con lucchetto **BLOCCATO DAL CAPO** e l'elemento in sola lettura. Se un operatore lo sta modificando proprio in quel momento, la modifica viene interrotta e compare l'avviso. Il server rifiuta comunque qualsiasi modifica (HTTP 423). Il Capo può sempre modificare anche gli elementi bloccati.

**Esportazione Excel.** I file si chiamano `Ambulatorio_Settimana_2026-W45.xlsx` e `Ambulatorio_Novembre_2026.xlsx`. Le intestazioni sono formattate in giallo, i filtri sono attivi e la prima riga è bloccata. Si esportano solo gli appuntamenti pubblicati.

**Intelligenza artificiale (Anthropic Claude).** Con l'IA attiva il Capo può riassumere una richiesta e i suoi allegati (PDF, immagini, testo), fare domande in linguaggio naturale sull'archivio, cercare conflitti tra appuntamenti (stesso medico, stesso orario) e generare il riepilogo della settimana o del mese. Con l'IA disattivata le funzioni spariscono dall'interfaccia e il server rifiuta ogni chiamata: nessun dato esce. Per usarla serve la variabile `ANTHROPIC_API_KEY` sul server.

## Invio mensile del calendario per email

Il **giorno 1 di ogni mese**, dalle ore 7, l'app invia per email il calendario Excel del mese appena concluso (es. `Ambulatorio_Ottobre_2026.xlsx`, di pochi KB) agli indirizzi impostati dal Capo in **Amministrazione → Backup e invio email**. Se quel giorno il server è spento, l'invio parte appena riparte. Se l'invio fallisce, l'app riprova ogni ora e mostra l'errore nella stessa schermata.

Il Capo può anche inviare a mano il calendario di qualsiasi mese, in due modi: con **Invia ora** nella stessa schermata, oppure con **Invia mese per email** nella pagina Ambulatorio. Ogni invio finisce nel registro attività.

L'email parte dalla **casella di posta dell'ufficio** (SMTP), senza altri servizi esterni. Imposta sul server:

```
SMTP_HOST=smtps.aruba.it     # server di posta in uscita del vostro provider
SMTP_PORT=465                # 465 (SSL) oppure 587 (STARTTLS)
SMTP_USER=ufficio@vostrodominio.it
SMTP_PASS=la-password-della-casella
MAIL_FROM="Ambulatorio <ufficio@vostrodominio.it>"   # facoltativo
```

Esempi di server in uscita: Aruba `smtps.aruba.it:465`, Libero `smtp.libero.it:465`, Outlook/Microsoft 365 `smtp.office365.com:587`, Gmail `smtp.gmail.com:465` (richiede una "password per le app").

## Backup e ripristino

In **Amministrazione → Backup e invio email**:
- **Scarica backup**: scarica un unico file `.zip` con l'intero archivio (database, allegati, logo). Conservalo in un luogo sicuro: contiene dati sanitari.
- **Ripristina da backup**: sostituisce i dati attuali con quelli del backup (va confermato scrivendo RIPRISTINA). Prima di procedere il server salva una copia di sicurezza dello stato attuale in `data/backups/`. Al termine tutti gli utenti devono accedere di nuovo.

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

### Backup manuale lato server
In alternativa al pulsante nell'app, puoi copiare la cartella `data/`, che contiene database e allegati.

## Docker

```bash
docker build -t ambulatorio .
```

```bash
docker run -d -p 3000:3000 -v ambulatorio-data:/data -e ADMIN_PASSWORD=... -e ANTHROPIC_API_KEY=... ambulatorio
```

Le altre variabili sono descritte in `.env.example`.
