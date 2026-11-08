# Ambulatorio · èpaca Coldiretti

App per gestire richieste, documenti e appuntamenti ambulatoriali, da telefono (Android e iPhone), tablet e computer, con sincronizzazione in tempo reale tra tutti gli utenti.

**Non c'è nessun server da installare o gestire:**
- **l'app** è pubblicata gratis su **GitHub Pages** e si installa come un'app (APK per Android, "Aggiungi alla schermata Home" su iPhone);
- **i dati** stanno su **Supabase**, un servizio cloud già pronto con data center in Europa. Supabase fa da archivio condiviso protetto e controlla accessi, permessi e blocchi del Capo; da lì partono anche l'email mensile e l'assistente IA.

Indirizzo dell'app: **https://atisl-2026.github.io/Ambulatorio/**

---

## 1. Installazione (una sola volta)

### A. Supabase (archivio dei dati)
1. Crea un account gratuito su [supabase.com](https://supabase.com) e premi **New project**.
   - Nome: `ambulatorio`
   - **Database password**: scegline una robusta e **annotala**
   - **Region**: `Central EU (Frankfurt)`
2. A progetto creato, copia il **Project ID** da *Project Settings → General* (una sigla tipo `abcdefghijklmnop`).
3. Crea un **token di accesso** da *Account (icona in alto a destra) → Access Tokens → Generate new token*, con nome `github`, e copialo.

### B. GitHub (pubblicazione)
1. Repository → *Settings → General → Danger Zone → Change visibility → **Public***. Serve per GitHub Pages gratuito e per scaricare l'APK: il codice diventa visibile, ma **non contiene dati**, che restano su Supabase protetti dal login.
2. *Settings → Pages → Build and deployment → Source:* **GitHub Actions**.
3. *Settings → Secrets and variables → Actions → New repository secret*: aggiungi
   | Nome | Valore |
   |---|---|
   | `SUPABASE_ACCESS_TOKEN` | il token del punto A.3 |
   | `SUPABASE_PROJECT_REF` | il Project ID del punto A.2 |
   | `SUPABASE_DB_PASSWORD` | la password del database del punto A.1 |

### C. Pubblicazione
1. Scheda **Actions** → **Pubblica l'app** → **Run workflow**. In circa 3 minuti crea il database, le funzioni cloud e il sito.
2. Scheda **Actions** → **App Android (APK)** → **Run workflow**: crea il file APK.
3. Apri **https://atisl-2026.github.io/Ambulatorio/** e premi **Entra**: alla prima apertura l'app chiede di **creare l'account del Capo**. Fallo subito, perché il primo account creato diventa amministratore.
4. Dal Capo: *Amministrazione → Utenti* per creare gli operatori, *Medici* per l'elenco dei medici, *Impostazioni* per lo stato del sistema.

Ogni modifica successiva al codice viene ripubblicata automaticamente.

---

## 2. Installare l'app sui telefoni

- **Android**: apri l'indirizzo dell'app e tocca **"Scarica l'app per Android (APK)"** nella pagina di benvenuto (oppure scaricalo da *Releases → apk*). Apri il file e consenti l'installazione. In alternativa: Chrome → menu ⋮ → **Installa app**.
- **iPhone/iPad**: apri l'indirizzo in **Safari** → **Condividi** → **Aggiungi alla schermata Home**. Apple non permette di installare un APK né app fuori dall'App Store senza un account sviluppatore a pagamento; così invece è gratuito e l'app si apre a schermo intero come le altre.

L'app si aggiorna da sola: non serve reinstallarla quando cambia.

> Nota APK: senza il file di verifica del dominio (`.well-known/assetlinks.json` nel sito `atisl-2026.github.io`) l'app Android può mostrare una sottile barra con l'indirizzo in alto. Il funzionamento è identico. L'impronta da inserire è pubblicata insieme all'APK (`impronta-sha256.txt`).

---

## 3. Email mensile del calendario (facoltativa)

Il **giorno 1 di ogni mese**, dalle 7, Supabase invia per email il calendario Excel del mese appena concluso (es. `Ambulatorio_Ottobre_2026.xlsx`, pochi KB), anche se nessuno ha l'app aperta. Il Capo può anche inviarlo a mano in qualsiasi momento.

1. Aggiungi in GitHub (*Settings → Secrets → Actions*) i dati della casella di posta dell'ufficio:

   | Nome | Esempio |
   |---|---|
   | `SMTP_HOST` | `smtps.aruba.it` · `smtp.libero.it` · `smtp.gmail.com` |
   | `SMTP_PORT` | `465` |
   | `SMTP_USER` | `ufficio@vostrodominio.it` |
   | `SMTP_PASS` | password della casella (per Gmail una "password per le app") |
   | `MAIL_FROM` | facoltativo, es. `Ambulatorio <ufficio@vostrodominio.it>` |

   Usa la **porta 465 (SSL)**: Supabase blocca le porte 25 e 587.
2. Rilancia **Actions → Pubblica l'app**.
3. Nell'app: *Amministrazione → Backup e invio email* → indirizzo di destinazione → **Invio mensile attivo** → **Salva**.

## 4. Intelligenza artificiale (facoltativa)

Aggiungi il segreto `ANTHROPIC_API_KEY` (chiave da [console.anthropic.com](https://console.anthropic.com)) e rilancia la pubblicazione. Poi il Capo usa l'interruttore **IA attiva / IA disattivata** in *Amministrazione → Intelligenza artificiale*.

Con l'IA disattivata le funzioni spariscono e nessun dato viene inviato.

---

## 5. Cosa fa l'app

| Area | Funzioni |
|---|---|
| Benvenuto | Logo, le due regole, pulsante **Entra** |
| Richieste | Titolo, descrizione, cliente, data, stato, allegati, autore. Ogni inserimento o modifica resta in **BOZZA**, visibile solo all'autore, finché non preme **Pubblica**; poi compare a tutti in tempo reale |
| Ambulatorio | Calendario lunedì–sabato con settimana precedente/successiva e **Oggi**; vista calendario o tabella; filtri per medico, operatrice e documenti controllati; stessa logica bozza → Pubblica |
| Archivio | Tutto il pubblicato e i calendari settimanali; ricerca per testo, cliente, medico, operatore e date; cronologia delle versioni con autore, data e ora; eliminazione definitiva solo per il Capo, con conferma |
| Amministrazione | Utenti (crea, modifica, disattiva), medici, IA, esportazione Excel settimanale e mensile, invio email mensile, backup e ripristino, registro attività, logo |

**Blocchi del Capo:** il Capo può bloccare una richiesta, un appuntamento o un'intera settimana. Gli operatori vedono il badge rosso **BLOCCATO DAL CAPO** e l'elemento in sola lettura. Chi lo sta modificando in quel momento viene interrotto con l'avviso. Il database rifiuta comunque ogni modifica, anche da un'app manomessa. Il Capo può sempre modificare.

---

## 6. Sicurezza e dati

- **Accesso solo con utente e password.** Senza login non si vede alcun dato. Le registrazioni libere sono disattivate: gli account li crea il Capo.
- **Permessi applicati dal database:** bozze private, blocchi, ruoli, eliminazioni ed esportazioni sono controllati da Supabase su ogni operazione.
- **Allegati privati:** sono scaricabili solo da chi può vedere la richiesta, con link temporanei.
- **Registro attività:** registra accessi, bozze, pubblicazioni, blocchi, eliminazioni, esportazioni, email e uso dell'IA, con utente, data e ora.
- **Sessione:** uscita automatica dopo 2 ore di inattività. Un utente disattivato perde subito l'accesso.
- **Dati in Europa** (Francoforte). Per il GDPR, Supabase offre il proprio accordo sul trattamento dei dati (DPA), da accettare dalla dashboard (*Organization → Legal Documents*).

**Backup:** in *Amministrazione → Backup e invio email* il Capo scarica un file .zip con tutto l'archivio, e può ripristinarlo dallo stesso punto. Conviene farlo periodicamente: il piano gratuito di Supabase non include backup scaricabili.

**Piano gratuito di Supabase:** se un progetto gratuito resta **inutilizzato per circa una settimana**, Supabase lo mette in pausa; i dati non si perdono e si riattiva con un clic dalla dashboard. Con l'uso quotidiano in ufficio non succede. Il piano Pro (circa 25 $/mese) elimina la pausa e aggiunge i backup giornalieri automatici.

---

## 7. Per sviluppatori

```bash
npm install
npx supabase start          # Supabase completo in locale (serve Docker)
npm run dev                 # app su http://localhost:5173 (usa Supabase locale)
```

Test del backend (permessi, bozze, blocchi, tempo reale, allegati, email, backup), con Supabase locale avviato:

```bash
npx supabase db reset
SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… npm run test:backend
```

Le chiavi si leggono con `npx supabase status`.

Struttura:
- `src/` app React (PWA)
- `supabase/migrations/` database, regole e permessi
- `supabase/functions/` funzioni cloud: `admin-users`, `ai`, `monthly-email`
- `android/` APK (Trusted Web Activity)
- `.github/workflows/` pubblicazione automatica
