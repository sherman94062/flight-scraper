import { chromium, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const ORIGIN_QUERY = 'Austin';
const ORIGIN_CODE = 'AUS';
const DESTINATION_QUERY = 'New York';
const DESTINATION_CODE = 'JFK';
const PRICE_LIMIT = 300;

interface Flight {
  airline: string;
  price: number;
  departure: string;
  arrival: string;
  duration: string;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ── Consent dialog ──────────────────────────────────────────────────────────

async function dismissConsentDialog(page: Page) {
  for (const sel of [
    'button[aria-label="Accept all"]',
    'button:has-text("Accept all")',
    'button:has-text("I agree")',
  ]) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        console.log('Dismissed consent dialog');
        await delay(1000);
        return;
      }
    } catch { /* not found */ }
  }
}

// ── Airport field ────────────────────────────────────────────────────────────

async function fillAirportField(page: Page, placeholder: string, query: string, code: string) {
  console.log(`Filling "${placeholder}" → "${query}" (${code})…`);

  // Close any open calendar / dialog first
  await page.keyboard.press('Escape').catch(() => {});
  await delay(400);

  // Find the input
  let input = null;
  for (const sel of [
    `input[placeholder*="${placeholder}" i]`,
    `[aria-label*="${placeholder}" i] input`,
    `[data-placeholder*="${placeholder}" i] input`,
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) { input = el; break; }
    } catch { /* try next */ }
  }
  if (!input) throw new Error(`Input not found for "${placeholder}"`);

  // Select-all then type so any existing value is replaced
  await input.click({ clickCount: 3 });
  await delay(200);
  await input.pressSequentially(query, { delay: 60 });
  await delay(1200);

  // Wait for a VISIBLE option that contains the airport code
  const option = page.locator('[role="option"]').filter({ hasText: code }).first();
  try {
    await option.waitFor({ state: 'visible', timeout: 8000 });
    await option.click();
    console.log(`  ✓ Selected ${code}`);
  } catch {
    console.log(`  ⚠ Dropdown not seen — pressing ArrowDown + Enter`);
    await page.keyboard.press('ArrowDown');
    await delay(300);
    await page.keyboard.press('Enter');
  }

  await delay(700);

  // Dismiss any calendar that auto-opens after airport selection
  const dialogOpen = await page.locator('[role="dialog"]').isVisible().catch(() => false);
  if (dialogOpen) {
    console.log('  → Calendar opened; pressing Escape');
    await page.keyboard.press('Escape');
    await delay(400);
  }
}

// ── Date picker ──────────────────────────────────────────────────────────────

async function clickCalendarDay(page: Page, ariaLabel: string, isoDate: string) {
  for (const sel of [
    `[aria-label="${ariaLabel}"]`,
    `[aria-label*="${ariaLabel}"]`,
    `[data-iso="${isoDate}"]`,
    `td[data-date="${isoDate}"]`,
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 })) {
        await el.click();
        console.log(`  ✓ Clicked ${ariaLabel}`);
        return;
      }
    } catch { /* try next */ }
  }
  throw new Error(`Could not click calendar date: ${ariaLabel}`);
}

async function ensureMonthVisible(page: Page, monthText: string) {
  for (let i = 0; i < 12; i++) {
    const dialogText = await page.locator('[role="dialog"]').innerText().catch(() => '');
    if (dialogText.includes(monthText)) return;
    const next = page.locator('[aria-label*="Next month" i]').first();
    await next.click({ timeout: 3000 });
    await delay(400);
  }
}

async function handleDatePicker(page: Page) {
  console.log('Setting departure date (March 15) and return date (March 20)…');

  // Open the departure date field
  for (const sel of [
    '[aria-label*="Departure" i]',
    '[placeholder*="Departure" i]',
    'input[aria-label*="Depart" i]',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click();
        await delay(800);
        break;
      }
    } catch { /* try next */ }
  }

  // Ensure March 2026 is visible
  await ensureMonthVisible(page, 'March');

  // Click departure: March 15, 2026
  await clickCalendarDay(page, 'March 15, 2026', '2026-03-15');
  await delay(500);

  // After selecting departure the calendar stays open for return date
  // Ensure March is still visible (may have scrolled)
  await ensureMonthVisible(page, 'March');

  // Click return: March 20, 2026
  await clickCalendarDay(page, 'March 20, 2026', '2026-03-20');
  await delay(500);

  // Click Done to confirm dates
  try {
    const done = page.locator('button:has-text("Done"), [aria-label*="Done" i]').first();
    if (await done.isVisible({ timeout: 3000 })) {
      await done.click();
      console.log('  ✓ Clicked Done');
      await delay(500);
    }
  } catch { /* no Done button needed */ }
}

// ── Result extraction ────────────────────────────────────────────────────────

async function extractFlights(page: Page): Promise<Flight[]> {
  console.log('Extracting results…');

  let cards = null;
  for (const sel of ['[role="listitem"]', 'li[jsmodel]', '.pIav2d']) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    if (n > 2) { console.log(`  Using selector: ${sel} (${n} items)`); cards = loc; break; }
  }
  if (!cards) { console.warn('No result cards found'); return []; }

  const flights: Flight[] = [];
  const count = await cards.count();
  for (let i = 0; i < Math.min(count, 25); i++) {
    const text = await cards.nth(i).innerText().catch(() => '');
    if (!text.trim()) continue;

    const priceMatch = text.match(/\$(\d[\d,]+)/);
    if (!priceMatch) continue;
    const price = parseInt(priceMatch[1].replace(',', ''), 10);
    if (isNaN(price) || price < 50 || price > 10_000) continue;

    const timeMatch = text.match(/(\d{1,2}:\d{2}\s*[AP]M)\s*[–\-]\s*(\d{1,2}:\d{2}\s*[AP]M)/i);
    const departure = timeMatch?.[1] ?? 'N/A';
    const arrival   = timeMatch?.[2] ?? 'N/A';

    const durationMatch = text.match(/(\d+\s*hr(?:\s*\d+\s*min)?)/i);
    const duration = durationMatch?.[1] ?? 'N/A';

    const airline = text.split('\n')
      .map(l => l.trim())
      .find(l =>
        l.length > 2 && l.length < 60 &&
        !l.startsWith('$') && !l.match(/\d:\d{2}/) &&
        !l.match(/\d+\s*hr/i) && !l.match(/nonstop|stop/i) &&
        !l.match(/^\d+$/)
      ) ?? 'Unknown';

    flights.push({ airline, price, departure, arrival, duration });
  }
  return flights;
}

// ── CSV ──────────────────────────────────────────────────────────────────────

function saveCSV(flights: Flight[], filePath: string) {
  const rows = flights.map((f, i) =>
    `${i + 1},"${f.airline}",${f.price},"${f.departure}","${f.arrival}","${f.duration}"`
  );
  fs.writeFileSync(filePath,
    'rank,airline,price,departure,arrival,duration\n' + rows.join('\n') + '\n',
    'utf8'
  );
  console.log(`Saved to: ${filePath}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

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
    console.log('Navigating to Google Flights…');
    await page.goto('https://www.google.com/travel/flights', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await delay(1500);

    await dismissConsentDialog(page);

    await fillAirportField(page, 'Where from', ORIGIN_QUERY, ORIGIN_CODE);
    await fillAirportField(page, 'Where to',   DESTINATION_QUERY, DESTINATION_CODE);

    await handleDatePicker(page);

    // Submit
    console.log('\nSubmitting search…');
    for (const sel of [
      'button[aria-label*="Search" i]',
      'button:has-text("Search")',
    ]) {
      try {
        const btn = page.locator(sel).last();
        if (await btn.isVisible({ timeout: 2000 })) { await btn.click(); break; }
      } catch { /* try next */ }
    }

    // Wait for results
    console.log('Waiting for flight results…');
    await page.waitForSelector('[role="listitem"], li[jsmodel]', { timeout: 25000 });
    await delay(2500);

    // Extract + rank
    const all = await extractFlights(page);
    all.sort((a, b) => a.price - b.price);
    console.log(`\nExtracted ${all.length} flights total`);

    const under300 = all.filter(f => f.price < PRICE_LIMIT);
    const top3 = (under300.length > 0 ? under300 : all).slice(0, 3);

    if (under300.length === 0 && all.length > 0) {
      console.log(`No flights under $${PRICE_LIMIT} — showing cheapest 3:`);
    } else {
      console.log(`Flights under $${PRICE_LIMIT}: ${under300.length}. Top 3:`);
    }

    console.log('\n--- Results ---');
    top3.forEach((f, i) =>
      console.log(`${i + 1}. ${f.airline} | $${f.price} | ${f.departure} – ${f.arrival} | ${f.duration}`)
    );

    if (top3.length > 0) saveCSV(top3, path.join(process.cwd(), 'flights.csv'));
    else console.log('No results to save.');

  } catch (err) {
    console.error('\nError:', err);
    const p = path.join(process.cwd(), 'screenshot.png');
    await page.screenshot({ path: p, fullPage: true });
    console.log(`Screenshot: ${p}`);
  } finally {
    await delay(3000);
    await browser.close();
  }
}

main();
