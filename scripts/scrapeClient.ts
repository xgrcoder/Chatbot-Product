import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

/**
 * Zempotis Chat — Premium Client Scraper v2.0
 *
 * Usage:
 *   npx tsx scripts/scrapeClient.ts <clientId> <url>
 *
 * Example:
 *   npx tsx scripts/scrapeClient.ts organic-trust https://www.organictrust.co.uk
 *
 * What it does:
 *   1. Crawls up to 30 pages with Puppeteer (same-origin only)
 *   2. Extracts headings + body text
 *   3. Advanced colour detection:
 *      - meta theme-color tag
 *      - CSS custom properties from :root
 *      - Computed styles from buttons, CTAs, nav, hero, headings, links
 *      - Frequency-ranked with near-white/near-black/grey filtering
 *   4. Splits content into chunks and generates 384-dim embeddings
 *   5. Uploads chunks to Supabase client_embeddings table
 *   6. Upserts client config to Supabase clients table
 *   7. Saves a local JSON backup to public/clients/{clientId}.json
 *   8. Prints the embed code snippet
 */

import puppeteer, { Browser, Page } from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import { pipeline } from '@xenova/transformers';
import * as fs from 'fs';
import * as path from 'path';

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
  return page.evaluate(() => {
    ['script','style','noscript','iframe','nav','footer','header',
     '.cookie-banner','#cookie-banner','[aria-hidden="true"]'].forEach(sel => {
      document.querySelectorAll(sel).forEach(el => el.remove());
    });
    const headings: string[] = [];
    document.querySelectorAll('h1,h2,h3,h4').forEach(h => {
      const t = (h as HTMLElement).innerText?.trim();
      if (t) headings.push(t);
    });
    return { text: (document.body as HTMLElement).innerText ?? '', headings };
  });
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
  const entries: ColourEntry[] = await page.evaluate((): ColourEntry[] => {
    // ── colour math helpers ──────────────────────────────────────────────────
    function parseRgb(str: string): [number, number, number] | null {
      if (!str) return null;
      const m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (m) {
        // ignore fully transparent
        const aMatch = str.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)/);
        if (aMatch && parseFloat(aMatch[1]) === 0) return null;
        return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
      }
      let h = str.trim().replace(/^#/, '');
      if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
      if (/^[0-9a-fA-F]{6}$/.test(h)) {
        return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
      }
      return null;
    }

    function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r,g,b), min = Math.min(r,g,b);
      const l = (max + min) / 2;
      if (max === min) return [0, 0, Math.round(l * 100)];
      const d = max - min;
      const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      let h = 0;
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
      return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
    }

    function isUsable(r: number, g: number, b: number): boolean {
      const [, s, l] = rgbToHsl(r, g, b);
      return s > 15 && l > 10 && l < 90;
    }

    // Snap each channel to nearest 32 to group near-identical shades
    function bucketHex(r: number, g: number, b: number): string {
      const snap = (v: number) => Math.min(255, Math.round(v / 32) * 32);
      return '#' + [snap(r), snap(g), snap(b)]
        .map(x => x.toString(16).padStart(2,'0')).join('');
    }

    const counts = new Map<string, number>();
    function add(str: string, weight: number) {
      if (!str || str === 'transparent' || str === 'inherit' || str === 'currentcolor') return;
      const rgb = parseRgb(str);
      if (!rgb || !isUsable(...rgb)) return;
      const key = bucketHex(...rgb);
      counts.set(key, (counts.get(key) ?? 0) + weight);
    }

    // 1. meta theme-color
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) add(meta.getAttribute('content') ?? '', 20);

    // 2. :root CSS custom properties
    const root = getComputedStyle(document.documentElement);
    [
      '--primary','--primary-color','--color-primary','--brand-color','--brand-primary',
      '--accent','--accent-color','--color-accent','--color-brand','--color-link',
      '--theme-color','--color-theme','--highlight-color','--link-color',
      '--wp--preset--color--primary','--wp--preset--color--secondary',
    ].forEach(v => add(root.getPropertyValue(v).trim(), 10));

    // 3. Buttons and CTAs — most reliable brand signal
    document.querySelectorAll(
      'button:not([disabled]), [type="submit"], .btn, [class*="btn-primary"], ' +
      '[class*="cta"], a[class*="button"], [class*="Button"]'
    ).forEach(el => {
      const s = getComputedStyle(el as HTMLElement);
      add(s.backgroundColor, 8);
    });

    // 4. Navigation / header
    ['nav','header','[role="navigation"]','.navbar','#navbar','.header','#header',
     '[class*="navbar"]','[class*="nav-"]'].forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        const s = getComputedStyle(el as HTMLElement);
        add(s.backgroundColor, 6);
        add(s.borderBottomColor, 3);
        add(s.color, 2);
      });
    });

    // 5. Hero / banner
    ['.hero','#hero','[class*="hero"]','[class*="banner"]',
     '[class*="jumbotron"]','main > section:first-child','section:first-of-type'].forEach(sel => {
      const el = document.querySelector(sel);
      if (el) add(getComputedStyle(el as HTMLElement).backgroundColor, 5);
    });

    // 6. Link colours
    document.querySelectorAll('a').forEach(el => {
      add(getComputedStyle(el).color, 4);
    });

    // 7. Heading colours
    document.querySelectorAll('h1, h2').forEach(el => {
      add(getComputedStyle(el as HTMLElement).color, 3);
    });

    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([hex, weight]) => ({ hex, weight }));
  });

  console.log('  🎨 Colour candidates:', entries.map(e => `${e.hex}(${e.weight})`).join(', '));

  const primaryColor = entries[0]?.hex ?? '#2563eb';
  const accentColor  = entries[1]?.hex ?? '#7c3aed';
  return { primaryColor, accentColor };
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
          console.log(`  ✅ primaryColor: ${primaryColor}  accentColor: ${accentColor}`);
        }

        const { text, headings } = await extractContent(page);
        fullText += `\n\n=== ${url} ===\n${text}`;

        const chunks = splitIntoChunks(text, headings);
        allChunks = allChunks.concat(chunks);
        console.log(`${chunks.length} chunks`);

        const hrefs: string[] = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]')).map(a => (a as HTMLAnchorElement).href)
        );
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

  const { error: upsertErr } = await supabase
    .from('clients')
    .upsert({
      client_id:     clientId,
      name:          clientName,
      url:           startUrl,
      primary_color: primaryColor,
      accent_color:  accentColor,
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
    primaryColor, accentColor, greeting, quickReplies,
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
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

scrape().catch(err => { console.error('Fatal:', err); process.exit(1); });
