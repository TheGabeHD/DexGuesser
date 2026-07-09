#!/usr/bin/env node
// Fetches Pokémon data from PokéAPI and bakes it into static JSON files that
// the website serves itself, so visitors never hit PokéAPI directly.
//
//   node scripts/build-data.mjs
//
// Outputs:
//   data/species.json       - [{ id, slug, name }] for the autocomplete list
//   data/entries/{id}.json  - unique, cleaned English Pokédex entries per species
//
// Only needs re-running when a new Pokémon generation is released.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://pokeapi.co/api/v2';
const CONCURRENCY = 8;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// API slugs whose display name isn't just "capitalize and swap hyphens for spaces"
const NAME_OVERRIDES = {
  'nidoran-f': 'Nidoran♀',
  'nidoran-m': 'Nidoran♂',
  'farfetchd': "Farfetch'd",
  'mr-mime': 'Mr. Mime',
  'ho-oh': 'Ho-Oh',
  'mime-jr': 'Mime Jr.',
  'porygon-z': 'Porygon-Z',
  'type-null': 'Type: Null',
  'jangmo-o': 'Jangmo-o',
  'hakamo-o': 'Hakamo-o',
  'kommo-o': 'Kommo-o',
  'sirfetchd': "Sirfetch'd",
  'mr-rime': 'Mr. Rime',
  'flabebe': 'Flabébé',
  'wo-chien': 'Wo-Chien',
  'chien-pao': 'Chien-Pao',
  'ting-lu': 'Ting-Lu',
  'chi-yu': 'Chi-Yu',
};

function displayName(slug) {
  if (NAME_OVERRIDES[slug]) return NAME_OVERRIDES[slug];
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Flavor text comes with hard line breaks (\n) and page breaks (\f) from the games
function cleanFlavorText(text) {
  return text
    .replace(/­\n/g, '')        // soft hyphen at line break
    .replace(/[\n\f\r]/g, ' ')
    .replace(/POKéMON/g, 'Pokémon')
    .replace(/\s+/g, ' ')
    .trim();
}

// Key used to treat near-identical entries (punctuation/case variants) as duplicates
function dedupeKey(text) {
  return text.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
}

async function fetchJson(url, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= tries) throw new Error(`${url}: ${err.message}`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

// Run tasks over items with a bounded number in flight at once
async function pool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }));
  return results;
}

const listData = await fetchJson(`${API}/pokemon-species?limit=10000`);
const species = listData.results.map(r => {
  const id = Number(r.url.match(/\/(\d+)\/?$/)[1]);
  return { id, slug: r.name, name: displayName(r.name) };
}).sort((a, b) => a.id - b.id);
console.log(`species list: ${species.length} Pokémon`);

await mkdir(path.join(ROOT, 'data', 'entries'), { recursive: true });
await writeFile(
  path.join(ROOT, 'data', 'species.json'),
  JSON.stringify(species)
);

let done = 0;
const missing = [];
await pool(species, async sp => {
  const detail = await fetchJson(`${API}/pokemon-species/${sp.id}`);
  const seen = new Set();
  const entries = [];
  for (const e of detail.flavor_text_entries) {
    if (e.language.name !== 'en') continue;
    const text = cleanFlavorText(e.flavor_text);
    const key = dedupeKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(text);
  }
  if (entries.length === 0) missing.push(sp.slug);
  await writeFile(
    path.join(ROOT, 'data', 'entries', `${sp.id}.json`),
    JSON.stringify(entries)
  );
  done++;
  if (done % 100 === 0) console.log(`entries: ${done}/${species.length}`);
}, CONCURRENCY);

console.log(`entries: ${done}/${species.length} written`);
if (missing.length) console.log(`WARNING - no English entries for: ${missing.join(', ')}`);
