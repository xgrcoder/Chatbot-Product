import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

/**
 * Zempotis Chat — Premium Client Scraper v3.0
 *
 * Usage:
 *   npx tsx scripts/scrapeClient.ts <clientId> <url>
 *
 * Example:
 *   npx tsx scripts/scrapeClient.ts organic-trust https://www.organictrust.co.uk
 *
 * What it does:
 *   1. Crawls up to 30 pages with Puppeteer (same-origin only)
 *   2. Deep content extraction: expands accordions, JSON-LD, meta tags, tables, price elements
 *   3. Advanced colour detection (CSS) + logo-derived colour extraction
 *   4. Logo extraction: downloads logo and converts to base64 data URL
 *   5. Splits content into chunks and generates 384-dim embeddings
 *   6. Uploads chunks to Supabase client_embeddings table
 *   7. Upserts client config to Supabase clients table (includes logo_url)
 *   8. Saves a local JSON backup to public/clients/{clientId}.json
 *   9. Prints the embed code snippet
 */

import puppeteer, { Browser, Page } from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import { pipeline } from '@xenova/transformers';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import * as zlib from 'zlib';

// ── env ─────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

// ── args ─────────────────────────────────────────────────────────────────────
const [clientId, startUrl] = process.argv.slice(2);
if (!clientId || !startUrl) {
  console.error('Usage: npx tsx scripts/scrapeClient.ts <clientId> <url>');
  process.exit(1);
}

// ── constants ─────────────────────────────────────────────────────────────────
const MAX_PAGES = 30;
const MAX_CHUNK_WORDS = 250;

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

// ── content extraction ────────────────────────────────────────────────────────
async function extractContent(page: Page): Promise<{ text: string; headings: string[] }> {
  // Click all accordion/expand buttons, then wait for content to expand.
  // Uses string IIFE form — tsx/esbuild never transforms string content,
  // so no __name helpers are injected into the browser context.
  try {
    await page.evaluate(`(function(){
    document.querySelectorAll(
      '[aria-expanded="false"], .accordion-toggle, .faq-toggle, details summary, [data-toggle], [data-bs-toggle]'
    ).forEach(function(el) { el.click(); });
  })()`);
  } catch { /* accordion clicks are best-effort */ }

  await new Promise(r => setTimeout(r, 500));

  const iife = `(function() {
    ['script','style','noscript','iframe','nav','footer','header',
     '.cookie-banner','#cookie-banner','[aria-hidden="true"]'].forEach(function(sel) {
      document.querySelectorAll(sel).forEach(function(el) { el.remove(); });
    });

    var headings = [];
    document.querySelectorAll('h1,h2,h3,h4').forEach(function(h) {
      var t = h.innerText && h.innerText.trim();
      if (t) headings.push(t);
    });

    var parts = [];

    // Base body text
    parts.push(document.body.innerText || '');

    // JSON-LD schema text values
    var extractStrings = function(v) {
      if (typeof v === 'string' && v.length > 2) return v;
      if (Array.isArray(v)) return v.map(extractStrings).filter(Boolean).join(' ');
      if (v && typeof v === 'object') return Object.values(v).map(extractStrings).filter(Boolean).join(' ');
      return '';
    };
    document.querySelectorAll('script[type="application/ld+json"]').forEach(function(s) {
      try {
        var obj = JSON.parse(s.textContent || '');
        var txt = extractStrings(obj);
        if (txt) parts.push(txt);
      } catch(e) {}
    });

    // Meta description
    var metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
      var mc = metaDesc.getAttribute('content');
      if (mc) parts.push(mc);
    }

    // OG description
    var ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc) {
      var oc = ogDesc.getAttribute('content');
      if (oc) parts.push(oc);
    }

    // Table text
    document.querySelectorAll('table').forEach(function(tbl) {
      var tt = tbl.innerText && tbl.innerText.trim();
      if (tt) parts.push(tt);
    });

    // Price context: elements whose innerText contains currency symbols
    var priceTexts = [];
    document.querySelectorAll('*').forEach(function(el) {
      var t = el.innerText;
      if (t && /[\u00A3$\u20AC]/.test(t) && el.children.length < 3) {
        var trimmed = t.trim().slice(0, 200);
        if (trimmed) priceTexts.push(trimmed);
      }
    });
    if (priceTexts.length) parts.push(priceTexts.join('\\n'));

    return { text: parts.join('\\n\\n'), headings: headings };
  })()`;

  return page.evaluate(iife) as unknown as Promise<{ text: string; headings: string[] }>;
}

// ── colour detection ──────────────────────────────────────────────────────────

interface ColourEntry { hex: string; weight: number }

/**
 * Extract brand colours using multiple techniques ranked by confidence:
 *  1. meta[name="theme-color"]         — most explicit (weight 20)
 *  2. :root CSS custom properties      — common in modern sites (weight 10)
 *  3. Buttons / CTA elements           — almost always brand primary (weight 8)
 *  4. Navigation / header background   — secondary brand colour (weight 6)
 *  5. Hero / banner background         — often brand gradient start (weight 5)
 *  6. Link colours                     — brand accent (weight 4)
 *  7. Heading colours                  — text brand colour (weight 3)
 *
 * Filters out near-white (L>90%), near-black (L<10%), and greys (S<15%).
 * Groups similar shades (±16 per channel) and rank by total weight.
 */
async function detectBrandColours(page: Page): Promise<{ primaryColor: string; accentColor: string }> {
  // Uses IIFE string form — tsx/esbuild never transforms string content.
  // Priority: meta theme-color > CSS vars > buttons > nav/header > hero
  // Filters: S>20%, L 10–78% (excludes greys, near-black, and light pastels)
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

    // 7. All non-widget elements — any computed color/bg appearing on 3+ elements
    //    (catches Tailwind utility classes not covered by structural selectors)
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
    // Only add colours that appear on 3+ elements (brand colours repeat; noise doesn't)
    Object.keys(freq).forEach(function(key) {
      if (freq[key] >= 3) {
        counts[key] = (counts[key] || 0) + freq[key];
      }
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

/**
 * Download a URL and return { buffer, contentType }.
 * Follows redirects. Works with both http and https.
 */
function downloadUrl(urlStr: string): Promise<{ buffer: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === 'https:' ? https : http;
    mod.get(urlStr, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZempotisBot/1.0)' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        downloadUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode} for ${urlStr}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        buffer: Buffer.concat(chunks),
        contentType: (res.headers['content-type'] || 'image/png').split(';')[0].trim(),
      }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Find and download the site logo. Returns a base64 data URL, a plain URL
 * as fallback, or null if nothing is found.
 */
async function extractLogo(page: Page, origin: string): Promise<string | null> {
  // Find the logo URL in the page using prioritised heuristics.
  // Uses IIFE string form — no TypeScript, no const/let, plain var.
  const rawUrl: string | null = await page.evaluate(`(function() {
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
  })()`);

  if (!rawUrl) return null;

  // Resolve relative URLs against origin
  let absoluteUrl: string;
  try {
    absoluteUrl = new URL(rawUrl, origin).href;
  } catch {
    return rawUrl;
  }

  // Download and convert to base64 data URL
  try {
    const { buffer, contentType } = await downloadUrl(absoluteUrl);
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.warn('  Warning: could not download logo, using URL as fallback:', (err as Error).message);
    return absoluteUrl;
  }
}

// ── logo colour extraction ────────────────────────────────────────────────────

/**
 * Parse a PNG buffer and extract dominant brand colours.
 *
 * Strategy:
 *   - Find IDAT chunks, inflate them, interpret as RGBA scanlines
 *   - Sample every 4th pixel
 *   - Build colour frequency map
 *   - Filter near-white (L>85%), near-black (L<15%), transparent (alpha<128), grey (S<20%)
 *   - Return top 2 hex colours
 *
 * Falls back to a simpler byte-scan approach if full PNG parsing fails.
 */
function extractLogoColors(logoDataUrl: string): string[] | null {
  if (!logoDataUrl.startsWith('data:')) return null;

  const isPng = logoDataUrl.startsWith('data:image/png');

  // Decode base64 payload
  const commaIdx = logoDataUrl.indexOf(',');
  if (commaIdx === -1) return null;
  const b64 = logoDataUrl.slice(commaIdx + 1);
  const buf = Buffer.from(b64, 'base64');

  function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, Math.round(l * 100)];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let hh = 0;
    if (max === rn) hh = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) hh = ((bn - rn) / d + 2) / 6;
    else hh = ((rn - gn) / d + 4) / 6;
    return [Math.round(hh * 360), Math.round(s * 100), Math.round(l * 100)];
  }

  function toHex(r: number, g: number, b: number): string {
    return '#' + [r, g, b].map(v => Math.min(255, Math.round(v / 16) * 16).toString(16).padStart(2, '0')).join('');
  }

  function isUsableColor(r: number, g: number, b: number, a: number): boolean {
    if (a < 128) return false;
    const [, s, l] = rgbToHsl(r, g, b);
    return s > 20 && l > 15 && l < 85;
  }

  function buildColorMap(pixels: Array<[number, number, number, number]>): Map<string, number> {
    const map = new Map<string, number>();
    for (const [r, g, b, a] of pixels) {
      if (!isUsableColor(r, g, b, a)) continue;
      const key = toHex(r, g, b);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }

  function topColors(map: Map<string, number>): string[] {
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(e => e[0]);
  }

  if (isPng) {
    try {
      // Validate PNG signature: 8 bytes — 89 50 4E 47 0D 0A 1A 0A
      if (buf.length < 8 ||
          buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) {
        throw new Error('Not a valid PNG');
      }

      // Read PNG IHDR to get width, height, bitDepth, colorType
      // IHDR chunk starts at byte 8: [length(4)][type(4)][data(13)][crc(4)]
      const width  = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      const bitDepth  = buf[24];
      const colorType = buf[25];

      // Only handle 8-bit RGBA (colorType=6) and 8-bit RGB (colorType=2)
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`Unsupported PNG colorType=${colorType} bitDepth=${bitDepth}`);
      }

      const hasAlpha = colorType === 6;
      const channels = hasAlpha ? 4 : 3;

      // Collect all IDAT chunks and concatenate their compressed data
      const idatChunks: Buffer[] = [];
      let pos = 8;
      while (pos + 12 <= buf.length) {
        const chunkLen  = buf.readUInt32BE(pos);
        const chunkType = buf.slice(pos + 4, pos + 8).toString('ascii');
        if (chunkType === 'IDAT') {
          idatChunks.push(buf.slice(pos + 8, pos + 8 + chunkLen));
        }
        pos += 12 + chunkLen;
      }

      if (idatChunks.length === 0) throw new Error('No IDAT chunks found');

      const compressed = Buffer.concat(idatChunks);
      const raw = zlib.inflateSync(compressed);

      // Each scanline has a filter byte prefix
      const stride = width * channels;
      const pixels: Array<[number, number, number, number]> = [];

      for (let y = 0; y < height; y++) {
        const rowStart = y * (stride + 1);
        const filterType = raw[rowStart];
        const row = raw.slice(rowStart + 1, rowStart + 1 + stride);

        // Apply PNG filter reconstruction (simplified — handle Sub and None)
        const recon = Buffer.alloc(stride);
        for (let x = 0; x < stride; x++) {
          const a = x >= channels ? recon[x - channels] : 0;
          if (filterType === 1) {       // Sub
            recon[x] = (row[x] + a) & 0xff;
          } else if (filterType === 0) { // None
            recon[x] = row[x];
          } else {
            // For Up(2), Average(3), Paeth(4): best-effort — just use raw value
            recon[x] = row[x];
          }
        }

        // Sample every 4th pixel
        for (let x = 0; x < width; x += 4) {
          const off = x * channels;
          const r = recon[off];
          const g = recon[off + 1];
          const b = recon[off + 2];
          const a = hasAlpha ? recon[off + 3] : 255;
          pixels.push([r, g, b, a]);
        }
      }

      const map = buildColorMap(pixels);
      if (map.size === 0) return null;
      const colors = topColors(map);
      return colors.length > 0 ? colors : null;

    } catch (err) {
      console.warn('  Warning: full PNG parse failed, trying byte-scan fallback:', (err as Error).message);
      // Fall through to simpler approach below
    }
  }

  // Simpler fallback: scan raw bytes treating every 4 bytes as RGBA,
  // skipping the first 64 bytes (header area)
  try {
    const pixels: Array<[number, number, number, number]> = [];
    const start = Math.min(64, buf.length);
    const step = 16; // sample every 16 bytes
    for (let i = start; i + 3 < buf.length; i += step) {
      pixels.push([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]);
    }
    const map = buildColorMap(pixels);
    if (map.size === 0) return null;
    const colors = topColors(map);
    return colors.length > 0 ? colors : null;
  } catch {
    return null;
  }
}

// ── chunking ──────────────────────────────────────────────────────────────────
interface ContentChunk { heading: string; content: string }

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

  const browser: Browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
  });

  try {
    const page: Page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (compatible; ZempotisBot/1.0)');
    await page.setViewport({ width: 1280, height: 800 });

    let pageCount = 0;
    while (queue.length > 0 && pageCount < MAX_PAGES) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);
      pageCount++;

      process.stdout.write(`  [${pageCount}/${MAX_PAGES}] ${url} … `);

      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 20_000 });

        if (pageCount === 1) {
          clientName = await page.title().then(t => t.split('|')[0].split('-')[0].trim()) || clientId;

          const colours = await detectBrandColours(page);
          primaryColor = colours.primaryColor;
          accentColor  = colours.accentColor;

          // Logo extraction (display only — never overrides CSS-detected colours)
          logoUrl = await extractLogo(page, origin);
          console.log(`  🖼️  Logo: ${logoUrl ? 'found' : 'not found'}`);

          console.log(`  ✅ primaryColor: ${primaryColor}  accentColor: ${accentColor}`);
        }

        const { text, headings } = await extractContent(page);
        fullText += `\n\n=== ${url} ===\n${text}`;

        const chunks = splitIntoChunks(text, headings);
        allChunks = allChunks.concat(chunks);
        console.log(`${chunks.length} chunks`);

        const hrefs = await page.evaluate(
          `Array.from(document.querySelectorAll('a[href]')).map(function(a){ return a.href; })`
        ) as unknown as string[];
        for (const href of hrefs) {
          const norm = normaliseUrl(href, origin);
          if (norm && norm.startsWith(origin) && !visited.has(norm) && !queue.includes(norm)) {
            queue.push(norm);
          }
        }
      } catch (err) {
        console.log(`ERROR: ${(err as Error).message}`);
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
  const greeting    = `Hi! I'm the ${clientName} assistant. How can I help you today?`;
  const quickReplies = ['What services do you offer?','How do I get started?','What are your opening hours?'];

  // Store only the URL form of logoUrl in Supabase (data URLs can be very large)
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

scrape().catch(err => { console.error('Fatal:', err); process.exit(1); });
