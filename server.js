const express = require('express');
const { chromium } = require('playwright-core');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'changeme-usa-una-clave-segura';

// ─── AUTH ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'API key inválida o ausente' });
  }
  next();
});

// ─── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── ENDPOINT ──────────────────────────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const email    = req.body.email    || process.env.GHL_EMAIL;
  const password = req.body.password || process.env.GHL_PASSWORD;

  if (!email || !password) {
    return res.status(400).json({ error: 'Faltan credenciales' });
  }

  try {
    const result = await scrapeGHL({ email, password });
    res.json(result);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ─── UTIL INPUT DINÁMICO ───────────────────────────────────────────────────────
async function fillInput(page, selectors, value) {
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      await page.fill(sel, value);
      return;
    } catch (e) {}
  }
  throw new Error(`No encontró input: ${selectors[0]}`);
}

// ─── SCRAPING ──────────────────────────────────────────────────────────────────
async function scrapeGHL({ email, password }) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--single-process',
    ],
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  const result = {
    success: false,
    metrics: {},
    errors: [],
  };

  try {
    // LOGIN
    await page.goto('https://app.solucionesseguras.org/', {
      waitUntil: 'networkidle',
    });

    await page.waitForTimeout(5000);

    // INPUTS
    await fillInput(page, [
      'input[type="email"]',
      'input[name="email"]',
      '#email'
    ], email);

    await fillInput(page, [
      'input[type="password"]',
      'input[name="password"]',
      '#password'
    ], password);

    // LOGIN CLICK
    await page.click('button[type="submit"]');

    await page.waitForTimeout(6000);

    if (page.url().includes('login')) {
      throw new Error('Login fallido');
    }

    // 🔥 URL REAL DE STATS
    await page.goto(
      'https://app.solucionesseguras.org/v2/location/NjBMY7rtgaZ7BpJORRqw/marketing/social-planner/statistics',
      { waitUntil: 'networkidle' }
    );

    await page.waitForTimeout(6000);

    // EXTRAER (temporal)
    const data = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('h2, h3, h4'))
        .map(el => el.innerText);
    });

    result.success = true;
    result.metrics = data;

  } catch (err) {
    result.errors.push(err.message);
  } finally {
    await browser.close();
  }

  return result;
}

// ─── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
