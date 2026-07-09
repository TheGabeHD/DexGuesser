#!/usr/bin/env node
// Builds the static game data that the website serves, so visitors never hit
// any external API.
//
//   node scripts/build-data.mjs
//
// Sources:
//   PokéAPI    - species list, Pokédex entries for base Pokémon, form ids
//   Bulbapedia - Pokédex entries for Mega/Primal forms (PokéAPI has none)
//
// Every raw download is cached under raw/ (gitignored), so re-running this
// script makes zero network calls unless a file is missing. Delete raw/ (or
// a file in it) to force a refetch.
//
// Outputs:
//   data/species.json       - [{ id, slug, name, dex? }] for the autocomplete
//   data/entries/{id}.json  - unique, cleaned English Pokédex entries

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://pokeapi.co/api/v2';
const BULBA = 'https://bulbapedia.bulbagarden.net/w/index.php';
const USER_AGENT = 'DexGuesser-build/1.0 (personal hobby project)';
const CONCURRENCY = 8;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'raw');

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

// ---------------------------------------------------------------------------
// Fetching with a raw-file cache
// ---------------------------------------------------------------------------

async function fetchText(url, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt >= tries) throw new Error(`${url}: ${err.message}`);
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
}

let fetched = 0;
async function cached(relPath, url) {
  const file = path.join(RAW, relPath);
  try {
    return await readFile(file, 'utf8');
  } catch { /* not cached yet */ }
  const text = await fetchText(url);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  fetched++;
  return text;
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

// ---------------------------------------------------------------------------
// Text cleanup
// ---------------------------------------------------------------------------

// Flavor text comes with hard line breaks (\n) and page breaks (\f) from the games
function cleanFlavorText(text) {
  return text
    .replace(/­\n/g, '')        // soft hyphen at line break
    .replace(/[\n\f\r]/g, ' ')
    .replace(/POKéMON/g, 'Pokémon')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strip wiki markup from a Bulbapedia dex entry
function cleanWikiText(text) {
  let out = text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')                      // html tags like <sc>
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')  // [[link|label]] -> label
    .replace(/\[\[([^\]]*)\]\]/g, '$1');          // [[link]] -> link
  // Resolve templates innermost-first. {{tt|shown|tooltip}}-style templates
  // keep their first argument; link templates like {{p|Name|shown text}}
  // display their last; argless ones like {{fact}} render nothing.
  for (let i = 0; i < 5 && out.includes('{{'); i++) {
    out = out.replace(/\{\{([^{}]*)\}\}/g, (_, inner) => {
      const parts = inner.split('|').map(s => s.trim());
      if (parts.length === 1) return '';
      if (['tt', 'obp', 'scpkmn', 'scball'].includes(parts[0].toLowerCase())) return parts[1];
      return parts[parts.length - 1];
    });
  }
  return out
    .replace(/''+/g, '')                          // bold/italic quotes
    .replace(/\s+/g, ' ')
    .trim();
}

// Key used to treat near-identical entries (punctuation/case variants) as duplicates
function dedupeKey(text) {
  return text.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
}

function dedupe(texts) {
  const seen = new Set();
  const out = [];
  for (const t of texts) {
    if (!t) continue;
    const key = dedupeKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bulbapedia Pokédex-entry parsing
// ---------------------------------------------------------------------------

// Returns Map(formLabel -> [entry texts]) from a species page's wikitext.
// The base form's label is '' (entries before any {{Dex/Form|...}} marker);
// each {{Dex/Gen...}} header starts a new game-generation block and resets
// the current form back to the base.
function parseDexEntries(wikitext) {
  const section = wikitext.match(/\n={3,4}(?:\[\[)?Pok[ée]dex(?:\]\])? entries={3,4} *\n([\s\S]*?)(?:\n={3,4}[^=]|$)/);
  if (!section) return new Map();

  const byForm = new Map();
  let form = '';
  for (const line of section[1].split('\n')) {
    if (/^\{\{Dex\/Gen/.test(line)) {
      form = '';
    } else if (/^\{\{Dex\/Form\|/.test(line)) {
      form = line.match(/^\{\{Dex\/Form\|([^}|]+)/)[1].trim();
    } else {
      const entry = line.match(/^\{\{Dex\/Entry\d[^]*?\|entry=([^]*?)\}\}\s*$/);
      if (entry) {
        if (!byForm.has(form)) byForm.set(form, []);
        byForm.get(form).push(cleanWikiText(entry[1]));
      }
    }
  }
  return byForm;
}

// ---------------------------------------------------------------------------
// 1. Base species from PokéAPI
// ---------------------------------------------------------------------------

const listData = JSON.parse(await cached(
  'pokeapi/species-list.json', `${API}/pokemon-species?limit=10000`));
const species = listData.results.map(r => {
  const id = Number(r.url.match(/\/(\d+)\/?$/)[1]);
  return { id, slug: r.name, name: displayName(r.name) };
}).sort((a, b) => a.id - b.id);
console.log(`base species: ${species.length}`);

await mkdir(path.join(ROOT, 'data', 'entries'), { recursive: true });

// ---------------------------------------------------------------------------
// 2. Special forms (Mega/Primal/Gigantamax/regional): ids from PokéAPI,
//    entries from Bulbapedia
// ---------------------------------------------------------------------------

const pokemonList = JSON.parse(await cached(
  'pokeapi/pokemon-list.json', `${API}/pokemon?limit=10000`));
const bySlug = new Map(species.map(s => [s.slug, s]));

// A form slug like "charizard-mega-x" or "meowstic-male-mega" -> base species
function baseOf(formSlug) {
  const parts = formSlug.split('-');
  while (parts.length) {
    const base = bySlug.get(parts.join('-'));
    if (base) return base;
    parts.pop();
  }
  return null;
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

const REGIONS = { alola: 'Alolan', galar: 'Galarian', hisui: 'Hisuian', paldea: 'Paldean' };

// Display name for the form plus the {{Dex/Form|...}} labels Bulbapedia might
// use for it, in order of preference. Middle slug tokens like male/curly/
// original are cosmetic sub-variants that share one set of entries; they
// resolve to the same display name and collapse below. Urshifu's two styles
// have distinct Gigantamax entries and stay separate via the style label.
// Regional forms get `regional: true` so their entry texts can be subtracted
// from the base Pokémon's pool (PokéAPI mixes them together).
function formMeta(formSlug, base) {
  if (formSlug.endsWith('-primal')) {
    return { name: `Primal ${base.name}`,
             labels: [`Primal ${base.name}`, 'Primal Reversion'] };
  }
  const rm = formSlug.match(/-(alola|galar|hisui|paldea)(?:-(.+))?$/);
  if (rm) {
    const adj = REGIONS[rm[1]];
    const mid = rm[2] ? rm[2].split('-').map(cap).join(' ') : ''; // 'Combat Breed', 'Standard', 'Zen'
    let name = `${adj} ${base.name}`;
    const labels = [];
    if (mid === 'Standard') {
      labels.push(`${adj} Form`);                     // Galarian Darmanitan
    } else if (mid === 'Zen') {
      name += ' (Zen Mode)';
      labels.push(`${adj} Form/Zen Mode`);
    } else if (mid) {
      name += ` (${mid})`;                            // Paldean Tauros breeds
      labels.push(`${adj} Form (${mid})`);
    } else {
      labels.push(`${adj} Form`, `${adj} ${base.name}`);
    }
    return { name, labels, regional: true };
  }
  if (formSlug.endsWith('-gmax')) {
    // Tokens between the base slug and '-gmax', e.g. 'single-strike' or ''
    const mid = formSlug.slice(base.slug.length + 1, -5);
    const labels = [];
    if (mid) labels.push(`${mid.split('-').map(cap).join(' ')} Style / Gigantamax`);
    labels.push(`Gigantamax ${base.name}`, 'Gigantamax');
    return { name: `Gigantamax ${base.name}`, labels };
  }
  const suffix = formSlug.match(/-mega-([a-z])$/);
  const name = `Mega ${base.name}${suffix ? ' ' + suffix[1].toUpperCase() : ''}`;
  return { name, labels: [name] };
}

const forms = pokemonList.results
  .filter(p => /-mega(-[a-z]+)?$|-primal$|-gmax$|-(alola|galar|hisui|paldea)(-[a-z]+)*$/.test(p.name)
            && !p.name.endsWith('-cap')) // costume Pikachu, not a regional form
  .map(p => ({ slug: p.name, id: Number(p.url.match(/\/(\d+)\/?$/)[1]) }))
  .sort((a, b) => a.id - b.id);
const known = [];
for (const f of forms) {
  f.base = baseOf(f.slug);
  if (f.base) known.push(f);
  else console.log(`WARNING - no base species for form ${f.slug}`);
}
console.log(`special forms: ${known.length}`);

// Fetch each involved base species' Bulbapedia page (cached; polite concurrency)
const formBases = [...new Map(known.map(f => [f.base.slug, f.base])).values()];
const wikitexts = new Map();
await pool(formBases, async base => {
  const title = base.name.replace(/ /g, '_') + '_(Pokémon)';
  const text = await cached(
    `bulbapedia/${base.slug}.wiki`, `${BULBA}?title=${encodeURIComponent(title)}&action=raw`);
  wikitexts.set(base.slug, text);
}, 2);
console.log(`bulbapedia pages: ${formBases.length}`);

const formSpecies = [];
const taken = new Set();
const unmatched = [];
const regionalKeys = new Map(); // base species id -> Set of entry dedupe keys
for (const form of known) {
  const byForm = parseDexEntries(wikitexts.get(form.base.slug));
  const meta = formMeta(form.slug, form.base);
  let name = meta.name;
  let texts = [];
  for (const label of meta.labels) {
    texts = byForm.get(label) ?? [];
    // Sub-form variants like "Mega Tatsugiri (Curly Form)" share one Pokémon
    if (!texts.length) {
      texts = [...byForm.entries()]
        .filter(([k]) => k.startsWith(label + ' ('))
        .flatMap(([, v]) => v);
    }
    if (texts.length) {
      // A style-specific match like "Single Strike Style / Gigantamax" means
      // this style is its own Pokémon with its own entries
      if (label.includes(' / Gigantamax')) {
        name = `Gigantamax ${form.base.name} (${label.split(' / ')[0]})`;
      }
      break;
    }
  }
  const entries = dedupe(texts);
  if (entries.length === 0) {
    unmatched.push(`${form.slug} (forms on page: ${[...byForm.keys()].filter(Boolean).join(', ') || 'none'})`);
    continue;
  }
  // Remember regional entry texts so they can be removed from the base
  // Pokémon's pool (PokéAPI attaches them to the base species)
  if (meta.regional) {
    let set = regionalKeys.get(form.base.id);
    if (!set) regionalKeys.set(form.base.id, set = new Set());
    for (const t of entries) set.add(dedupeKey(t));
  }
  if (taken.has(name)) continue; // e.g. both Toxtricity modes share one Gigantamax
  taken.add(name);
  await writeFile(
    path.join(ROOT, 'data', 'entries', `${form.id}.json`), JSON.stringify(entries));
  formSpecies.push({ id: form.id, slug: form.slug, name, dex: form.base.id });
}
formSpecies.sort((a, b) => a.dex - b.dex || a.id - b.id);
console.log(`special forms with entries: ${formSpecies.length}`);
if (unmatched.length) {
  console.log(`WARNING - no Bulbapedia entries matched for ${unmatched.length} forms:`);
  for (const u of unmatched) console.log(`  ${u}`);
}

// ---------------------------------------------------------------------------
// 3. Base-species entries from PokéAPI, minus regional-form texts
// ---------------------------------------------------------------------------

let done = 0;
let subtracted = 0;
const noEntries = [];
await pool(species, async sp => {
  const detail = JSON.parse(await cached(
    `pokeapi/species/${sp.id}.json`, `${API}/pokemon-species/${sp.id}`));
  let entries = dedupe(detail.flavor_text_entries
    .filter(e => e.language.name === 'en')
    .map(e => cleanFlavorText(e.flavor_text)));
  const regional = regionalKeys.get(sp.id);
  if (regional) {
    const before = entries.length;
    entries = entries.filter(t => !regional.has(dedupeKey(t)));
    subtracted += before - entries.length;
  }
  if (entries.length === 0) noEntries.push(sp.slug);
  await writeFile(
    path.join(ROOT, 'data', 'entries', `${sp.id}.json`), JSON.stringify(entries));
  if (++done % 200 === 0) console.log(`base entries: ${done}/${species.length}`);
}, CONCURRENCY);
console.log(`base entries: ${done}/${species.length} written`);
console.log(`regional entries subtracted from base pools: ${subtracted}`);
if (noEntries.length) console.log(`WARNING - no English entries for: ${noEntries.join(', ')}`);

// ---------------------------------------------------------------------------
// 4. Combined species list
// ---------------------------------------------------------------------------

await writeFile(
  path.join(ROOT, 'data', 'species.json'),
  JSON.stringify([...species, ...formSpecies]));
console.log(`species.json: ${species.length} base + ${formSpecies.length} special forms`);
console.log(`network requests this run: ${fetched}`);
