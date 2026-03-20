const express = require('express');
const { chromium } = require('playwright-core');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'changeme-usa-una-clave-segura';

// ─── MIDDLEWARE DE AUTENTICACIÓN ───────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health') return next(); // health check sin auth
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'API key inválida o ausente' });
  }
  next();
});

// ─── HEALTH CHECK (Render lo usa para saber si el servicio está vivo) ──────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── ENDPOINT PRINCIPAL ────────────────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const email    = req.body.email    || process.env.GHL_EMAIL;
  const password = req.body.password || process.env.GHL_PASSWORD;

  if (!email || !password) {
    return res.status(400).json({ error: 'Faltan credenciales: email y password requeridos' });
  }

  console.log(`[${new Date().toISOString()}] Iniciando scraping para: ${email}`);

  try {
    const result = await scrapeGHL({ email, password });
    console.log(`[${new Date().toISOString()}] Scraping completado. Success: ${result.success}`);
    res.json(result);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fatal:`, err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ─── LÓGICA DE SCRAPING ────────────────────────────────────────────────────────
async function scrapeGHL({ email, password }) {
  const browser = await chromium.launch({
    // En Render.com usa el Chromium del sistema
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',      // crítico en contenedores con poca RAM
      '--disable-gpu',
      '--single-process',             // reduce uso de memoria en Render free tier
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/Guatemala',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  const result = {
    success: false,
    timestamp: new Date().toISOString(),
    metrics: {
      numberOfPosts:    null,
      totalLikes:       null,
      totalFollowers:   null,
      totalImpressions: null,
      totalComments:    null,
    },
    raw: {},
    errors: [],
    meta: { url: '', scrapedAt: '' },
  };

  try {
    // PASO 1: Login
    await page.goto('https://app.gohighlevel.com/login', {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });

    await delay(1000, 2000);

    await fillInput(page, ['input[type="email"]', 'input[name="email"]', '#email'], email);
    await delay(500, 1000);
    await fillInput(page, ['input[type="password"]', 'input[name="password"]', '#password'], password);
    await delay(800, 1500);

    await clickElement(page, [
      'button[type="submit"]',
      'button:has-text("Sign In")',
      'button:has-text("Log In")',
    ]);

    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});

    if (page.url().includes('login')) {
      throw new Error('Login fallido — verifica credenciales o si GHL pide 2FA');
    }

    await delay(2000, 3000);

    // PASO 2: Navegar a Social Planner → Statistics
    const statsUrls = [
      'https://app.gohighlevel.com/social-planner/statistics',
      'https://app.gohighlevel.com/v2/location/social-planner/statistics',
      'https://app.gohighlevel.com/social-media-planner/statistics',
    ];

    let landed = false;
    for (const url of statsUrls) {
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 25_000 });
        const current = page.url();
        if (!current.includes('login') && !current.includes('404')) {
          landed = true;
          break;
        }
      } catch (_) {}
    }

    if (!landed) {
      // Fallback: navegar por menú
      await clickElement(page, [
        'a:has-text("Social Planner")',
        '[data-testid="sidebar-social-planner"]',
        '.sidebar-menu a[href*="social"]',
      ]);
      await delay(1500, 2500);
      await clickElement(page, [
        'a:has-text("Statistics")',
        'button:has-text("Statistics")',
        '.tab:has-text("Statistics")',
      ]);
    }

    // PASO 3: Esperar que el dashboard cargue con datos numéricos
    await page.waitForFunction(() => {
      const candidates = document.querySelectorAll(
        'h4, h3, h2, strong, b, [class*="value"], [class*="count"], [class*="number"]'
      );
      return Array.from(candidates).some(el => /^\d[\d,.KMkm]*$/.test(el.textContent?.trim() || ''));
    }, { timeout: 20_000 }).catch(() => {
      console.warn('Timeout esperando valores numéricos — intentando extraer de todos modos');
    });

    await delay(1500, 2500);
    result.meta.url = page.url();

    // PASO 4: Extraer métricas del DOM
    const metrics = await page.evaluate(() => {
      const KEYWORDS = {
        posts:       ['number of posts', 'posts', 'publicaciones', 'total posts'],
        likes:       ['total likes', 'likes', 'me gusta'],
        followers:   ['total followers', 'followers', 'seguidores'],
        impressions: ['total impressions', 'impressions', 'impresiones', 'alcance'],
        comments:    ['total comments', 'comments', 'comentarios'],
      };

      const parse = (str) => {
        if (!str) return null;
        const s = str.replace(/,/g, '').trim();
        if (/^[\d.]+[Kk]$/.test(s)) return Math.round(parseFloat(s) * 1_000);
        if (/^[\d.]+[Mm]$/.test(s)) return Math.round(parseFloat(s) * 1_000_000);
        const n = parseFloat(s.replace(/[^0-9.]/g, ''));
        return isNaN(n) ? str : n;
      };

      const found = {};

      // Estrategia 1: tarjetas estructuradas
      const cardSelectors = [
        '.n-statistic', '.el-statistic', '.stat-card', '.metric-card',
        '[class*="statistic-item"]', '[class*="stat-item"]', '[class*="overview-card"]',
      ];

      for (const sel of cardSelectors) {
        document.querySelectorAll(sel).forEach(card => {
          const text = card.textContent?.toLowerCase() || '';
          for (const [key, kws] of Object.entries(KEYWORDS)) {
            if (found[key]) continue;
            if (kws.some(kw => text.includes(kw))) {
              const valEl = card.querySelector(
                '[class*="value"], [class*="count"], h4, h3, h2, strong, b'
              );
              const raw = valEl?.textContent?.trim();
              if (raw && /\d/.test(raw)) {
                found[key] = { raw, value: parse(raw) };
              }
            }
          }
        });
        if (Object.keys(found).length === 5) break;
      }

      // Estrategia 2: búsqueda por proximidad label→valor
      if (Object.keys(found).length < 5) {
        document.querySelectorAll('p, span, div, label, td').forEach(el => {
          if (el.children.length > 2) return;
          const text = el.textContent?.trim().toLowerCase() || '';
          for (const [key, kws] of Object.entries(KEYWORDS)) {
            if (found[key]) continue;
            if (kws.some(kw => text === kw || text.endsWith(kw))) {
              // Busca valor en siguiente sibling, padre, o hijo
              const candidates = [
                el.nextElementSibling,
                el.previousElementSibling,
                el.parentElement?.querySelector('h4,h3,h2,strong,b,[class*="value"]'),
              ].filter(Boolean);

              for (const c of candidates) {
                const raw = c?.textContent?.trim();
                if (raw && /^\d[\d,.KMkm]*$/.test(raw)) {
                  found[key] = { raw, value: parse(raw) };
                  break;
                }
              }
            }
          }
        });
      }

      return found;
    });

    // Mapear resultados
    const keys = ['posts', 'likes', 'followers', 'impressions', 'comments'];
    const metricNames = {
      posts: 'numberOfPosts', likes: 'totalLikes', followers: 'totalFollowers',
      impressions: 'totalImpressions', comments: 'totalComments',
    };

    keys.forEach(k => {
      result.metrics[metricNames[k]] = metrics[k]?.value ?? null;
      result.raw[k] = metrics[k]?.raw ?? null;
      if (!metrics[k]) result.errors.push(`No encontrado: ${k}`);
    });

    result.success = Object.values(result.metrics).some(v => v !== null);
    result.meta.scrapedAt = new Date().toISOString();

  } catch (err) {
    result.errors.push(err.message);
    result.success = false;
  } finally {
    await browser.close();
  }

  return result;
}

// ─── UTILS ─────────────────────────────────────────────────────────────────────
const delay = (min, max) =>
  new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));

async function fillInput(page, selectors, value) {
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      await page.fill(sel, '');
      await page.type(sel, value, { delay: 60 + Math.random() * 40 });
      return;
    } catch (_) {}
  }
  throw new Error(`Input no encontrado: ${selectors[0]}`);
}

async function clickElement(page, selectors) {
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      await page.click(sel);
      return;
    } catch (_) {}
  }
  throw new Error(`Elemento no encontrado para click: ${selectors[0]}`);
}

// ─── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`GHL Scraper Service corriendo en puerto ${PORT}`);
});
