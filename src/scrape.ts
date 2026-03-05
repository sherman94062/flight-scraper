import { chromium, type Page } from 'playwright';
import { google } from 'googleapis';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { exec } from 'child_process';

const ORIGIN_QUERY      = 'Austin';
const ORIGIN_CODE       = 'AUS';
const DESTINATION_QUERY = 'New York';
const DESTINATION_CODE  = 'JFK';
const PRICE_LIMIT = 300;

interface Flight {
  airline: string;
  price: number;
  departure: string;
  arrival: string;
  duration: string;
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const cwd   = process.cwd();
const shot  = (name: string, p: Page) =>
  p.screenshot({ path: path.join(cwd, `shot-${name}.png`) }).catch(() => {});

// ── Airport fill ──────────────────────────────────────────────────────────────
//
// Google Flights shows a full modal when you click an airport field:
//   <div role="dialog" aria-label="Enter your origin">
//     <input placeholder="Where from?">
//     <ul><li>Austin (AUS) …</li></ul>
//   </div>
//
// Strategy:
//  1. Click the visible input in the *closed* form
//  2. Wait for the modal to appear (aria-label="Enter your origin/destination")
//  3. Find the <li> inside that modal containing the airport code, click it
//  4. Wait for the modal to close (confirms selection)
//  5. Escape as safety net

async function fillAirport(
  page: Page,
  placeholder: string,   // "Where from?" | "Where to?"
  dialogLabel: string,   // "Enter your origin" | "Enter your destination"
  query: string,
  code: string,
) {
  console.log(`\n[Airport] "${placeholder}" → "${query}" (${code})`);

  // Escape any open modal before starting
  await page.keyboard.press('Escape').catch(() => {});
  await delay(500);

  // Wait until the target modal is NOT visible (clean state)
  await page.locator(`[aria-label="${dialogLabel}"]`)
    .waitFor({ state: 'hidden', timeout: 5000 })
    .catch(() => {/* already hidden or never existed */});

  // Click the origin/destination input in the collapsed form
  const input = page.locator(`input[placeholder="${placeholder}"]`).first();
  await input.click({ timeout: 6000 });
  await delay(400);

  // The modal should now be open
  const modal = page.locator(`[aria-label="${dialogLabel}"]`);
  await modal.waitFor({ state: 'visible', timeout: 8000 });
  console.log(`  Modal open: "${dialogLabel}"`);

  // Clear whatever is in the input and type our query
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type(query, { delay: 80 });
  await delay(2000); // let autocomplete populate

  // Find a list item inside the modal that contains the airport code
  const option = modal.locator('li').filter({ hasText: code }).first();
  try {
    await option.waitFor({ state: 'visible', timeout: 8000 });
    await option.click();
    console.log(`  ✓ Clicked option for ${code}`);
  } catch {
    // Fallback: type just the code and press Enter
    console.log(`  ⚠ Option not found — typing "${code}" directly`);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await page.keyboard.type(code, { delay: 80 });
    await delay(1000);
    const codeOption = modal.locator('li').first();
    try {
      await codeOption.waitFor({ state: 'visible', timeout: 4000 });
      await codeOption.click();
      console.log(`  ✓ Clicked first option`);
    } catch {
      await page.keyboard.press('ArrowDown');
      await delay(300);
      await page.keyboard.press('Enter');
      console.log(`  ⚠ Pressed ArrowDown+Enter`);
    }
  }

  // Wait for the modal to close — this confirms the airport was selected
  await modal.waitFor({ state: 'hidden', timeout: 8000 })
    .then(() => console.log(`  ✓ Modal closed — airport selected`))
    .catch(() => {
      console.log(`  ⚠ Modal didn't close; pressing Escape`);
      return page.keyboard.press('Escape').then(() => delay(400));
    });

  await delay(400);
}

// ── Date picker ───────────────────────────────────────────────────────────────

async function openDeparturePicker(page: Page) {
  for (const sel of [
    'input[placeholder="Departure"]',
    'input[aria-label="Departure"]',
    '[aria-label*="Departure" i]',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click();
        await delay(1000);
        console.log(`  Opened date picker via: ${sel}`);
        return;
      }
    } catch { /* try next */ }
  }
  console.log('  ⚠ Could not find Departure input');
}

async function ensureMonthVisible(page: Page, month: string) {
  const dialog = page.locator('[role="dialog"]');
  for (let i = 0; i < 8; i++) {
    const text = await dialog.innerText().catch(() => '');
    if (text.includes(month)) return;
    await page.locator('[aria-label*="Next month" i]').first().click({ timeout: 3000 }).catch(() => {});
    await delay(400);
  }
}

async function clickDate(page: Page, ariaLabel: string, iso: string) {
  console.log(`  Clicking ${ariaLabel} (${iso})…`);

  // data-iso is confirmed to exist on Google Flights calendar cells.
  // Try scrolling it into view first, then a normal click.
  const el = page.locator(`[data-iso="${iso}"]`).first();
  try {
    await el.scrollIntoViewIfNeeded({ timeout: 4000 });
    await delay(300);
    await el.click({ timeout: 5000 });
    console.log(`  ✓ Clicked via data-iso`);
    return;
  } catch { /* fall through to JS click */ }

  // JS click bypasses Playwright's visibility check — works even if the
  // cell is technically off-screen or partially obscured.
  const clicked = await page.evaluate((iso: string) => {
    const el = document.querySelector(`[data-iso="${iso}"]`);
    if (!el) return false;
    (el as HTMLElement).click();
    return true;
  }, iso);

  if (clicked) {
    console.log(`  ✓ Clicked via JS evaluate`);
    return;
  }

  throw new Error(`Could not click date: ${ariaLabel} (${iso})`);
}

async function dismissDatePicker(page: Page) {
  // 1. Wait up to 5 s for "Done" button to become clickable, then click it
  try {
    const done = page.getByRole('button', { name: /^done$/i });
    await done.waitFor({ state: 'visible', timeout: 5000 });
    await done.click();
    console.log('  ✓ Dismissed via Done button');
    await delay(600);
    return;
  } catch { /* fall through */ }

  // 2. Escape key
  await page.keyboard.press('Escape');
  await delay(500);
  const stillOpen = await page.locator('[role="dialog"]').isVisible().catch(() => false);
  if (!stillOpen) { console.log('  ✓ Dismissed via Escape'); return; }

  // 3. Click somewhere neutral outside the calendar
  await page.mouse.click(640, 30);
  await delay(500);
  console.log('  ✓ Dismissed via outside click');
}

async function handleDates(page: Page) {
  console.log('\n[Dates] Opening departure picker…');
  await openDeparturePicker(page);
  await shot('4-datepicker', page);
  await ensureMonthVisible(page, 'March');

  await clickDate(page, 'March 15, 2026', '2026-03-15');
  await delay(800);
  await shot('4b-depart-selected', page);

  await ensureMonthVisible(page, 'March');
  await clickDate(page, 'March 20, 2026', '2026-03-20');
  await delay(800);
  await shot('4c-return-selected', page);

  await dismissDatePicker(page);
  await shot('4d-picker-dismissed', page);
}

// ── Result extraction ─────────────────────────────────────────────────────────

async function extractFlights(page: Page): Promise<Flight[]> {
  const flights: Flight[] = [];
  let cards = null;
  for (const sel of ['[role="listitem"]', 'li[jsmodel]', '.pIav2d']) {
    const loc = page.locator(sel);
    const n   = await loc.count().catch(() => 0);
    if (n > 2) { console.log(`  Using "${sel}" (${n} items)`); cards = loc; break; }
  }
  if (!cards) { console.warn('  No result cards found'); return []; }

  const total = await cards.count();
  for (let i = 0; i < Math.min(total, 25); i++) {
    const text = await cards.nth(i).innerText().catch(() => '');
    if (!text.trim()) continue;
    const priceM = text.match(/\$(\d[\d,]+)/);
    if (!priceM) continue;
    const price = parseInt(priceM[1].replace(',', ''), 10);
    if (isNaN(price) || price < 50 || price > 10_000) continue;
    const timeM     = text.match(/(\d{1,2}:\d{2}\s*[AP]M)\s*[–\-]\s*(\d{1,2}:\d{2}\s*[AP]M)/i);
    const durationM = text.match(/(\d+\s*hr(?:\s*\d+\s*min)?)/i);
    const airline   = text.split('\n').map(l => l.trim()).find(l =>
      l.length > 2 && l.length < 60 &&
      !l.startsWith('$') && !l.match(/\d:\d{2}/) &&
      !l.match(/\d+\s*hr/i) && !l.match(/nonstop|stop/i) && !/^\d+$/.test(l)
    ) ?? 'Unknown';
    flights.push({
      airline,
      price,
      departure: timeM?.[1]     ?? 'N/A',
      arrival:   timeM?.[2]     ?? 'N/A',
      duration:  durationM?.[1] ?? 'N/A',
    });
  }
  return flights;
}

// ── Google Sheets ─────────────────────────────────────────────────────────────

// ── Google OAuth helpers ──────────────────────────────────────────────────────

const CREDS_PATH   = path.join(cwd, 'credentials.json');
const TOKEN_PATH   = path.join(cwd, 'token.json');
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

/** Open a URL in the default macOS/Linux/Windows browser */
function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? `start ""  "${url}"`
            : process.platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd);
}

/**
 * Returns an authenticated OAuth2 client.
 * • First run  → browser opens, user clicks Allow, token saved to token.json
 * • Later runs → uses saved token (auto-refreshes if expired)
 */
async function getOAuthClient(): Promise<InstanceType<typeof google.auth.OAuth2> | null> {
  if (!fs.existsSync(CREDS_PATH)) {
    console.log('\n[Sheets] credentials.json not found — skipping. See SETUP.md.');
    return null;
  }

  const raw   = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  const creds = raw.installed ?? raw.web;
  if (!creds?.client_id) {
    console.log('\n[Sheets] credentials.json looks wrong — expected an "installed" OAuth key. See SETUP.md.');
    return null;
  }

  const client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    'http://localhost:3000',
  );

  // Re-use saved token if present
  if (fs.existsSync(TOKEN_PATH)) {
    client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
    return client;
  }

  // ── First-time authorization via loopback server ──────────────────────────
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: OAUTH_SCOPES,
    prompt: 'consent',          // ensures refresh_token is returned
  });

  // Capture the redirect code via a local HTTP server
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const qs   = new URL(req.url ?? '/', 'http://localhost:3000').searchParams;
      const code = qs.get('code');
      const err  = qs.get('error');
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>✅ Authorized! You may close this tab and return to the terminal.</h2></body></html>');
        server.close();
        resolve(code);
      } else if (err) {
        res.writeHead(400); res.end('Authorization failed: ' + err);
        server.close();
        reject(new Error('Google auth denied: ' + err));
      }
    });

    server.listen(3000, () => {
      openBrowser(authUrl);
      console.log('\n[Sheets] A browser tab just opened — click "Allow" to authorize Google Sheets access.');
      console.log('         If the browser did not open, visit:\n         ' + authUrl + '\n');
    });

    setTimeout(() => {
      server.close();
      reject(new Error('Google auth timed out after 2 minutes'));
    }, 120_000);
  });

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  console.log('  ✓ Authorized — token saved to token.json (won\'t ask again)');

  return client;
}

// ── Google Sheets writer ──────────────────────────────────────────────────────

async function writeToSheets(flights: Flight[]): Promise<string | null> {
  const client = await getOAuthClient();
  if (!client) return null;

  console.log('\n[Sheets] Creating spreadsheet in your Google Drive…');
  const sheets = google.sheets({ version: 'v4', auth: client });

  const title = `Flights AUS→JFK ${new Date().toLocaleDateString('en-US')}`;
  const { data } = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [{ properties: { title: 'Results' } }],
    },
  });

  const id  = data.spreadsheetId!;
  const url = `https://docs.google.com/spreadsheets/d/${id}`;

  const rows: (string | number)[][] = [
    ['Rank', 'Airline', 'Price ($)', 'Departure', 'Arrival', 'Duration', 'Route', 'Scraped'],
    ...flights.map((f, i) => [
      i + 1, f.airline, f.price, f.departure, f.arrival, f.duration,
      'AUS → JFK  round-trip  Mar 15–20 2026',
      new Date().toLocaleString('en-US'),
    ]),
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: 'Results!A1',
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });

  // Bold the header row
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: id,
    requestBody: {
      requests: [{
        repeatCell: {
          range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      }],
    },
  });

  return url;
}

function saveCSV(flights: Flight[]) {
  const p = path.join(cwd, 'flights.csv');
  fs.writeFileSync(p,
    'rank,airline,price,departure,arrival,duration\n' +
    flights.map((f, i) =>
      `${i+1},"${f.airline}",${f.price},"${f.departure}","${f.arrival}","${f.duration}"`
    ).join('\n') + '\n', 'utf8');
  console.log(`Saved → ${p}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });
  const page = await context.newPage();

  try {
    console.log('[1] Navigating to Google Flights…');
    await page.goto('https://www.google.com/travel/flights', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await delay(2500);
    await shot('1-loaded', page);

    // Dismiss cookie/consent
    for (const t of ['Accept all', 'I agree', 'Agree']) {
      try {
        const b = page.getByRole('button', { name: new RegExp(t, 'i') }).first();
        if (await b.isVisible({ timeout: 1500 })) { await b.click(); await delay(800); break; }
      } catch { /* not present */ }
    }

    console.log('[2] Filling origin…');
    await fillAirport(page, 'Where from?', 'Enter your origin', ORIGIN_QUERY, ORIGIN_CODE);
    await shot('2-origin', page);

    console.log('[3] Filling destination…');
    await fillAirport(page, 'Where to?', 'Enter your destination', DESTINATION_QUERY, DESTINATION_CODE);
    await shot('3-dest', page);

    await handleDates(page);
    await shot('5-dates', page);

    // ── Submit search ────────────────────────────────────────────────────────
    console.log('\n[5] Submitting search…');
    await shot('5-pre-search', page);

    let submitted = false;
    for (const sel of [
      'button[aria-label="Search"]',
      'button[aria-label*="Search" i]',
      'button:has-text("Search")',
      '[jsname="vLv7Lb"]',          // Google Flights search button jsname
    ]) {
      try {
        const btn = page.locator(sel).last();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          console.log(`  ✓ Clicked Search via: ${sel}`);
          submitted = true;
          break;
        }
      } catch { /* try next */ }
    }
    if (!submitted) {
      console.log('  ⚠ Search button not found — pressing Enter');
      await page.keyboard.press('Enter');
    }

    // Wait for URL to change, confirming the search was submitted
    await page.waitForFunction(
      () => window.location.href.includes('tfs=') || window.location.href.includes('/search'),
      { timeout: 15000 }
    ).catch(() => console.log('  ⚠ URL did not change — search may not have submitted'));

    await delay(2000);
    await shot('5-post-search', page);

    // ── Wait for results ─────────────────────────────────────────────────────
    console.log('[6] Waiting for results…');
    await page.waitForSelector('[role="listitem"], li[jsmodel]', { timeout: 35000 });
    await delay(2000);
    await shot('6-results', page);

    // ── Extract & save ───────────────────────────────────────────────────────
    const all = await extractFlights(page);
    all.sort((a, b) => a.price - b.price);
    console.log(`\nExtracted ${all.length} flights`);

    const under = all.filter(f => f.price < PRICE_LIMIT);
    const top3  = (under.length > 0 ? under : all).slice(0, 3);
    if (under.length === 0 && all.length > 0)
      console.log(`None under $${PRICE_LIMIT} — showing cheapest 3:`);

    console.log('\n--- Results ---');
    top3.forEach((f, i) =>
      console.log(`${i+1}. ${f.airline} | $${f.price} | ${f.departure}–${f.arrival} | ${f.duration}`)
    );

    if (top3.length > 0) {
      saveCSV(top3);
      const sheetUrl = await writeToSheets(top3);
      if (sheetUrl) {
        console.log(`\n✅ Results written to Google Sheet:\n   ${sheetUrl}\n`);
      }
    } else {
      console.log('No results to save.');
    }

    console.log('Done. Closing browser…');

  } catch (err) {
    console.error('\n[ERROR]', err);
    await shot('error', page);
    console.log('Screenshot → shot-error.png');
  } finally {
    await browser.close();
  }
}

main();
