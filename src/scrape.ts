import { chromium, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const ORIGIN_QUERY    = 'Austin';
const ORIGIN_CODE     = 'AUS';
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
  p.screenshot({ path: path.join(cwd, `shot-${name}.png`), fullPage: false })
   .catch(() => {});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function dismissConsent(page: Page) {
  for (const t of ['Accept all', 'I agree', 'Agree']) {
    try {
      const b = page.getByRole('button', { name: new RegExp(t, 'i') }).first();
      if (await b.isVisible({ timeout: 1500 })) { await b.click(); await delay(800); return; }
    } catch { /* not found */ }
  }
}

async function closeOverlays(page: Page) {
  await page.keyboard.press('Escape').catch(() => {});
  await delay(300);
}

/** Log every input/combobox on page — helps diagnose selector issues */
async function debugInputs(page: Page) {
  const info = await page.evaluate(() => {
    const els = document.querySelectorAll('input, [role="combobox"], [role="textbox"]');
    return Array.from(els).slice(0, 20).map(el => ({
      tag:         el.tagName,
      role:        el.getAttribute('role'),
      placeholder: (el as HTMLInputElement).placeholder ?? '',
      ariaLabel:   el.getAttribute('aria-label') ?? '',
      ariaHidden:  el.getAttribute('aria-hidden') ?? '',
      visible:     (el as HTMLElement).offsetHeight > 0,
      value:       (el as HTMLInputElement).value ?? '',
    }));
  });
  console.log('\n── Page inputs ──────────────────────────────────');
  info.forEach((i, n) =>
    console.log(`  [${n}] ${i.tag} role=${i.role} placeholder="${i.placeholder}" aria-label="${i.ariaLabel}" visible=${i.visible} value="${i.value}"`)
  );
  console.log('────────────────────────────────────────────────\n');
}

// ── Airport fill ─────────────────────────────────────────────────────────────

async function fillAirport(page: Page, idx: 0 | 1, query: string, code: string) {
  console.log(`\n[Airport ${idx === 0 ? 'origin' : 'dest'}] "${query}" (${code})`);

  await closeOverlays(page);
  await delay(200);

  // Find the input — Google Flights uses comboboxes; grab by index
  // Index 0 = origin ("Where from?"), index 1 = destination ("Where to?")
  const allInputs = page.locator(
    'input[role="combobox"], [role="combobox"] input, input[placeholder*="from" i], input[placeholder*="to" i], input[aria-label*="from" i], input[aria-label*="to" i]'
  );

  // Also try the generic combobox roles
  const comboboxes = page.getByRole('combobox');

  let input =
    // first: try typed placeholder
    idx === 0
      ? page.locator('input[placeholder*="from" i], input[aria-label*="from" i]').first()
      : page.locator('input[placeholder*="to" i], input[aria-label*="to" i]').first();

  // If not visible, fall back to nth combobox
  if (!(await input.isVisible({ timeout: 1500 }).catch(() => false))) {
    const count = await comboboxes.count().catch(() => 0);
    console.log(`  Placeholder selector not found. ${count} comboboxes on page.`);
    input = comboboxes.nth(idx);
  }

  await input.click({ clickCount: 3, timeout: 6000 });
  await delay(200);
  await input.pressSequentially(query, { delay: 70 });
  await delay(1500);

  // Wait for any visible option containing the airport code
  try {
    await page.waitForFunction(
      (code: string) => {
        const opts = Array.from(document.querySelectorAll('[role="option"], [role="listitem"], li'));
        return opts.some(o => {
          const el = o as HTMLElement;
          return el.offsetParent !== null && (el.textContent ?? '').includes(code);
        });
      },
      code,
      { timeout: 7000 }
    );
    // Click the first visible option with the code
    const option = page.locator(`[role="option"]:visible, li:visible`).filter({ hasText: code }).first();
    await option.click({ timeout: 4000 });
    console.log(`  ✓ Selected ${code}`);
  } catch {
    console.log(`  ⚠ Dropdown not found — pressing ArrowDown + Enter`);
    await page.keyboard.press('ArrowDown');
    await delay(400);
    await page.keyboard.press('Enter');
  }

  await delay(700);
  await closeOverlays(page);
}

// ── Date picker ───────────────────────────────────────────────────────────────

async function openDeparturePicker(page: Page) {
  // Try common selectors for the departure date field
  for (const sel of [
    '[aria-label*="Departure" i]',
    '[placeholder*="Departure" i]',
    'input[aria-label*="Depart" i]',
    '[data-placeholder*="Depart" i]',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click();
        console.log(`  Opened date picker via ${sel}`);
        await delay(1000);
        return;
      }
    } catch { /* try next */ }
  }
  // Fallback: Tab twice from last focused element
  console.log('  ⚠ Could not find departure field; Tabbing…');
  await page.keyboard.press('Tab');
  await delay(400);
  await page.keyboard.press('Tab');
  await delay(400);
}

async function ensureMonthVisible(page: Page, monthName: string) {
  const dialog = page.locator('[role="dialog"]');
  for (let i = 0; i < 8; i++) {
    const text = await dialog.innerText().catch(async () => page.locator('body').innerText());
    if ((typeof text === 'string' ? text : await text).includes(monthName)) return;
    try {
      await page.locator('[aria-label*="Next month" i]').first().click({ timeout: 2000 });
      await delay(400);
    } catch { break; }
  }
}

async function clickDate(page: Page, label: string, iso: string) {
  // Try a series of selectors; the aria-label="March 15, 2026" is most reliable on Google Flights
  const day = parseInt(iso.split('-')[2], 10);
  for (const sel of [
    `[aria-label="${label}"]`,
    `[aria-label*="${label}"]`,
    `[data-iso="${iso}"]`,
    `td[data-date="${iso}"]`,
    `[role="button"][data-date="${iso}"]`,
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click();
        console.log(`  ✓ Clicked ${label}`);
        return;
      }
    } catch { /* try next */ }
  }

  // Fallback: find a cell in the dialog containing exactly the day number
  console.log(`  ⚠ aria-label selectors failed; falling back to cell text "${day}"`);
  const cells = page.locator('[role="dialog"] [role="gridcell"], [role="dialog"] td');
  const n = await cells.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const t = await cells.nth(i).innerText().catch(() => '');
    if (t.trim() === String(day)) {
      await cells.nth(i).click();
      console.log(`  ✓ Clicked cell with text "${day}"`);
      return;
    }
  }
  throw new Error(`Cannot click date: ${label}`);
}

async function handleDates(page: Page) {
  console.log('\n[Dates] Opening picker…');
  await openDeparturePicker(page);
  await shot('3-datepicker', page);

  await ensureMonthVisible(page, 'March');

  console.log('  Setting departure → March 15');
  await clickDate(page, 'March 15, 2026', '2026-03-15');
  await delay(500);

  await ensureMonthVisible(page, 'March');

  console.log('  Setting return → March 20');
  await clickDate(page, 'March 20, 2026', '2026-03-20');
  await delay(500);

  try {
    const done = page.locator('button:has-text("Done"), [aria-label*="Done" i]').first();
    if (await done.isVisible({ timeout: 2000 })) { await done.click(); await delay(400); }
  } catch { /* no Done button needed */ }
}

// ── Results extraction ────────────────────────────────────────────────────────

async function extractFlights(page: Page): Promise<Flight[]> {
  const flights: Flight[] = [];
  let cards = null;

  for (const sel of ['[role="listitem"]', 'li[jsmodel]', '.pIav2d']) {
    const loc = page.locator(sel);
    const n   = await loc.count().catch(() => 0);
    if (n > 2) { console.log(`  Using selector "${sel}" — ${n} cards`); cards = loc; break; }
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

    const timeM    = text.match(/(\d{1,2}:\d{2}\s*[AP]M)\s*[–\-]\s*(\d{1,2}:\d{2}\s*[AP]M)/i);
    const durationM = text.match(/(\d+\s*hr(?:\s*\d+\s*min)?)/i);

    const airline = text.split('\n').map(l => l.trim()).find(l =>
      l.length > 2 && l.length < 60 &&
      !l.startsWith('$') && !l.match(/\d:\d{2}/) &&
      !l.match(/\d+\s*hr/i) && !l.match(/nonstop|stop/i) && !/^\d+$/.test(l)
    ) ?? 'Unknown';

    flights.push({
      airline,
      price,
      departure: timeM?.[1]    ?? 'N/A',
      arrival:   timeM?.[2]    ?? 'N/A',
      duration:  durationM?.[1] ?? 'N/A',
    });
  }
  return flights;
}

function saveCSV(flights: Flight[]) {
  const p = path.join(cwd, 'flights.csv');
  fs.writeFileSync(p,
    'rank,airline,price,departure,arrival,duration\n' +
    flights.map((f, i) =>
      `${i+1},"${f.airline}",${f.price},"${f.departure}","${f.arrival}","${f.duration}"`
    ).join('\n') + '\n',
    'utf8'
  );
  console.log(`\nSaved → ${p}`);
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
    // ── 1. Load page ────────────────────────────────────────────────────────
    console.log('[1] Navigating to Google Flights…');
    await page.goto('https://www.google.com/travel/flights', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await delay(2500);
    await shot('1-loaded', page);
    await dismissConsent(page);

    // ── 2. Debug: log all inputs so we can see what's available ─────────────
    await debugInputs(page);

    // ── 3. Fill origin ───────────────────────────────────────────────────────
    console.log('[2] Filling origin…');
    await fillAirport(page, 0, ORIGIN_QUERY, ORIGIN_CODE);
    await shot('2-origin', page);
    await debugInputs(page);   // re-check after origin fill (form may change)

    // ── 4. Fill destination ──────────────────────────────────────────────────
    console.log('[3] Filling destination…');
    await fillAirport(page, 1, DESTINATION_QUERY, DESTINATION_CODE);
    await shot('3-dest', page);

    // ── 5. Set dates ─────────────────────────────────────────────────────────
    await handleDates(page);
    await shot('4-dates', page);

    // ── 6. Search ────────────────────────────────────────────────────────────
    console.log('\n[4] Clicking Search…');
    for (const sel of ['button[aria-label*="Search" i]', 'button:has-text("Search")']) {
      try {
        const btn = page.locator(sel).last();
        if (await btn.isVisible({ timeout: 2000 })) { await btn.click(); break; }
      } catch { /* try next */ }
    }
    await delay(2000);

    // ── 7. Wait for results ──────────────────────────────────────────────────
    console.log('[5] Waiting for results (up to 25 s)…');
    await page.waitForSelector('[role="listitem"], li[jsmodel]', { timeout: 25000 });
    await delay(2500);
    await shot('5-results', page);

    // ── 8. Extract & save ────────────────────────────────────────────────────
    const all = await extractFlights(page);
    all.sort((a, b) => a.price - b.price);
    console.log(`\nExtracted ${all.length} flights total`);

    const under = all.filter(f => f.price < PRICE_LIMIT);
    const top3  = (under.length > 0 ? under : all).slice(0, 3);

    if (under.length === 0 && all.length > 0)
      console.log(`None under $${PRICE_LIMIT} — showing cheapest 3:`);

    console.log('\n--- Top Results ---');
    top3.forEach((f, i) =>
      console.log(`${i+1}. ${f.airline} | $${f.price} | ${f.departure}–${f.arrival} | ${f.duration}`)
    );

    if (top3.length > 0) saveCSV(top3);
    else console.log('No results to save.');

  } catch (err) {
    console.error('\n[ERROR]', err);
    await shot('error', page);
    console.log('Error screenshot → shot-error.png');
  } finally {
    await delay(3000);
    await browser.close();
  }
}

main();
