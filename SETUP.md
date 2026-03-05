# Google Sheets Setup

Follow these steps once. It takes about 5 minutes.

## 1. Create a Google Cloud project

1. Go to https://console.cloud.google.com
2. Click **Select a project → New Project**, name it anything (e.g. `flight-scraper`)
3. Click **Create**

## 2. Enable the required APIs

In your new project, go to **APIs & Services → Library** and enable:

- **Google Sheets API**
- **Google Drive API**

## 3. Create a service account

1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → Service account**
3. Name it anything (e.g. `flight-scraper-sa`), click **Done**
4. Click the service account you just created
5. Go to the **Keys** tab → **Add Key → Create new key → JSON**
6. Download the JSON file and save it as **`credentials.json`** in this project's root directory

> `credentials.json` is in `.gitignore` — it will never be committed.

## 4. Run the scraper

```bash
npm start
```

The script will:
- Create a new Google Sheet titled `Flights AUS→JFK <date>`
- Write the top 3 results with a bold header row
- Make it readable by anyone with the link
- Print the URL in the console

## 5. (Optional) Auto-share with your Google account

Set `SHEET_SHARE_EMAIL` before running so the sheet appears directly in your Drive:

```bash
SHEET_SHARE_EMAIL=you@gmail.com npm start
```

Or add it to a `.env` file and export it in your shell profile.
