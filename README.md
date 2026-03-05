# Flight Scraper

A TypeScript + Playwright CLI script that searches Google Flights for round-trip flights from **Austin, TX (AUS)** to **New York City (JFK)** for **March 15–20, 2026**, extracts the top 3 deals under $300, and saves results to a local CSV.

Built as a direct comparison to the same task performed by [Airtop](https://www.airtop.ai/).

## Requirements

- Node.js 18+
- npm

## Setup

```bash
npm install
npx playwright install chromium
```

## Run

```bash
npm start
```

A real Chromium window opens so you can watch the automation live. Results are printed to the console and saved to `flights.csv` in the project root.

## Output

**Console:**
```
1. Delta Air Lines | $249 | 6:00 AM – 12:30 PM | 4 hr 30 min
2. American Airlines | $271 | 9:15 AM – 3:45 PM | 4 hr 30 min
3. United Airlines | $289 | 11:00 AM – 5:25 PM | 4 hr 25 min

Saved 3 flights to: /path/to/flight-scraper/flights.csv
```

**`flights.csv`:**
```
rank,airline,price,departure,arrival,duration
1,"Delta Air Lines",249,"6:00 AM","12:30 PM","4 hr 30 min"
2,"American Airlines",271,"9:15 AM","3:45 PM","4 hr 30 min"
3,"United Airlines",289,"11:00 AM","5:25 PM","4 hr 25 min"
```

If no flights are found under $300, the script falls back to the 3 cheapest available fares. On any unhandled error a `screenshot.png` is saved to the project root for debugging.

## How it works

| Step | What happens |
|------|-------------|
| 1 | Launch Chromium (headed) with anti-detection flags |
| 2 | Navigate to `google.com/travel/flights` |
| 3 | Dismiss cookie/consent dialog if present |
| 4 | Fill origin → Austin (AUS) |
| 5 | Fill destination → New York (JFK) |
| 6 | Confirm round-trip, set Mar 15 depart / Mar 20 return |
| 7 | Submit search, wait up to 25 s for result cards |
| 8 | Extract airline, price, times, duration from each card |
| 9 | Filter < $300, sort by price, take top 3 |
| 10 | Print to console + write `flights.csv` |

### Anti-detection measures

- Realistic macOS/Chrome user-agent string
- `--disable-blink-features=AutomationControlled` launch arg
- Short delays (0.8–2 s) between form interactions

## Project structure

```
flight-scraper/
  src/
    scrape.ts       # all scraping logic
  package.json
  tsconfig.json
  .gitignore
  README.md
```

## Google Sheets output

The script attempts to write results to a new Google Sheet in your Drive after each run. This requires a one-time OAuth setup — see [SETUP.md](SETUP.md) for instructions.

> **Note:** Getting the Google Sheets integration fully working required non-trivial OAuth setup (creating a Google Cloud project, enabling APIs, configuring an OAuth consent screen, and downloading credentials). If you just want the flight data, `flights.csv` is written locally without any auth. Expect to spend time on the Sheets setup if you want that output.

## Stack

- [Playwright](https://playwright.dev/) — browser automation
- [tsx](https://github.com/privatenumber/tsx) — zero-config TypeScript runner
- TypeScript 5, Node 18+
