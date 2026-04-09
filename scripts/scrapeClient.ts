import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

/**
 * Zempotis Chat — Premium Client Scraper v4.0
 *
 * Usage:
 *   npx tsx scripts/scrapeClient.ts <clientId> <url>
 *
 * New in v4.0:
 *   - puppeteer-extra stealth plugin (anti-bot bypass)
 *   - Realistic Chrome UA + browser headers
 *   - Random delays between page visits (1–3 s)
 *   - Cookie banner auto-dismiss (OneTrust, Cookiebot, text-based)
 *   - Full-page scroll to trigger lazy loading
 *   - Platform detection: Wix / WordPress / Squarespace / Shopify / custom
 *   - WordPress REST API (/wp-json/wp/v2/pages+posts) for clean content
 *   - Shopify JSON endpoints (/products.json, /collections.json)
 *   - Sitemap crawling (/sitemap.xml, /sitemap_index.xml)
 *   - Retry logic — up to 3 attempts with back-off; graceful 403/429 skip
 *   - Improved content cleaning: focus main/article, deduplicate lines
 */

import puppeteer from 'puppeteer-extra';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
import { Browser, Page } from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import { pipeline } from '@xenova/transformers';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import * as zlib from 'zlib';

puppeteer.use(StealthPlugin());

// ── env ──────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

// ── args ──────────────────────────────────────────────────────────────────────
const [clientId, startUrl] = process.argv.slice(2);
if (!clientId || !startUrl) {
  console.error('Usage: npx tsx scripts/scrapeClient.ts <clientId> <url>');
  process.exit(1);
}

// ── constants ─────────────────────────────────────────────────────────────────
const MAX_PAGES = 30;
const MAX_CHUNK_WORDS = 250;
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── supabase ──────────────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── embedding pipeline ────────────────────────────────────────────────────────
let embedPipeline: Awaited<ReturnType<typeof pipeline>> | null = null;
async function getEmbedder() {
  if (!embedPipeline) {
    console.log('⚙️  Loading embedding model…');
    embedPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log('✅ Embedding model ready');
  }
  return embedPipeline;
}
async function embedText(text: string): Promise<number[]> {
  const pipe = await getEmbedder();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await (pipe as any)(text, { pooling: 'mean', normalize: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Array.from((out as any).data as Float32Array);
}

// ── url utils ─────────────────────────────────────────────────────────────────
function normaliseUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    u.hash = '';
    if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.href;
  } catch { return null; }
}

function randomDelay(min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(r => setTimeout(r, ms));
}

// ── http download (sitemap, logo, WP/Shopify APIs) ───────────────────────────
function downloadUrl(urlStr: string): Promise<{ buffer: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === 'https:' ? https : http;
    mod.get(urlStr, { headers: { 'User-Agent': CHROME_UA } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode} for ${urlStr}`));
        return;
      }
      const chunks: Buffer[] = [];
      const ct = (res.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
      if (res.headers['content-encoding'] === 'gzip') {
        const gunzip = zlib.createGunzip();
        res.pipe(gunzip);
        gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
        gunzip.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: ct }));
        gunzip.on('error', reject);
        res.on('error', reject);
      } else {
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: ct }));
        res.on('error', reject);
      }
    }).on('error', reject);
  });
}

// ── platform detection ────────────────────────────────────────────────────────
async function detectPlatform(page: Page): Promise<string> {
  const iife = `(function() {
    var scripts = Array.from(document.querySelectorAll('script[src]')).map(function(s) { return s.src || ''; }).join(' ');
    var links   = Array.from(document.querySelectorAll('link[href]')).map(function(l) { return l.href || ''; }).join(' ');
    var meta    = document.querySelector('meta[name="generator"]');
    var gen     = meta ? (meta.getAttribute('content') || '').toLowerCase() : '';
    if (scripts.includes('wix.com') || !!document.querySelector('[data-mesh-id]')) return 'wix';
    if (gen.includes('wordpress') || scripts.includes('/wp-content/') || links.includes('/wp-content/')) return 'wordpress';
    if (scripts.includes('squarespace.com') || scripts.includes('squarespace-cdn')) return 'squarespace';
    if (scripts.includes('shopify.com') || scripts.includes('cdn.shopify.com')) return 'shopify';
    return 'custom';
  })()`;
  try {
    return (await page.evaluate(iife)) as unknown as string;
  } catch { return 'custom'; }
}

// ── cookie banner dismiss ─────────────────────────────────────────────────────
async function dismissCookieBanners(page: Page): Promise<void> {
  const iife = `(function() {
    var done = false;
    // Known IDs from major consent frameworks
    var ids = [
      'onetrust-accept-btn-handler',
      'CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
      'cookie-accept', 'cookie-consent-accept', 'accept-cookies',
      'gdpr-accept', 'cc-accept', 'acceptAllCookies'
    ];
    for (var i = 0; i < ids.length && !done; i++) {
      var el = document.getElementById(ids[i]);
      if (el) { el.click(); done = true; }
    }
    // CSS class / attribute selectors
    if (!done) {
      var sels = [
        '.cookie-accept', '.cc-btn.cc-allow', '.cc-allow',
        '[class*="cookie-accept"]', '[class*="accept-cookie"]',
        '#cookie-banner button[class*="accept"]',
        '.cookie-banner button[class*="accept"]',
        '.cookie-consent button[class*="accept"]',
        '[data-cookiebanner] button',
        '[aria-label*="Accept cookies"]'
      ];
      for (var j = 0; j < sels.length && !done; j++) {
        var btn = document.querySelector(sels[j]);
        if (btn) { btn.click(); done = true; }
      }
    }
    // Text-based fallback across all buttons
    if (!done) {
      var phrases = ['accept all', 'accept cookies', 'accept', 'allow all', 'allow cookies',
                     'allow', 'ok', 'got it', 'agree', 'i agree'];
      var btns = document.querySelectorAll('button, a[role="button"]');
      for (var k = 0; k < btns.length && !done; k++) {
        var t = (btns[k].textContent || '').toLowerCase().trim();
        for (var m = 0; m < phrases.length; m++) {
          if (t === phrases[m] || t.startsWith(phrases[m] + ' ')) {
            btns[k].click(); done = true; break;
          }
        }
      }
    }
    return done;
  })()`;
  try {
    await page.evaluate(iife);
    await new Promise(r => setTimeout(r, 600));
  } catch { /* best-effort */ }
}

// ── full-page scroll (triggers lazy loading) ──────────────────────────────────
async function scrollPage(page: Page): Promise<void> {
  try {
    const totalHeight = (await page.evaluate('document.body.scrollHeight')) as unknown as number;
    const step = 600;
    for (let pos = step; pos < totalHeight; pos += step) {
      await page.evaluate(`window.scrollTo(0, ${pos})`);
      await new Promise(r => setTimeout(r, 150));
    }
    await page.evaluate('window.scrollTo(0, 0)');
    await new Promise(r => setTimeout(r, 400));
  } catch { /* best-effort */ }
}

// ── sitemap crawling ──────────────────────────────────────────────────────────
async function fetchSitemapUrls(origin: string): Promise<string[]> {
  const urls: string[] = [];

  async function tryFetch(url: string): Promise<string | null> {
    try { const { buffer } = await downloadUrl(url); return buffer.toString('utf-8'); }
    catch { return null; }
  }

  async function parseSitemap(xml: string): Promise<void> {
    if (xml.includes('<sitemapindex')) {
      // Recurse into child sitemaps (cap at 8 to avoid runaway)
      const locs = Array.from(xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/g)).map(m => m[1].trim());
      for (const loc of locs.slice(0, 8)) {
        const child = await tryFetch(loc);
        if (child) await parseSitemap(child);
      }
      return;
    }
    Array.from(xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/g)).forEach(m => {
      const u = m[1].trim();
      if (u.startsWith(origin) && !u.match(/\.(xml|pdf|jpg|jpeg|png|gif|svg|css|js)$/i)) {
        urls.push(u);
      }
    });
  }

  for (const p of ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap/sitemap.xml']) {
    const xml = await tryFetch(`${origin}${p}`);
    if (xml && (xml.includes('<urlset') || xml.includes('<sitemapindex'))) {
      await parseSitemap(xml);
      break;
    }
  }

  return Array.from(new Set(urls)).slice(0, MAX_PAGES * 3);
}

// ── shared types ──────────────────────────────────────────────────────────────
interface ContentChunk { heading: string; content: string }

// ── WordPress REST API ────────────────────────────────────────────────────────
async function fetchWordPressContent(origin: string): Promise<ContentChunk[]> {
  const chunks: ContentChunk[] = [];
  const endpoints = [
    `${origin}/wp-json/wp/v2/pages?per_page=100&_fields=title,content,slug`,
    `${origin}/wp-json/wp/v2/posts?per_page=100&_fields=title,content,slug`,
  ];
  for (const endpoint of endpoints) {
    try {
      const { buffer } = await downloadUrl(endpoint);
      const items = JSON.parse(buffer.toString('utf-8')) as Array<{
        title?: { rendered?: string };
        content?: { rendered?: string };
      }>;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const title = (item.title?.rendered || '').replace(/<[^>]+>/g, '').trim();
        const raw   = (item.content?.rendered || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (raw.length > 40) {
          const words = raw.split(/\s+/);
          for (let i = 0; i < words.length; i += MAX_CHUNK_WORDS) {
            const slice = words.slice(i, i + MAX_CHUNK_WORDS).join(' ');
            if (slice.length > 40) chunks.push({ heading: title, content: slice });
          }
        }
      }
    } catch { /* endpoint unavailable — fall back to crawling */ }
  }
  return chunks;
}

// ── Shopify JSON endpoints ────────────────────────────────────────────────────
async function fetchShopifyContent(origin: string): Promise<string> {
  let text = '';
  try {
    const { buffer } = await downloadUrl(`${origin}/products.json?limit=250`);
    const data = JSON.parse(buffer.toString('utf-8')) as {
      products?: Array<{ title: string; body_html: string; variants?: Array<{ price: string }> }>;
    };
    for (const p of data.products ?? []) {
      const desc = p.body_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      text += `\n\nProduct: ${p.title}\n${desc}`;
      for (const v of p.variants ?? []) {
        if (v.price) text += `\nPrice: £${v.price}`;
      }
    }
  } catch { /* products.json unavailable */ }
  try {
    const { buffer } = await downloadUrl(`${origin}/collections.json?limit=250`);
    const data = JSON.parse(buffer.toString('utf-8')) as {
      collections?: Array<{ title: string; body_html: string }>;
    };
    for (const c of data.collections ?? []) {
      const desc = c.body_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      text += `\n\nCollection: ${c.title}\n${desc}`;
    }
  } catch { /* collections.json unavailable */ }
  return text;
}

// ── content extraction ────────────────────────────────────────────────────────
async function extractContent(page: Page): Promise<{ text: string; headings: string[] }> {
  // ── Pass 1: snapshot content BEFORE clicking accordions ──────────────────────
  // Some sites (e.g. JS ordering widgets) replace initial static content once fully
  // rendered; capturing here preserves any content visible at load time.
  let preText = '';
  try {
    preText = await (page.evaluate(`(function(){
      return document.body ? (document.body.innerText || '') : '';
    })()`) as unknown as Promise<string>);
  } catch { /* best-effort */ }

  // ── Click accordions / expandable sections — only target closed/hidden elements ─
  try {
    await page.evaluate(`(function(){
      // Reliable "definitely closed" indicators
      document.querySelectorAll('[aria-expanded="false"]').forEach(function(el) { el.click(); });
      // Native <details> that are not yet open
      document.querySelectorAll('details:not([open]) summary').forEach(function(el) { el.click(); });
      // Bootstrap / common accordion toggles that reference a collapsed target
      document.querySelectorAll(
        '.accordion-toggle, .faq-toggle, [data-toggle="collapse"], [data-bs-toggle="collapse"], [data-toggle="tab"], [data-bs-toggle="tab"]'
      ).forEach(function(el) { el.click(); });
      // Menu/accordion specific class patterns — only click if not already expanded
      document.querySelectorAll('[class*="accordion"] [class*="header"], [class*="accordion"] [class*="title"], [class*="accordion"] [class*="toggle"]').forEach(function(el) {
        var p = el.closest('[class*="accordion"]');
        if (p && !p.hasAttribute("open") && p.getAttribute("aria-expanded") !== "true") {
          el.click();
        }
      });
    })()`);
  } catch { /* best-effort */ }

  // Also click menu category buttons / list items in ordering widgets (e.g. MoreEats, Flipdish)
  // These load dish content dynamically per-category rather than using standard accordion patterns
  try {
    const categoryCount = await (page.evaluate(`(function(){
      var clicked = 0;
      // Look for category-style buttons/links that aren't nav items
      var candidates = document.querySelectorAll(
        'button[class*="category"], button[class*="section"], button[class*="tab"], ' +
        'li[class*="category"], li[class*="section"], [role="tab"], [role="button"][class*="cat"]'
      );
      candidates.forEach(function(el) {
        var txt = el.innerText && el.innerText.trim();
        if (txt && txt.length > 1 && txt.length < 60) { el.click(); clicked++; }
      });
      return clicked;
    })()`) as unknown as Promise<number>);
    if (categoryCount > 0) {
      await new Promise(r => setTimeout(r, 1500)); // extra wait for category content to load
    }
  } catch { /* best-effort */ }

  // Wait 2 s for animations to fully render before extracting
  await new Promise(r => setTimeout(r, 2000));

  // Scroll again after expanding — triggers any lazy-loaded content revealed by accordions
  await scrollPage(page);

  const iife = `(function() {
    // Remove noise: nav chrome, cookie banners, popups, modals
    ['script','style','noscript','iframe','nav','footer','header','aside',
     '.cookie-banner','#cookie-banner','[aria-hidden="true"]',
     '[class*="cookie"]','[id*="cookie"]','[class*="consent"]',
     '[class*="gdpr"]','[class*="popup"]','[id*="popup"]',
     '[class*="modal"]','[id*="modal"]','[class*="overlay"]',
     '[role="dialog"]','[role="alertdialog"]'
    ].forEach(function(sel) {
      try { document.querySelectorAll(sel).forEach(function(el) { el.remove(); }); } catch(e) {}
    });

    var headings = [];
    document.querySelectorAll('h1,h2,h3,h4').forEach(function(h) {
      var t = h.innerText && h.innerText.trim();
      if (t) headings.push(t);
    });

    var parts = [];

    // Prefer scoped content areas over full body (avoids nav/footer leakage)
    var mainEl = document.querySelector(
      'main, [role="main"], article, #content, .content, .main-content, ' +
      '.entry-content, .page-content, .post-content, #main, .site-content'
    );
    parts.push(mainEl ? (mainEl.innerText || '') : (document.body ? (document.body.innerText || '') : ''));

    // JSON-LD structured data
    var extractStrings = function(v) {
      if (typeof v === 'string' && v.length > 2) return v;
      if (Array.isArray(v)) return v.map(extractStrings).filter(Boolean).join(' ');
      if (v && typeof v === 'object') return Object.values(v).map(extractStrings).filter(Boolean).join(' ');
      return '';
    };
    document.querySelectorAll('script[type="application/ld+json"]').forEach(function(s) {
      try { var txt = extractStrings(JSON.parse(s.textContent || '')); if (txt) parts.push(txt); } catch(e) {}
    });

    // Meta / OG descriptions
    var md = document.querySelector('meta[name="description"]');
    if (md) { var mc = md.getAttribute('content'); if (mc) parts.push(mc); }
    var og = document.querySelector('meta[property="og:description"]');
    if (og) { var oc = og.getAttribute('content'); if (oc) parts.push(oc); }

    // Tables
    document.querySelectorAll('table').forEach(function(tbl) {
      var tt = tbl.innerText && tbl.innerText.trim();
      if (tt) parts.push(tt);
    });

    // Price context — aggressive: capture dish name + price together
    var priceTexts = [];
    var priceSeen = {};
    // First pass: menu/dish/item/price specific containers
    document.querySelectorAll(
      '[class*="menu"] *, [class*="dish"] *, [class*="item"] *, [class*="price"] *, [class*="product"] *'
    ).forEach(function(el) {
      var t = el.innerText;
      if (t && /[\u00A3$\u20AC]/.test(t)) {
        // Prefer parent text for "dish name + price" context
        var parent = el.parentElement;
        var ctx = (parent && parent.innerText) ? parent.innerText.trim().slice(0, 300) : t.trim().slice(0, 300);
        if (ctx && !priceSeen[ctx]) { priceSeen[ctx] = true; priceTexts.push(ctx); }
      }
    });
    // Second pass: any element with a currency symbol not yet captured
    document.querySelectorAll('*').forEach(function(el) {
      var t = el.innerText;
      if (t && /[\u00A3$\u20AC]/.test(t) && el.children.length < 3) {
        var trimmed = t.trim().slice(0, 200);
        if (trimmed && !priceSeen[trimmed]) { priceSeen[trimmed] = true; priceTexts.push(trimmed); }
      }
    });
    if (priceTexts.length) parts.push(priceTexts.join('\\n'));

    // Deduplicate lines — removes repeated nav/footer text that appears on every page
    var seen = {};
    var dedupedLines = parts.join('\\n\\n').split('\\n').filter(function(line) {
      var t = line.trim();
      if (!t) return false;
      if (t.length < 25) return true;  // keep short lines: headings, labels, prices
      if (seen[t]) return false;
      seen[t] = true;
      return true;
    });

    return { text: dedupedLines.join('\\n'), headings: headings };
  })()`;

  const result = await (page.evaluate(iife) as unknown as Promise<{ text: string; headings: string[] }>);

  // Merge pre-accordion snapshot — ensures content visible before JS widgets took over is preserved
  if (preText && preText.length > 100) {
    result.text = preText + '\n' + result.text;
  }

  // ── Also extract text from child iframes (e.g. embedded menu/ordering widgets) ──
  const frameIife = `(function(){
    try {
      var h = document.body ? (document.body.innerText || '') : '';
      return h.trim();
    } catch(e) { return ''; }
  })()`;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const frameText = (await (frame.evaluate(frameIife) as unknown as Promise<string>)).trim();
      if (frameText && frameText.length > 100) {
        result.text += '\n' + frameText;
      }
    } catch { /* cross-origin frames may throw — skip silently */ }
  }

  return result;
}

// ── colour detection ──────────────────────────────────────────────────────────
interface ColourEntry { hex: string; weight: number }

/**
 * Extract brand colours using multiple techniques ranked by confidence.
 * Filters: S>15%, L 10–88% (excludes greys, near-black, near-white).
 * Removes the Zempotis widget from the DOM first to avoid self-pollution.
 */
async function detectBrandColours(page: Page): Promise<{ primaryColor: string; accentColor: string }> {
  const iife = `(function() {
    // Remove Zempotis widget so its own buttons/styles don't pollute detection
    document.querySelectorAll('#zp-btn,#zp-win,#zp-overlay,#zp-toast').forEach(function(el) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });

    function parseRgb(str) {
      if (!str) return null;
      var m = str.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/);
      if (m) {
        var aMatch = str.match(/rgba\\([^,]+,[^,]+,[^,]+,\\s*([\\d.]+)/);
        if (aMatch && parseFloat(aMatch[1]) === 0) return null;
        return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
      }
      var h = str.trim().replace(/^#/, '');
      if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
      if (/^[0-9a-fA-F]{6}$/.test(h))
        return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
      return null;
    }
    function rgbToHsl(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      var max = Math.max(r,g,b), min = Math.min(r,g,b);
      var l = (max + min) / 2;
      if (max === min) return [0, 0, Math.round(l * 100)];
      var d = max - min;
      var s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      var hh = 0;
      if (max === r) hh = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) hh = ((b - r) / d + 2) / 6;
      else hh = ((r - g) / d + 4) / 6;
      return [Math.round(hh * 360), Math.round(s * 100), Math.round(l * 100)];
    }
    function isUsable(r, g, b) {
      var hsl = rgbToHsl(r, g, b);
      // S>15% avoids greys; L 10-88% avoids near-black and near-white
      return hsl[1] > 15 && hsl[2] > 10 && hsl[2] < 88;
    }
    function bucketHex(r, g, b) {
      function snap(v) { return Math.min(255, Math.round(v / 32) * 32); }
      return '#' + [snap(r), snap(g), snap(b)].map(function(x) {
        return x.toString(16).padStart(2,'0');
      }).join('');
    }
    var counts = {};
    function add(str, weight) {
      if (!str || str === 'transparent' || str === 'inherit' || str === 'currentcolor') return;
      var rgb = parseRgb(str);
      if (!rgb || !isUsable(rgb[0], rgb[1], rgb[2])) return;
      var key = bucketHex(rgb[0], rgb[1], rgb[2]);
      counts[key] = (counts[key] || 0) + weight;
    }

    // 1. meta theme-color (most explicit)
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) add(meta.getAttribute('content') || '', 20);

    // 2. :root CSS custom properties
    var root = getComputedStyle(document.documentElement);
    ['--primary','--primary-color','--color-primary','--brand-color','--brand-primary',
     '--accent','--accent-color','--color-accent','--color-brand','--color-link',
     '--theme-color','--color-theme','--highlight-color','--link-color',
     '--wp--preset--color--primary','--wp--preset--color--secondary'
    ].forEach(function(v) { add(root.getPropertyValue(v).trim(), 10); });

    // 3. Buttons / CTAs
    document.querySelectorAll(
      'button:not([disabled]), [type="submit"], .btn, [class*="btn-primary"], [class*="cta"], a[class*="button"]'
    ).forEach(function(el) { add(getComputedStyle(el).backgroundColor, 8); });

    // 4. Navigation / header background
    ['nav','header','[role="navigation"]','.navbar','#navbar','.header','#header'].forEach(function(sel) {
      document.querySelectorAll(sel).forEach(function(el) {
        var s = getComputedStyle(el);
        add(s.backgroundColor, 6);
        add(s.borderBottomColor, 3);
      });
    });

    // 5. Hero / banner background
    ['.hero','#hero','[class*="hero"]','[class*="banner"]','main > section:first-child'].forEach(function(sel) {
      var el = document.querySelector(sel);
      if (el) add(getComputedStyle(el).backgroundColor, 5);
    });

    // 6. Headings (brand colours often appear in h1/h2 text)
    document.querySelectorAll('h1, h2').forEach(function(el) { add(getComputedStyle(el).color, 3); });

    // 7. Broad frequency scan — catches Tailwind utility classes not covered above
    var freq = {};
    document.querySelectorAll('*:not(#zp-btn):not(#zp-win):not(#zp-overlay)').forEach(function(el) {
      if (el.id && /^zp-/.test(el.id)) return;
      var s = getComputedStyle(el);
      [s.backgroundColor, s.color, s.borderColor].forEach(function(c) {
        if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)' || c === 'inherit') return;
        var rgb = parseRgb(c);
        if (rgb && isUsable(rgb[0], rgb[1], rgb[2])) {
          var key = bucketHex(rgb[0], rgb[1], rgb[2]);
          freq[key] = (freq[key] || 0) + 1;
        }
      });
    });
    // Only add colours appearing on 3+ elements (brand colours repeat; noise doesn't)
    Object.keys(freq).forEach(function(key) {
      if (freq[key] >= 3) { counts[key] = (counts[key] || 0) + freq[key]; }
    });

    return Object.entries(counts)
      .sort(function(a, b) { return b[1] - a[1]; })
      .slice(0, 10)
      .map(function(e) { return { hex: e[0], weight: e[1] }; });
  })()`;

  const entries = await page.evaluate(iife) as unknown as ColourEntry[];
  console.log('  🎨 Colour candidates:', entries.map(e => `${e.hex}(${e.weight})`).join(', '));
  const primaryColor = entries[0]?.hex ?? '#2563eb';
  const accentColor  = entries[1]?.hex ?? '#7c3aed';
  return { primaryColor, accentColor };
}

// ── logo extraction ───────────────────────────────────────────────────────────
async function extractLogo(page: Page, origin: string): Promise<string | null> {
  const rawUrl = await page.evaluate(`(function() {
    // 1. header/nav img whose src contains "logo"
    var navImgs = document.querySelectorAll('header img, nav img, .header img, .navbar img');
    for (var i = 0; i < navImgs.length; i++) {
      var src = navImgs[i].src || '';
      if (src && /logo/i.test(src)) return src;
    }
    // 2. Any img whose alt contains "logo"
    var allImgs = document.querySelectorAll('img');
    for (var j = 0; j < allImgs.length; j++) {
      var alt = allImgs[j].alt || '';
      if (/logo/i.test(alt) && allImgs[j].src) return allImgs[j].src;
    }
    // 3. First img inside header or nav (regardless of name)
    var firstHeaderImg = document.querySelector('header img, nav img, .header img, .navbar img');
    if (firstHeaderImg && firstHeaderImg.src) return firstHeaderImg.src;
    // 4. apple-touch-icon
    var touch = document.querySelector('link[rel="apple-touch-icon"]');
    if (touch && touch.href) return touch.href;
    // 5. favicon with image type
    var favicon = document.querySelector('link[rel="icon"][type*="image"], link[rel="shortcut icon"]');
    if (favicon && favicon.href) return favicon.href;
    // 6. og:image
    var og = document.querySelector('meta[property="og:image"]');
    if (og && og.content) return og.content;
    return null;
  })()`) as unknown as string | null;

  if (!rawUrl) return null;
  let absoluteUrl: string;
  try {
    absoluteUrl = new URL(rawUrl, origin).href;
  } catch { return rawUrl; }
  try {
    const { buffer, contentType } = await downloadUrl(absoluteUrl);
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.warn('  Warning: could not download logo, using URL as fallback:', (err as Error).message);
    return absoluteUrl;
  }
}

// ── chunking ──────────────────────────────────────────────────────────────────
function splitIntoChunks(text: string, headings: string[]): ContentChunk[] {
  const chunks: ContentChunk[] = [];
  const escapedHeadings = headings
    .filter(h => h.length > 3)
    .map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let currentHeading = '';
  let currentLines: string[] = [];

  const flush = () => {
    const content = currentLines.join(' ').trim();
    if (content.length > 40) {
      const words = content.split(/\s+/);
      for (let i = 0; i < words.length; i += MAX_CHUNK_WORDS) {
        const slice = words.slice(i, i + MAX_CHUNK_WORDS).join(' ');
        if (slice.length > 40) chunks.push({ heading: currentHeading, content: slice });
      }
    }
    currentLines = [];
  };

  for (const line of lines) {
    const isHeading = escapedHeadings.length > 0 &&
      escapedHeadings.some(h => new RegExp(`^${h}$`, 'i').test(line));
    if (isHeading) { flush(); currentHeading = line; }
    else currentLines.push(line);
  }
  flush();

  if (chunks.length === 0 && text.trim().length > 40) {
    const words = text.split(/\s+/);
    for (let i = 0; i < words.length; i += MAX_CHUNK_WORDS) {
      const slice = words.slice(i, i + MAX_CHUNK_WORDS).join(' ');
      if (slice.length > 40) chunks.push({ heading: '', content: slice });
    }
  }
  return chunks;
}

// ── navigation with retry ─────────────────────────────────────────────────────
async function navigateWithRetry(page: Page, url: string, maxRetries = 3): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
      const status = res?.status() ?? 200;
      if (status === 403 || status === 429) {
        console.warn(`  ⚠️  Blocked (${status}): ${url}`);
        return false;
      }
      return true;
    } catch (err) {
      if (attempt === maxRetries) {
        console.warn(`  ❌ Failed after ${maxRetries} retries: ${(err as Error).message.slice(0, 80)}`);
        return false;
      }
      const delay = attempt * 2_000;
      console.warn(`\n  ⟳ Retry ${attempt}/${maxRetries} in ${delay / 1000}s…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return false;
}

// ── main ──────────────────────────────────────────────────────────────────────
async function scrape() {
  console.log(`\n🕷️  Scraping "${clientId}" → ${startUrl}\n`);

  const origin = new URL(startUrl).origin;
  const visited = new Set<string>();
  const queue: string[] = [normaliseUrl(startUrl, startUrl)!];
  let allChunks: ContentChunk[] = [];
  let fullText = '';
  let clientName = clientId;
  let primaryColor = '#2563eb';
  let accentColor  = '#7c3aed';
  let logoUrl: string | null = null;
  let platform = 'custom';

  const browser: Browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  }) as unknown as Browser;

  try {
    const page: Page = await browser.newPage() as unknown as Page;

    // Realistic browser fingerprint
    await page.setUserAgent(CHROME_UA);
    await page.setExtraHTTPHeaders({
      'Accept-Language':        'en-GB,en;q=0.9,en-US;q=0.8',
      'Accept':                 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding':        'gzip, deflate, br',
      'DNT':                    '1',
      'Upgrade-Insecure-Requests': '1',
    });
    await page.setViewport({ width: 1366, height: 768 });

    // ── Intercept JSON API responses (e.g. ordering widget menu APIs) ─────────
    const capturedApiText: string[] = [];
    await page.setRequestInterception(true);
    page.on('request', (req: { continue: () => void }) => req.continue());
    page.on('response', async (res: { status: () => number; headers: () => Record<string, string>; url: () => string; text: () => Promise<string> }) => {
      try {
        const ct = res.headers()['content-type'] || '';
        if (res.status() >= 200 && res.status() < 300 && ct.includes('json')) {
          const url = res.url();
          // Skip very small responses and tracking/analytics endpoints
          if (url.includes('analytics') || url.includes('tracking') || url.includes('pixel')) return;
          const raw = await res.text();
          if (raw.length < 100 || raw.length > 500_000) return;
          // Flatten JSON to strings — extracts names/prices/descriptions recursively
          const flatten = (v: unknown): string => {
            if (typeof v === 'string') return v.length > 2 ? v : '';
            if (typeof v === 'number') return String(v);
            if (Array.isArray(v)) return v.map(flatten).filter(Boolean).join(' ');
            if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).map(flatten).filter(Boolean).join(' ');
            return '';
          };
          try {
            const json = JSON.parse(raw);
            const text = flatten(json).trim();
            if (text.length > 100) capturedApiText.push(text);
          } catch { /* not valid JSON */ }
        }
      } catch { /* response body may be unavailable */ }
    });

    let pageCount = 0;
    while (queue.length > 0 && pageCount < MAX_PAGES) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);
      pageCount++;

      process.stdout.write(`  [${pageCount}/${MAX_PAGES}] ${url} … `);

      const ok = await navigateWithRetry(page, url);
      if (!ok) { console.log('skipped'); continue; }

      // ── First page only: platform detection + pre-fetching ────────────────
      if (pageCount === 1) {
        platform = await detectPlatform(page);
        console.log(`\n  📦 Platform: ${platform}`);

        // Sitemap — discover all pages without crawling
        const sitemapUrls = await fetchSitemapUrls(origin);
        if (sitemapUrls.length > 0) {
          console.log(`  🗺️  Sitemap: ${sitemapUrls.length} URLs queued`);
          for (const u of sitemapUrls) {
            if (!visited.has(u) && !queue.includes(u)) queue.push(u);
          }
        }

        // WordPress: REST API gives clean HTML-stripped content
        if (platform === 'wordpress') {
          const wpChunks = await fetchWordPressContent(origin);
          if (wpChunks.length > 0) {
            allChunks = allChunks.concat(wpChunks);
            console.log(`  📝 WordPress API: ${wpChunks.length} chunks pre-fetched`);
          }
        }

        // Shopify: products and collections via JSON endpoints
        if (platform === 'shopify') {
          const shopText = await fetchShopifyContent(origin);
          if (shopText) { fullText += shopText; console.log('  🛍️  Shopify JSON: content fetched'); }
        }
      }

      // ── Platform-specific extra wait for JS rendering ─────────────────────
      if      (platform === 'wix')         await new Promise(r => setTimeout(r, 3_000));
      else if (platform === 'squarespace') await new Promise(r => setTimeout(r, 1_500));

      // ── Dismiss cookie banners (first 2 pages only) ───────────────────────
      if (pageCount <= 2) await dismissCookieBanners(page);

      // ── Scroll to trigger lazy-loaded images / sections ───────────────────
      await scrollPage(page);

      // ── First page: extract brand config ──────────────────────────────────
      if (pageCount === 1) {
        clientName = await page.title().then(t => t.split('|')[0].split('-')[0].trim()) || clientId;
        const colours = await detectBrandColours(page);
        primaryColor = colours.primaryColor;
        accentColor  = colours.accentColor;
        logoUrl = await extractLogo(page, origin);
        console.log(`  🖼️  Logo: ${logoUrl ? 'found' : 'not found'}`);
        console.log(`  ✅ primaryColor: ${primaryColor}  accentColor: ${accentColor}`);
      }

      // ── Extract and chunk page content ────────────────────────────────────
      capturedApiText.length = 0; // clear stale responses from previous page

      let { text, headings } = await extractContent(page);

      // Drain API responses collected during this page's load + accordion expansion
      const apiTextForPage = capturedApiText.splice(0).join('\n');
      if (apiTextForPage.length > 100) {
        text = text + '\n' + apiTextForPage;
      }

      // Fallback: if JS rendering yielded almost nothing (e.g. ordering widget replaced
      // static content), also download raw HTML source and strip tags for plain text
      const jsChunkCount = splitIntoChunks(text, headings).length;
      if (jsChunkCount < 3) {
        try {
          const { buffer, contentType } = await downloadUrl(url);
          if (contentType.includes('html')) {
            const raw = buffer.toString('utf8')
              // strip scripts and style blocks
              .replace(/<script[\s\S]*?<\/script>/gi, ' ')
              .replace(/<style[\s\S]*?<\/style>/gi, ' ')
              // strip all remaining tags
              .replace(/<[^>]+>/g, ' ')
              // collapse whitespace
              .replace(/\s+/g, ' ')
              .trim();
            if (raw.length > 200) {
              text = text + '\n' + raw;
            }
          }
        } catch { /* best-effort — don't fail the page if raw fetch fails */ }
      }

      fullText += `\n\n=== ${url} ===\n${text}`;
      const chunks = splitIntoChunks(text, headings);
      allChunks = allChunks.concat(chunks);
      console.log(`${chunks.length} chunks`);

      // ── Collect internal links ────────────────────────────────────────────
      const hrefs = await page.evaluate(
        `Array.from(document.querySelectorAll('a[href]')).map(function(a){ return a.href; })`
      ) as unknown as string[];
      for (const href of hrefs) {
        const norm = normaliseUrl(href, origin);
        if (norm && norm.startsWith(origin) && !visited.has(norm) && !queue.includes(norm)) {
          queue.push(norm);
        }
      }

      // ── Random delay between page visits (mimics human browsing) ──────────
      if (queue.length > 0 && pageCount < MAX_PAGES) {
        await randomDelay(1_000, 3_000);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\n📊 Scraped ${visited.size} pages, ${allChunks.length} chunks`);

  // ── Deduplication ──────────────────────────────────────────────────────────
  const seen = new Set<string>();
  const uniqueChunks = allChunks.filter(c => {
    const key = c.content.slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`📌 ${uniqueChunks.length} unique chunks after deduplication`);

  // ── Upload embeddings ─────────────────────────────────────────────────────
  console.log('\n🔢 Generating embeddings and uploading…');

  const { error: deleteErr } = await supabase
    .from('client_embeddings')
    .delete()
    .eq('client_id', clientId);
  if (deleteErr) console.warn('  Warning (delete embeddings):', deleteErr.message);

  const BATCH = 10;
  let uploaded = 0;

  for (let i = 0; i < uniqueChunks.length; i += BATCH) {
    const batch = uniqueChunks.slice(i, i + BATCH);
    const rows = await Promise.all(
      batch.map(async c => ({
        client_id: clientId,
        heading:   c.heading,
        content:   c.content,
        embedding: await embedText(c.content),
      }))
    );
    const { error } = await supabase.from('client_embeddings').insert(rows);
    if (error) {
      console.error(`  Batch ${i / BATCH + 1} error:`, error.message);
    } else {
      uploaded += rows.length;
      process.stdout.write(`  Uploaded ${uploaded}/${uniqueChunks.length} chunks\r`);
    }
  }
  console.log(`\n✅ Uploaded ${uploaded} embedding chunks`);

  // ── Upsert client config to Supabase ─────────────────────────────────────
  const greeting     = `Hi! I'm the ${clientName} assistant. How can I help you today?`;
  const quickReplies = ['What services do you offer?', 'How do I get started?', 'What are your opening hours?'];
  const logoUrlForDb = logoUrl && !logoUrl.startsWith('data:') ? logoUrl : null;

  const { error: upsertErr } = await supabase
    .from('clients')
    .upsert({
      client_id:     clientId,
      name:          clientName,
      url:           startUrl,
      primary_color: primaryColor,
      accent_color:  accentColor,
      logo_url:      logoUrlForDb,
      greeting,
      quick_replies: quickReplies,
      content:       fullText.slice(0, 100_000),
      chunk_count:   uploaded,
      scraped_at:    new Date().toISOString(),
    }, { onConflict: 'client_id' });

  if (upsertErr) {
    console.error('  Error saving client config to Supabase:', upsertErr.message);
  } else {
    console.log('✅ Client config saved to Supabase clients table');
  }

  // ── Local JSON backup ─────────────────────────────────────────────────────
  const outDir  = path.resolve(process.cwd(), 'public', 'clients');
  const outPath = path.join(outDir, `${clientId}.json`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    clientId, name: clientName, url: startUrl,
    primaryColor, accentColor,
    logoUrl: logoUrlForDb,
    greeting, quickReplies,
    content: fullText.slice(0, 100_000),
    scrapedAt: new Date().toISOString(),
    chunkCount: uploaded,
  }, null, 2), 'utf-8');
  console.log(`💾 Local backup → ${outPath}`);

  // ── Embed code ────────────────────────────────────────────────────────────
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ Done! Embed code:

<script src="https://chatbot-product-flax.vercel.app/widget.js" data-client="${clientId}" async></script>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  primaryColor : ${primaryColor}
  accentColor  : ${accentColor}
  logoUrl      : ${logoUrlForDb ?? '(embedded as base64)'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

scrape().catch(err => { console.error('\n💥 Fatal error:', err); process.exit(1); });
