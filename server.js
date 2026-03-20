const express = require('express');
const { chromium } = require('playwright-core');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'changeme-usa-una-clave-segura';

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'API key inválida' });
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/scrape', async (req, res) => {
  const email    = req.body.email    || process.env.GHL_EMAIL;
  const password = req.body.password || process.env.GHL_PASSWORD;

  try {
    const result = await scrape(email, password);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function scrape(email, password) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const page = await browser.newPage();

  const result = { success: false, errors: [] };

  try {
    await page.goto('https://app.solucionesseguras.org/', {
      waitUntil: 'networkidle'
    });

    await page.waitForTimeout(4000);

    // ✅ EMAIL
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });
    await page.fill('input[type="email"]', email);

    // ✅ PASSWORD
    await page.fill('input[type="password"]', password);

    // ✅ BOTÓN (IMPORTANTE)
    await page.click('button:has-text("Sign in")');

    await page.waitForTimeout(6000);

    if (page.url().includes('login')) {
      throw new Error('Login fallido');
    }

    // ✅ STATS
    await page.goto(
      'https://app.solucionesseguras.org/v2/location/NjBMY7rtgaZ7BpJORRqw/marketing/social-planner/statistics',
      { waitUntil: 'networkidle' }
    );

    await page.waitForTimeout(5000);

    const data = await page.evaluate(() =>
      Array.from(document.querySelectorAll('h2,h3,h4'))
        .map(e => e.innerText)
    );

    result.success = true;
    result.metrics = data;

  } catch (err) {
    result.errors.push(err.message);
  } finally {
    await browser.close();
  }

  return result;
}

app.listen(PORT, () => {
  console.log("Servidor listo");
});
