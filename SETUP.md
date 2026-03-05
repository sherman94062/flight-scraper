# Google Sheets Setup

One-time setup (~5 minutes). After this, every `npm start` creates a new sheet **directly in your own Google Drive** — no sharing, no email config.

---

## Step 1 — Create a Google Cloud project

1. Go to **https://console.cloud.google.com**
2. Click the project dropdown at the top → **New Project**
3. Name it anything (e.g. `flight-scraper`) → **Create**

---

## Step 2 — Enable two APIs

In your new project:

1. Go to **APIs & Services → Library**
2. Search for **Google Sheets API** → click it → **Enable**
3. Search for **Google Drive API** → click it → **Enable**

---

## Step 3 — Create OAuth credentials

1. Go to **APIs & Services → Credentials**
2. Click **Configure Consent Screen** (if prompted)
   - Choose **External** → **Create**
   - Fill in **App name** (anything) and your email → **Save and Continue** through the rest
   - On the **Test users** screen, add your Gmail address → **Save**
3. Back on the Credentials page, click **Create Credentials → OAuth client ID**
4. Application type: **Desktop app** → name it anything → **Create**
5. Click **Download JSON** on the confirmation dialog
6. Rename the downloaded file to **`credentials.json`** and put it in this project's root folder

> `credentials.json` is in `.gitignore` — it will never be committed.

---

## Step 4 — Run the scraper

```bash
npm start
```

**On the very first run only:** a browser tab opens asking you to sign in with Google and click **Allow**.
After that, a `token.json` is saved and you'll never be asked again.

The sheet appears automatically in your Google Drive titled **`Flights AUS→JFK <date>`**.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Access blocked: app is not verified" | Click **Advanced → Go to \<app\> (unsafe)** — this is your own private app |
| `credentials.json not found` | Make sure the file is in the project root (same folder as `package.json`) |
| `token.json` causes auth errors | Delete `token.json` and run again to re-authorize |
| Port 3000 already in use | Stop whatever is using port 3000, or change `3000` in `scrape.ts` and the OAuth credential redirect URI |
