#!/usr/bin/env node
// Checks every entry in urls.json, follows redirects, and rewrites the file
// when a provider has moved to a new domain or changed liveness.
//
// Run locally with:  node scripts/check-urls.mjs            (writes urls.json)
//                    node scripts/check-urls.mjs --dry-run  (reports only)
//
// No dependencies: Node 20+ has fetch built in.

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'urls.json');

const DRY_RUN = process.argv.includes('--dry-run');
const CONCURRENCY = 6;
const TIMEOUT_MS = 25_000;
const ATTEMPTS = 2;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Paths/hosts that mean "this domain is gone", not "this is the new home".
const PARKED = /suspendedpage|sedoparking|parkingcrew|bodis\.com|afternic|namecheap\.com\/parked/i;

// A dropped domain often ends up redirecting to a search engine or a registrar.
// Never follow one of those into urls.json.
const HOSTILE = [
  'google.', 'bing.com', 'yahoo.com', 'duckduckgo.com', 'baidu.com',
  'godaddy.com', 'sedo.com', 'namecheap.com', 'dan.com', 'hugedomains.com',
  'cloudflare.com', 'facebook.com', 'youtube.com', 't.me', 'telegram.',
];

// Tokens that carry no identity, so they must not be what makes two hosts look
// related: `new5.movies4u.clinic` and `www.google.com` share nothing real.
const NOISE = new Set(['www', 'new', 'the', 'site', 'online', 'official', 'home', 'watch']);

// Cloudflare and friends answer with these when they dislike a datacentre IP.
// They prove nothing about the site, so entries that return them are left alone.
const INCONCLUSIVE = new Set([401, 403, 405, 406, 429, 503, 520, 521, 522, 523, 524]);

/** https://a.b/c?d -> https://a.b  (the shape stored in urls.json) */
function origin(u) {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

function host(u) {
  try {
    return new URL(u).host.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Identity tokens of a host: labels minus the TLD, split and de-numbered. */
function tokens(h) {
  if (!h) return new Set();
  const out = new Set();
  for (const label of h.split('.').slice(0, -1)) {
    for (const t of label.split(/[^a-z0-9]+/i)) {
      const clean = t.toLowerCase().replace(/[0-9]+$/, '');
      if (clean.length >= 4 && !NOISE.has(clean)) out.add(clean);
    }
  }
  return out;
}

/**
 * A real domain move keeps the brand: `vegamovies.catering` -> `new2.vegamovies.futbol`,
 * `yify-official.cc` -> `yify-yify.com`. A dropped domain does not. Only accept a
 * redirect whose destination still shares an identity token with the old host or
 * with the provider's internalName.
 *
 * This is the guard the upstream checker lacks, and why its manifest ended up
 * carrying `"movies4u": "https://www.google.com"`.
 */
function looksRelated(oldHost, newHost, internalName) {
  if (HOSTILE.some((h) => newHost.includes(h))) return false;
  const target = tokens(newHost);
  for (const t of tokens(oldHost)) {
    for (const u of target) {
      if (t === u || t.includes(u) || u.includes(t)) return true;
    }
  }
  const key = internalName.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/[0-9]+$/, '');
  if (key.length >= 4) {
    for (const u of target) {
      if (key.includes(u) || u.includes(key)) return true;
    }
  }
  return false;
}

async function probeOnce(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    // Drain the body so the connection closes cleanly.
    await res.text().catch(() => '');
    return { status: res.status, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

/** -> { verdict: 'alive' | 'dead' | 'unknown', finalUrl, status } */
async function probe(url) {
  let lastError = null;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const { status, finalUrl } = await probeOnce(url);
      if (PARKED.test(finalUrl)) return { verdict: 'dead', finalUrl, status };
      if (status >= 200 && status < 400) return { verdict: 'alive', finalUrl, status };
      if (INCONCLUSIVE.has(status)) return { verdict: 'unknown', finalUrl, status };
      return { verdict: 'dead', finalUrl, status };
    } catch (err) {
      lastError = err;
      if (i < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return { verdict: 'dead', finalUrl: url, status: 0, error: String(lastError) };
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

const entries = JSON.parse(await readFile(FILE, 'utf8'));
if (!Array.isArray(entries)) throw new Error('urls.json must be a JSON array');

const changes = [];
const PAD = 24;

await mapLimit(entries, CONCURRENCY, async (entry) => {
  const current = entry.url;
  const { verdict, finalUrl, status } = await probe(current);

  if (verdict === 'unknown') {
    console.log(`? ${entry.internalName.padEnd(PAD)} ${status} inconclusive  ${current}`);
    return;
  }

  if (verdict === 'alive') {
    const from = host(current);
    const to = host(finalUrl);
    const newUrl = origin(finalUrl);

    if (from && to && to !== from && newUrl) {
      if (looksRelated(from, to, entry.internalName)) {
        changes.push(`${entry.internalName}: ${current} -> ${newUrl}`);
        entry.url = newUrl;
        entry.version = (Number(entry.version) || 1) + 1;
        entry.status = 1;
        console.log(`> ${entry.internalName.padEnd(PAD)} moved to ${newUrl}`);
      } else {
        // Redirected off-brand: the domain was almost certainly dropped. Keep the
        // stored url so a human can still see what it used to be.
        console.log(`! ${entry.internalName.padEnd(PAD)} off-brand redirect to ${newUrl}`);
        if (entry.status !== 0) {
          changes.push(`${entry.internalName}: status 1 -> 0 (off-brand redirect to ${to})`);
          entry.status = 0;
        }
      }
      return;
    }

    console.log(`= ${entry.internalName.padEnd(PAD)} ${status} ok`);
    if (entry.status !== 1) {
      changes.push(`${entry.internalName}: status 0 -> 1`);
      entry.status = 1;
    }
    return;
  }

  console.log(`x ${entry.internalName.padEnd(PAD)} ${status} down  ${current}`);
  if (entry.status !== 0) {
    changes.push(`${entry.internalName}: status 1 -> 0`);
    entry.status = 0;
  }
});

// Re-emit with a stable key order so diffs stay readable.
const normalized = entries.map((e) => ({
  url: e.url,
  status: e.status,
  version: e.version,
  name: e.name,
  internalName: e.internalName,
}));

console.log(`\n${changes.length} change(s)`);
for (const c of changes) console.log(`  - ${c}`);

if (changes.length && !DRY_RUN) {
  await writeFile(FILE, JSON.stringify(normalized, null, 2) + '\n');
}

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `changed=${changes.length > 0}\n`);
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `summary=${changes.slice(0, 10).join('; ') || 'no changes'}\n`,
  );
}
