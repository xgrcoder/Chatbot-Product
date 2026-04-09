import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

/**
 * Zempotis Chat — Premium Client Scraper
 *
 * Usage:
 *   npx tsx scripts/scrapeClient.ts <clientId> <url>
 *
 * Example:
 *   npx tsx scripts/scrapeClient.ts acme-gym https://www.acmegym.com
 *
 * What it does:
 *   1. Crawls up to 30 pages with Puppeteer (same-origin only)
 *   2. Extracts headings + body text; detects brand colours
 *   3. Splits content into fine-grained chunks on every h1-h4 boundary
 *      (targeting 50+ chunks per site)
 *   4. Generates 384-dim embeddings via Xenova/all-MiniLM-L6-v2
 *   5. Uploads all chunks to Supabase client_embeddings table
 *   6. Saves a client config JSON to data/clients/{clientId}.json
 *   7. Prints the embed code snippet
 */

import puppeteer, { Browser, Page } from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import { pipeline } from '@xenova/transformers';
import * as fs from 'fs';
import * as path from 'path';

// ── env ─────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your environment.');
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
const MAX_CHUNK_WORDS = 250; // soft limit; chunks split on heading boundaries

// ── helpers ──────────────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Singleton embedding pipeline
let embedPipeline: Awaited<ReturnType<typeof pipeline>> | null = null;
async function getEmbedder() {
  if (!embedPipeline) {
    console.log('⚙️  Loading embedding model (one-time download)…');
    embedPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log('✅ Embedding model ready');
  }
  return embedPipeline;
}

async function embedText(text: string): Promise<number[]> {
  const pipe = await getEmbedder();
  const out = await pipe([text], { pooling: 'mean', normalize: true });
  return Array.from((out as { data: Float32Array }[])[0].data);
}

/** Normalise a URL to strip fragments + trailing slashes */
function normaliseUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    u.hash = '';
    if (u.pathname !== '/' && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.href;
  } catch {
    return null;
  }
}

/** Extract visible text with heading structure from a page */
async function extractContent(page: Page): Promise<{ text: string; headings: string[]; rawHtml: string }> {
  return page.evaluate(() => {
    // Remove noise elements
    const noiseSelectors = [
      'script', 'style', 'noscript', 'iframe', 'nav', 'footer',
      'header', '.cookie-banner', '#cookie-banner', '[aria-hidden="true"]',
    ];
    noiseSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => el.remove());
    });

    const headings: string[] = [];
    document.querySelectorAll('h1,h2,h3,h4').forEach(h => {
      const t = (h as HTMLElement).innerText?.trim();
      if (t) headings.push(t);
    });

    const rawText = (document.body as HTMLElement).innerText ?? '';
    return { text: rawText, headings, rawHtml: document.body.innerHTML.slice(0, 5000) };
  });
}

interface ContentChunk {
  heading: string;
  content: string;
}

/**
 * Split page text into chunks at h1–h4 boundary markers.
 * If a chunk is too long it is further split on paragraph breaks.
 */
function splitIntoChunks(text: string, headings: string[]): ContentChunk[] {
  const chunks: ContentChunk[] = [];

  // Build a regex that matches any heading line
  const escapedHeadings = headings
    .filter(h => h.length > 3)
    .map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  let currentHeading = '';
  let currentLines: string[] = [];

  const flushChunk = () => {
    const content = currentLines.join(' ').trim();
    if (content.length > 40) {
      // Further split long chunks on paragraph-sized boundaries
      const words = content.split(/\s+/);
      for (let i = 0; i < words.length; i += MAX_CHUNK_WORDS) {
        const slice = words.slice(i, i + MAX_CHUNK_WORDS).join(' ');
        if (slice.length > 40) {
          chunks.push({ heading: currentHeading, content: slice });
        }
      }
    }
    currentLines = [];
  };

  for (const line of lines) {
    const isHeading =
      escapedHeadings.length > 0 &&
      escapedHeadings.some(h => new RegExp(`^${h}$`, 'i').test(line));

    if (isHeading) {
      flushChunk();
      currentHeading = line;
    } else {
      currentLines.push(line);
    }
  }
  flushChunk();

  // Guarantee at least one chunk even if no headings matched
  if (chunks.length === 0 && text.trim().length > 40) {
    const words = text.split(/\s+/);
    for (let i = 0; i < words.length; i += MAX_CHUNK_WORDS) {
      const slice = words.slice(i, i + MAX_CHUNK_WORDS).join(' ');
      if (slice.length > 40) chunks.push({ heading: '', content: slice });
    }
  }

  return chunks;
}

/** Detect the dominant brand colour from CSS custom properties or computed styles */
async function detectBrandColours(page: Page): Promise<{ primaryColor: string; accentColor: string }> {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);

    // Check common CSS variable conventions
    const varCandidates = [
      '--primary-color', '--color-primary', '--brand-color',
      '--accent-color', '--color-accent', '--theme-color',
      '--primary', '--accent',
    ];

    let primary = '';
    let accent = '';

    for (const v of varCandidates) {
      const val = style.getPropertyValue(v).trim();
      if (val && val !== 'transparent' && val !== 'inherit') {
        if (!primary) primary = val;
        else if (!accent) accent = val;
      }
      if (primary && accent) break;
    }

    // Fallback: sample the background colour of prominent CTA buttons
    if (!primary) {
      const btn = document.querySelector('a.btn, button.btn, .btn-primary, [class*="cta"]') as HTMLElement;
      if (btn) {
        primary = getComputedStyle(btn).backgroundColor;
      }
    }

    // Final fallback colours
    if (!primary || primary === 'rgba(0, 0, 0, 0)') primary = '#2563eb';
    if (!accent || accent === 'rgba(0, 0, 0, 0)') accent = '#7c3aed';

    return { primaryColor: primary, accentColor: accent };
  });
}

/** Convert an rgb/rgba string to a CSS hex if needed */
function toHex(colour: string): string {
  const m = colour.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return colour;
  const r = parseInt(m[1]).toString(16).padStart(2, '0');
  const g = parseInt(m[2]).toString(16).padStart(2, '0');
  const b = parseInt(m[3]).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

// ── main ──────────────────────────────────────────────────────────────────────
async function scrape() {
  console.log(`\n🕷️  Starting premium scrape for client "${clientId}" → ${startUrl}\n`);

  const origin = new URL(startUrl).origin;
  const visited = new Set<string>();
  const queue: string[] = [normaliseUrl(startUrl, startUrl)!];

  let allChunks: ContentChunk[] = [];
  let fullText = '';
  let clientName = clientId;
  let primaryColor = '#2563eb';
  let accentColor = '#7c3aed';

  const browser: Browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page: Page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (compatible; ZempotisBot/1.0; +https://chat.zempotis.com/bot)'
    );
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

        // Grab page title for client name (use first page)
        if (pageCount === 1) {
          clientName = await page.title().then(t => t.split('|')[0].split('-')[0].trim()) || clientId;
          const colours = await detectBrandColours(page);
          primaryColor = toHex(colours.primaryColor);
          accentColor = toHex(colours.accentColor);
        }

        const { text, headings } = await extractContent(page);
        fullText += `\n\n=== ${url} ===\n${text}`;

        const chunks = splitIntoChunks(text, headings);
        allChunks = allChunks.concat(chunks);
        console.log(`${chunks.length} chunks`);

        // Discover new same-origin links
        const hrefs: string[] = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]')).map(
            a => (a as HTMLAnchorElement).href
          )
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

  console.log(`\n📊 Scraped ${visited.size} pages, extracted ${allChunks.length} chunks`);

  // ── Deduplication ──────────────────────────────────────────────────────────
  const seen = new Set<string>();
  const uniqueChunks = allChunks.filter(c => {
    const key = c.content.slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`📌 ${uniqueChunks.length} unique chunks after deduplication`);

  // ── Embeddings + Supabase upload ──────────────────────────────────────────
  console.log('\n🔢 Generating embeddings and uploading to Supabase…');

  // Clear any existing chunks for this client
  const { error: deleteErr } = await supabase
    .from('client_embeddings')
    .delete()
    .eq('client_id', clientId);
  if (deleteErr) console.warn('  Warning (delete):', deleteErr.message);

  const BATCH = 10;
  let uploaded = 0;

  for (let i = 0; i < uniqueChunks.length; i += BATCH) {
    const batch = uniqueChunks.slice(i, i + BATCH);

    const rows = await Promise.all(
      batch.map(async c => ({
        client_id: clientId,
        heading: c.heading,
        content: c.content,
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

  console.log(`\n✅ Uploaded ${uploaded} chunks to Supabase`);

  // ── Build client config ───────────────────────────────────────────────────
  const greeting = `Hi! I'm the ${clientName} assistant. How can I help you today?`;
  const quickReplies = [
    'What services do you offer?',
    'How do I get started?',
    'What are your opening hours?',
  ];

  const clientConfig = {
    clientId,
    name: clientName,
    url: startUrl,
    primaryColor,
    accentColor,
    greeting,
    quickReplies,
    content: fullText.slice(0, 100_000), // fallback content (capped at 100k chars)
    scrapedAt: new Date().toISOString(),
    chunkCount: uploaded,
  };

  // Save JSON to public/clients/
  const outDir = path.resolve(process.cwd(), 'public', 'clients');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${clientId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(clientConfig, null, 2), 'utf-8');
  console.log(`💾 Client config saved → ${outPath}`);

  // Register client in lib/clientRegistry.ts so it is bundled by Vercel
  registerInClientRegistry(clientId);

  // ── Embed code ────────────────────────────────────────────────────────────
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ Done! Add this embed code to your client's site:

<script src="https://zempotis-chat.vercel.app/widget.js" data-client="${clientId}" async></script>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

/**
 * Update lib/clientRegistry.ts to include the new client.
 * This ensures the config is bundled by Turbopack and always available on Vercel.
 */
function registerInClientRegistry(id: string) {
  const registryPath = path.resolve(process.cwd(), 'lib', 'clientRegistry.ts');
  let source = fs.readFileSync(registryPath, 'utf-8');

  // Add import if not already present
  const importLine = `import ${camelCase(id)} from '../public/clients/${id}.json';`;
  if (!source.includes(importLine)) {
    // Insert after the last existing import line
    source = source.replace(
      /(import .+ from '.+\.json';)\n/,
      `$1\n${importLine}\n`
    );
  }

  // Add entry to registry object if not already present
  const registryEntry = `  '${id}': ${camelCase(id)} as ClientConfig,`;
  if (!source.includes(registryEntry)) {
    source = source.replace(
      /(const registry: Record<string, ClientConfig> = \{)/,
      `$1\n${registryEntry}`
    );
  }

  fs.writeFileSync(registryPath, source, 'utf-8');
  console.log(`📋 Registered "${id}" in lib/clientRegistry.ts`);
}

function camelCase(str: string): string {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

scrape().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
