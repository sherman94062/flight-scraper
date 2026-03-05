import { chromium, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const ORIGIN = 'Austin';
const ORIGIN_CODE = 'AUS';
const DESTINATION = 'New York';
const DESTINATION_CODE = 'JFK';
const DEPART_DATE = 'Mar 15';           // typed into the date picker
const DEPART_DATE_FULL = 'March 15, 2026';
const RETURN_DATE = 'Mar 20';
const RETURN_DATE_FULL = 'March 20, 2026';
const PRICE_LIMIT = 300;

interface Flight {
  airline: string;
  price: number;
  departure: string;
  arrival: string;
  duration: string;
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function dismissConsentDialog(page: Page) {
  // EU/cookie consent buttons
  const selectors = [
    'button[aria-label="Accept all"]',
    'button[aria-label="Reject all"]',
    'button:has-text("Accept all")',
    'button:has-text("I agree")',
    'button:has-text("Agree")',
  ];
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        console.log(`Dismissed consent dialog via: ${sel}`);
        await delay(1000);
        return;
      }
    } catch {
      // not found, try next
    }
  }
}

async function fillAirportField(page: Page, label: string, query: string, code: string) {
  console.log(`Filling ${label} with "${query}"…`);

  // Find the input by its placeholder or aria-label
  const inputSelectors = [
    `input[placeholder*="${label}" i]`,
    `input[aria-label*="${label}" i]`,
    `[aria-label*="${label}" i] input`,
  ];

  let input = null;
  for (const sel of inputSelectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 3000 })) {
        input = loc;
        break;
      }
    } catch { /* try next */ }
  }

  if (!input) {
    // Fall back: click the labeled container
    await page.locator(`[aria-label*="${label}" i]`).first().click();
    await delay(500);
    input = page.locator(`[aria-label*="${label}" i] input`).first();
  }

  await input.click({ clickCount: 3 });
  await input.fill(query);
  await delay(1500);

  // Wait for autocomplete dropdown, pick item matching our code
  const listbox = page.locator('[role="listbox"], [role="option"]').first();
  await listbox.waitFor({ timeout: 10000 });

  // Try to click the specific airport code
  try {
    const option = page.locator(`[role="option"]:has-text("${code}")`).first();
    await option.click({ timeout: 5000 });
  } catch {
    // Fall back: press Enter to accept first suggestion
    await input.press('Enter');
  }
  await delay(800);
}

async function setDate(page: Page, labelHint: string, dateText: string, fullDateText: string) {
  console.log(`Setting ${labelHint} date to ${fullDateText}…`);

  // Click the date input
  const dateSelectors = [
    `[aria-label*="${labelHint}" i]`,
    `input[placeholder*="${labelHint}" i]`,
  ];

  for (const sel of dateSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 })) {
        await el.click();
        await delay(800);
        break;
      }
    } catch { /* try next */ }
  }

  // The calendar should now be open; type the date or click the right day
  // Try typing into the focused date input
  const activeInput = page.locator('[role="textbox"]:focus, input:focus').first();
  try {
    await activeInput.fill(dateText, { timeout: 2000 });
    await activeInput.press('Enter');
    await delay(500);
    return;
  } catch { /* try calendar click */ }

  // Navigate calendar months and click the target date
  // Parse month/day from fullDateText e.g. "March 15, 2026"
  const match = fullDateText.match(/(\w+)\s+(\d+),\s+(\d+)/);
  if (!match) throw new Error(`Cannot parse date: ${fullDateText}`);
  const [, targetMonth, dayStr] = match;
  const targetDay = parseInt(dayStr, 10);

  // Keep clicking "Next month" until we reach the right month
  for (let attempt = 0; attempt < 6; attempt++) {
    const header = page.locator('[role="dialog"] [aria-label*="month" i], [role="dialog"] h2').first();
    const headerText = await header.textContent({ timeout: 3000 }).catch(() => '');
    if (headerText?.includes(targetMonth)) break;
    const nextBtn = page.locator('[aria-label*="Next month" i], [aria-label*="next" i]').first();
    await nextBtn.click();
    await delay(500);
  }

  // Click the day cell
  const dayCell = page.locator(`[role="gridcell"][data-day="${targetDay}"], [role="gridcell"]:has-text("${targetDay}")`).first();
  await dayCell.click({ timeout: 5000 });
  await delay(500);
}

async function extractFlights(page: Page): Promise<Flight[]> {
  console.log('Extracting flight results…');

  const flights: Flight[] = [];

  // Google Flights result items are list items with flight info
  // Try several selector strategies
  const cardSelectors = [
    '[role="listitem"]',
    'li[data-id]',
    '.pIav2d',   // sometimes stable
  ];

  let cards = null;
  for (const sel of cardSelectors) {
    const loc = page.locator(sel);
    const count = await loc.count();
    if (count > 0) {
      console.log(`Found ${count} result items with selector: ${sel}`);
      cards = loc;
      break;
    }
  }

  if (!cards) {
    console.warn('No flight cards found — dumping page text for debugging…');
    const text = await page.locator('body').innerText();
    console.log(text.slice(0, 2000));
    return [];
  }

  const count = await cards.count();
  for (let i = 0; i < Math.min(count, 20); i++) {
    const card = cards.nth(i);
    const text = await card.innerText().catch(() => '');
    if (!text.trim()) continue;

    // Parse price — look for $NNN pattern
    const priceMatch = text.match(/\$(\d[\d,]+)/);
    if (!priceMatch) continue;
    const price = parseInt(priceMatch[1].replace(',', ''), 10);
    if (isNaN(price) || price > 10000) continue; // skip noise

    // Parse times — e.g. "6:00 AM – 12:30 PM"
    const timeMatch = text.match(/(\d{1,2}:\d{2}\s*[AP]M)\s*[–\-]\s*(\d{1,2}:\d{2}\s*[AP]M)/i);
    const departure = timeMatch?.[1] ?? 'N/A';
    const arrival = timeMatch?.[2] ?? 'N/A';

    // Parse duration — e.g. "5 hr 30 min"
    const durationMatch = text.match(/(\d+\s*hr(?:\s*\d+\s*min)?|\d+\s*min)/i);
    const duration = durationMatch?.[1] ?? 'N/A';

    // Parse airline — first line that isn't a time/price/duration
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const airline = lines.find(l =>
      !l.match(/^\$/) &&
      !l.match(/\d:\d{2}/) &&
      !l.match(/hr|min/i) &&
      !l.match(/nonstop|stop/i) &&
      l.length > 2
    ) ?? 'Unknown';

    flights.push({ airline, price, departure, arrival, duration });
  }

  return flights;
}

async function saveCSV(flights: Flight[]) {
  const outPath = path.join(process.cwd(), 'flights.csv');
  const header = 'rank,airline,price,departure,arrival,duration\n';
  const rows = flights
    .map((f, i) =>
      `${i + 1},"${f.airline}",${f.price},"${f.departure}","${f.arrival}","${f.duration}"`
    )
    .join('\n');
  fs.writeFileSync(outPath, header + rows + '\n', 'utf8');
  console.log(`\nSaved ${flights.length} flights to: ${outPath}`);
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
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

    // --- Fill origin ---
    await fillAirportField(page, 'Where from', ORIGIN, ORIGIN_CODE);

    // --- Fill destination ---
    await fillAirportField(page, 'Where to', DESTINATION, DESTINATION_CODE);

    // --- Confirm round trip (should be default) ---
    // Try to verify or set round-trip
    try {
      const tripTypeBtn = page.locator('[aria-label*="Round trip" i]').first();
      if (!(await tripTypeBtn.isVisible({ timeout: 2000 }))) {
        // might need to open the dropdown
        const tripDropdown = page.locator('[data-value*="round" i], [aria-label*="trip type" i]').first();
        await tripDropdown.click();
        await delay(500);
        await page.locator('[data-value="1"], [aria-label*="Round trip" i]').first().click();
        await delay(500);
      }
    } catch { /* already round trip */ }

    // --- Set departure date ---
    await setDate(page, 'Departure', DEPART_DATE, DEPART_DATE_FULL);

    // --- Set return date ---
    await setDate(page, 'Return', RETURN_DATE, RETURN_DATE_FULL);

    // --- Click Search / Done ---
    console.log('Submitting search…');
    const searchSelectors = [
      'button[aria-label*="Search" i]',
      'button:has-text("Search")',
      '[aria-label*="Done" i]',
      'button:has-text("Done")',
    ];
    for (const sel of searchSelectors) {
      try {
        const btn = page.locator(sel).last();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          console.log(`Clicked search via: ${sel}`);
          break;
        }
      } catch { /* try next */ }
    }

    // --- Wait for results ---
    console.log('Waiting for flight results…');
    await page.waitForSelector('[role="listitem"], [role="main"] li', {
      timeout: 25000,
    });
    await delay(2000); // let more results render

    // --- Extract ---
    let flights = await extractFlights(page);
    console.log(`\nExtracted ${flights.length} flights total.`);

    // Sort by price
    flights.sort((a, b) => a.price - b.price);

    const cheap = flights.filter(f => f.price < PRICE_LIMIT);
    let top3: Flight[];

    if (cheap.length === 0) {
      console.log(`\nNo flights found under $${PRICE_LIMIT}. Showing cheapest 3 available:`);
      top3 = flights.slice(0, 3);
    } else {
      console.log(`\nFound ${cheap.length} flights under $${PRICE_LIMIT}. Top 3:`);
      top3 = cheap.slice(0, 3);
    }

    console.log('\n--- Results ---');
    top3.forEach((f, i) => {
      console.log(`${i + 1}. ${f.airline} | $${f.price} | ${f.departure} – ${f.arrival} | ${f.duration}`);
    });

    if (top3.length > 0) {
      await saveCSV(top3);
    } else {
      console.log('\nNo results to save.');
    }

  } catch (err) {
    console.error('\nError:', err);
    const screenshotPath = path.join(process.cwd(), 'screenshot.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Screenshot saved to: ${screenshotPath}`);
  } finally {
    await delay(3000); // keep browser open briefly so user can see results
    await browser.close();
  }
}

main();
