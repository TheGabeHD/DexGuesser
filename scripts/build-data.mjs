#!/usr/bin/env node
// Builds the static game data that the website serves, so visitors never hit
// any external API. Everything comes from Bulbapedia:
//
//   node scripts/build-data.mjs
//
// Sources (all cached under raw/, zero network once warm):
//   raw/bulbapedia/_ndex.wiki   - National Pokédex list (species names + numbers)
//   raw/bulbapedia/{slug}.wiki  - each species' page ("Pokédex entries" section)
//
// Answer rules:
//   - every species is one answer
//   - Mega / Primal / Gigantamax / regional (Alolan/Galarian/Hisuian/Paldean)
//     forms are separate answers, ONE per name (sub-variants pool together:
//     one Gigantamax Urshifu, one Mega Tatsugiri, one Paldean Tauros)
//   - every other form's entries merge into the species' base answer, unless
//     its ALT_FORMS row below is flipped to separate: true
//   - everything Bulbapedia files under "Pokédex entries" counts (Stadium,
//     Pokopia, ...); multi-game Stadium 2 lines are split into their parts
//
// Outputs:
//   data/species.json        - [{ id, name, dex }] (id is also the file key)
//   data/entries/{id}.json   - unique, cleaned entries per answer
//   data/artwork.json        - id -> candidate Bulbagarden Archives filenames
//                              (consumed by scripts/fetch-artwork.mjs)

import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BULBA = 'https://bulbapedia.bulbagarden.net/w/index.php';
const USER_AGENT = 'DexGuesser-build/1.0 (personal hobby project)';
const CONCURRENCY = 3;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'raw');

// ---------------------------------------------------------------------------
// Alternate forms (beyond Mega/Primal/Gigantamax/regional, which are always
// their own answers). Every {{Dex/Form}} label Bulbapedia uses is listed so
// each species can be reviewed later:
//   separate: false -> the form's entries merge into the species' base answer
//   separate: true  -> the form becomes its own guessable answer named `name`
// To promote a form: flip its flag, run this script, then
// `node scripts/fetch-artwork.mjs` to download its image.
// Rows with name: null are the default form / oddities (grouped cap labels,
// Pokopia-only characters, gender notes) — they always merge; give one a name
// and a separate flag if it should ever become an answer.
// Labels not listed here (and not Mega/Gmax/regional) also merge, with a
// build note so new games' forms surface for review.
// ---------------------------------------------------------------------------
const ALT_FORMS = {
  pikachu: [
    { name: null, labels: ['Original Cap', 'Partner Cap', 'World Cap', 'Pale',
      'Original Cap, Hoenn Cap, Sinnoh Cap, Unova Cap, Kalos Cap, Alola Cap, and Partner Cap',
      'Hoenn Cap, Sinnoh Cap, Unova Cap, Kalos Cap, and Alola Cap'] }, // costume caps + Pokopia's Pale
  ],
  snorlax: [
    { name: null, labels: ['Mossy'] }, // Pokopia's Mosslax
  ],
  unown: [
    { name: null, labels: ['One form'] }, // BDSP label quirk
  ],
  smeargle: [
    { name: null, labels: ['Decorator'] }, // Pokopia character
  ],
  castform: [
    { name: null, labels: ['Normal'] },
    { name: 'Castform (Sunny Form)', labels: ['Sunny Form'], separate: false },
    { name: 'Castform (Rainy Form)', labels: ['Rainy Form'], separate: false },
    { name: 'Castform (Snowy Form)', labels: ['Snowy Form'], separate: false },
  ],
  deoxys: [
    { name: null, labels: ['Normal Forme'] },
    { name: 'Deoxys (Attack Forme)', labels: ['Attack Forme'], separate: false },
    { name: 'Deoxys (Defense Forme)', labels: ['Defense Forme'], separate: false },
    { name: 'Deoxys (Speed Forme)', labels: ['Speed Forme'], separate: false },
  ],
  burmy: [
    { name: null, labels: ['Plant Cloak'] },
    { name: 'Burmy (Sandy Cloak)', labels: ['Sandy Cloak'], separate: false },
    { name: 'Burmy (Trash Cloak)', labels: ['Trash Cloak'], separate: false },
  ],
  wormadam: [
    { name: null, labels: ['Plant Cloak'] },
    { name: 'Wormadam (Sandy Cloak)', labels: ['Sandy Cloak'], separate: false },
    { name: 'Wormadam (Trash Cloak)', labels: ['Trash Cloak'], separate: false },
  ],
  cherrim: [
    { name: null, labels: ['Overcast Form'] },
    { name: 'Cherrim (Sunshine Form)', labels: ['Sunshine Form'], separate: false },
  ],
  shellos: [
    { name: null, labels: ['West Sea'] },
    { name: 'Shellos (East Sea)', labels: ['East Sea'], separate: false },
  ],
  gastrodon: [
    { name: null, labels: ['West Sea'] },
    { name: 'Gastrodon (East Sea)', labels: ['East Sea'], separate: false },
  ],
  tangrowth: [
    { name: null, labels: ['Professor'] }, // Pokopia character
  ],
  rotom: [
    { name: null, labels: ['Rotom', 'Stereo Rotom'] }, // base + Pokopia's stereo
    { name: 'Heat Rotom', labels: ['Heat Rotom'], separate: false },
    { name: 'Wash Rotom', labels: ['Wash Rotom'], separate: false },
    { name: 'Frost Rotom', labels: ['Frost Rotom'], separate: false },
    { name: 'Fan Rotom', labels: ['Fan Rotom'], separate: false },
    { name: 'Mow Rotom', labels: ['Mow Rotom'], separate: false },
  ],
  dialga: [
    { name: 'Dialga (Origin Forme)', labels: ['Origin Forme'], separate: false },
  ],
  palkia: [
    { name: 'Palkia (Origin Forme)', labels: ['Origin Forme'], separate: false },
  ],
  giratina: [
    { name: null, labels: ['Altered Forme'] },
    { name: 'Giratina (Origin Forme)', labels: ['Origin Forme'], separate: false },
  ],
  shaymin: [
    { name: null, labels: ['Land Forme'] },
    { name: 'Shaymin (Sky Forme)', labels: ['Sky Forme'], separate: false },
  ],
  arceus: [
    { name: null, labels: ['Arceus'] },
  ],
  unfezant: [
    { name: null, labels: ['Male', 'Female', 'Both genders'] },
  ],
  basculin: [
    { name: null, labels: ['Red-Striped Form'] },
    { name: 'Basculin (Blue-Striped Form)', labels: ['Blue-Striped Form'], separate: false },
    { name: 'Basculin (White-Striped Form)', labels: ['White-Striped Form'], separate: false },
  ],
  darmanitan: [
    { name: null, labels: ['Standard Mode'] },
    { name: 'Darmanitan (Zen Mode)', labels: ['Zen Mode'], separate: false },
  ],
  deerling: [
    { name: null, labels: ['Spring Form'] },
    { name: 'Deerling (Summer Form)', labels: ['Summer Form'], separate: false },
    { name: 'Deerling (Autumn Form)', labels: ['Autumn Form'], separate: false },
    { name: 'Deerling (Winter Form)', labels: ['Winter Form'], separate: false },
  ],
  sawsbuck: [
    { name: null, labels: ['Spring Form'] },
    { name: 'Sawsbuck (Summer Form)', labels: ['Summer Form'], separate: false },
    { name: 'Sawsbuck (Autumn Form)', labels: ['Autumn Form'], separate: false },
    { name: 'Sawsbuck (Winter Form)', labels: ['Winter Form'], separate: false },
  ],
  frillish: [
    { name: null, labels: ['Male', 'Female', 'Both genders'] },
  ],
  jellicent: [
    { name: null, labels: ['Male', 'Female'] },
  ],
  tornadus: [
    { name: null, labels: ['Incarnate Forme'] },
    { name: 'Tornadus (Therian Forme)', labels: ['Therian Forme'], separate: false },
  ],
  thundurus: [
    { name: null, labels: ['Incarnate Forme'] },
    { name: 'Thundurus (Therian Forme)', labels: ['Therian Forme'], separate: false },
  ],
  landorus: [
    { name: null, labels: ['Incarnate Forme'] },
    { name: 'Landorus (Therian Forme)', labels: ['Therian Forme'], separate: false },
  ],
  kyurem: [
    { name: null, labels: ['Kyurem'] },
    { name: 'White Kyurem', labels: ['White Kyurem'], separate: false },
    { name: 'Black Kyurem', labels: ['Black Kyurem'], separate: false },
  ],
  keldeo: [
    { name: null, labels: ['Ordinary Form'] },
    { name: 'Keldeo (Resolute Form)', labels: ['Resolute Form'], separate: false },
  ],
  meloetta: [
    { name: null, labels: ['Aria Forme'] },
    { name: 'Meloetta (Pirouette Forme)', labels: ['Pirouette Forme'], separate: false },
  ],
  genesect: [
    { name: null, labels: ['Genesect'] },
    { name: 'Genesect (Douse Drive)', labels: ['Douse Drive'], separate: false },
    { name: 'Genesect (Shock Drive)', labels: ['Shock Drive'], separate: false },
    { name: 'Genesect (Burn Drive)', labels: ['Burn Drive'], separate: false },
    { name: 'Genesect (Chill Drive)', labels: ['Chill Drive'], separate: false },
  ],
  vivillon: [
    { name: null, labels: ['Icy Snow Pattern', 'Polar Pattern', 'Tundra Pattern',
      'Continental Pattern', 'Garden Pattern', 'Elegant Pattern', 'Meadow Pattern',
      'Modern Pattern', 'Marine Pattern', 'Archipelago Pattern', 'High Plains Pattern',
      'Sandstorm Pattern', 'River Pattern', 'Monsoon Pattern', 'Savanna Pattern',
      'Sun Pattern', 'Ocean Pattern', 'Jungle Pattern', 'Fancy Pattern',
      'Poké Ball Pattern'] }, // cosmetic wing patterns
  ],
  flabebe: [
    { name: null, labels: ['Red Flower', 'Yellow Flower', 'Orange Flower',
      'Blue Flower', 'White Flower'] }, // cosmetic flower colors
  ],
  floette: [
    { name: null, labels: ['Red Flower', 'Yellow Flower', 'Orange Flower',
      'Blue Flower', 'White Flower'] },
    { name: 'Floette (Eternal Flower)', labels: ['Eternal Flower'], separate: false },
  ],
  florges: [
    { name: null, labels: ['Red Flower', 'Yellow Flower', 'Orange Flower',
      'Blue Flower', 'White Flower'] },
  ],
  meowstic: [
    { name: null, labels: ['Male'] },
    { name: 'Meowstic (Female)', labels: ['Female'], separate: false },
  ],
  aegislash: [
    { name: null, labels: ['Shield Forme'] },
    { name: 'Aegislash (Blade Forme)', labels: ['Blade Forme'], separate: false },
  ],
  pumpkaboo: [
    { name: null, labels: ['Average Size', 'Medium Variety'] },
    { name: 'Pumpkaboo (Small Size)', labels: ['Small Size', 'Small Variety'], separate: false },
    { name: 'Pumpkaboo (Large Size)', labels: ['Large Size', 'Large Variety'], separate: false },
    { name: 'Pumpkaboo (Super Size)', labels: ['Super Size', 'Jumbo Variety'], separate: false },
  ],
  gourgeist: [
    { name: null, labels: ['Average Size', 'Medium Variety'] },
    { name: 'Gourgeist (Small Size)', labels: ['Small Size', 'Small Variety'], separate: false },
    { name: 'Gourgeist (Large Size)', labels: ['Large Size', 'Large Variety'], separate: false },
    { name: 'Gourgeist (Super Size)', labels: ['Super Size', 'Jumbo Variety'], separate: false },
  ],
  zygarde: [
    { name: null, labels: ['50% Forme'] },
    { name: 'Zygarde (10% Forme)', labels: ['10% Forme'], separate: false },
    { name: 'Zygarde (Complete Forme)', labels: ['Complete Forme'], separate: false },
  ],
  hoopa: [
    { name: null, labels: ['Hoopa Confined'] },
    { name: 'Hoopa Unbound', labels: ['Hoopa Unbound'], separate: false },
  ],
  oricorio: [
    { name: null, labels: ['Baile Style'] },
    { name: 'Oricorio (Pom-Pom Style)', labels: ['Pom-Pom Style'], separate: false },
    { name: "Oricorio (Pa'u Style)", labels: ["Pa'u Style"], separate: false },
    { name: 'Oricorio (Sensu Style)', labels: ['Sensu Style'], separate: false },
  ],
  lycanroc: [
    { name: null, labels: ['Midday Form'] },
    { name: 'Lycanroc (Midnight Form)', labels: ['Midnight Form'], separate: false },
    { name: 'Lycanroc (Dusk Form)', labels: ['Dusk Form'], separate: false },
  ],
  wishiwashi: [
    { name: null, labels: ['Solo Form'] },
    { name: 'Wishiwashi (School Form)', labels: ['School Form'], separate: false },
  ],
  silvally: [
    { name: null, labels: ['Type: Normal', "''All other forms''"] },
  ],
  minior: [
    { name: null, labels: ['Meteor Form'] },
    { name: 'Minior (Core)', labels: [
      'Red Core, Orange Core, Yellow Core, Green Core, Blue Core, Indigo Core, and Violet Core',
    ], separate: false },
  ],
  mimikyu: [
    { name: null, labels: ['Disguised Form'] },
    { name: 'Mimikyu (Busted Form)', labels: ['Busted Form'], separate: false },
  ],
  necrozma: [
    { name: 'Dusk Mane Necrozma', labels: ['Dusk Mane'], separate: false },
    { name: 'Dawn Wings Necrozma', labels: ['Dawn Wings'], separate: false },
    { name: 'Ultra Necrozma', labels: ['Ultra Necrozma'], separate: false },
  ],
  magearna: [
    { name: 'Magearna (Original Color)', labels: ['Original Color'], separate: false },
  ],
  greedent: [
    { name: null, labels: ['Cook'] }, // Pokopia character
  ],
  cramorant: [
    { name: 'Cramorant (Gulping Form)', labels: ['Gulping Form'], separate: false },
    { name: 'Cramorant (Gorging Form)', labels: ['Gorging Form'], separate: false },
  ],
  toxtricity: [
    { name: null, labels: ['Amped Form'] },
    { name: 'Toxtricity (Low Key Form)', labels: ['Low Key Form'], separate: false },
  ],
  sinistea: [
    { name: null, labels: ['Phony Form'] },
    { name: 'Sinistea (Antique Form)', labels: ['Antique Form'], separate: false },
  ],
  polteageist: [
    { name: null, labels: ['Phony Form'] },
    { name: 'Polteageist (Antique Form)', labels: ['Antique Form'], separate: false },
  ],
  alcremie: [
    { name: null, labels: ['Vanilla Cream', 'Ruby Cream', 'Matcha Cream', 'Mint Cream',
      'Lemon Cream', 'Salted Cream', 'Ruby Swirl', 'Caramel Swirl', 'Rainbow Swirl'] },
  ],
  eiscue: [
    { name: null, labels: ['Ice Face'] },
    { name: 'Eiscue (Noice Face)', labels: ['Noice Face'], separate: false },
  ],
  indeedee: [
    { name: null, labels: ['Male'] },
    { name: 'Indeedee (Female)', labels: ['Female'], separate: false },
  ],
  morpeko: [
    { name: null, labels: ['Full Belly Mode'] },
    { name: 'Morpeko (Hangry Mode)', labels: ['Hangry Mode'], separate: false },
  ],
  zacian: [
    { name: null, labels: ['Hero of Many Battles'] },
    { name: 'Zacian (Crowned Sword)', labels: ['Crowned Sword'], separate: false },
  ],
  zamazenta: [
    { name: null, labels: ['Hero of Many Battles'] },
    { name: 'Zamazenta (Crowned Shield)', labels: ['Crowned Shield'], separate: false },
  ],
  eternatus: [
    { name: 'Eternamax Eternatus', labels: ['Eternamax'], separate: false },
  ],
  urshifu: [
    { name: null, labels: ['Single Strike Style'] },
    { name: 'Urshifu (Rapid Strike Style)', labels: ['Rapid Strike Style'], separate: false },
  ],
  zarude: [
    { name: 'Dada Zarude', labels: ['Dada'], separate: false },
  ],
  calyrex: [
    { name: 'Ice Rider Calyrex', labels: ['Ice Rider'], separate: false },
    { name: 'Shadow Rider Calyrex', labels: ['Shadow Rider'], separate: false },
  ],
  ursaluna: [
    { name: 'Bloodmoon Ursaluna', labels: ['Bloodmoon'], separate: false },
  ],
  basculegion: [
    { name: null, labels: ['Male'] },
    { name: 'Basculegion (Female)', labels: ['Female'], separate: false },
  ],
  enamorus: [
    { name: null, labels: ['Incarnate Forme'] },
    { name: 'Enamorus (Therian Forme)', labels: ['Therian Forme'], separate: false },
  ],
  oinkologne: [
    { name: null, labels: ['Male'] },
    { name: 'Oinkologne (Female)', labels: ['Female'], separate: false },
  ],
  maushold: [
    { name: null, labels: ['Family of Four'] },
    { name: 'Maushold (Family of Three)', labels: ['Family of Three'], separate: false },
  ],
  squawkabilly: [
    { name: null, labels: ['Green Plumage'] },
    { name: 'Squawkabilly (Blue Plumage)', labels: ['Blue Plumage'], separate: false },
    { name: 'Squawkabilly (Yellow Plumage)', labels: ['Yellow Plumage'], separate: false },
    { name: 'Squawkabilly (White Plumage)', labels: ['White Plumage'], separate: false },
  ],
  tinkaton: [
    { name: null, labels: ['Supervisor'] }, // Pokopia character
  ],
  palafin: [
    { name: null, labels: ['Zero Form'] },
    { name: 'Palafin (Hero Form)', labels: ['Hero Form'], separate: false },
  ],
  tatsugiri: [
    { name: null, labels: ['Curly Form'] },
    { name: 'Tatsugiri (Droopy Form)', labels: ['Droopy Form'], separate: false },
    { name: 'Tatsugiri (Stretchy Form)', labels: ['Stretchy Form'], separate: false },
  ],
  dudunsparce: [
    { name: null, labels: ['Two-Segment Form'] },
    { name: 'Dudunsparce (Three-Segment Form)', labels: ['Three-Segment Form'], separate: false },
  ],
  gimmighoul: [
    { name: null, labels: ['Chest Form'] },
    { name: 'Gimmighoul (Roaming Form)', labels: ['Roaming Form'], separate: false },
  ],
  koraidon: [
    { name: null, labels: ['Apex Build'] },
    { name: 'Koraidon (Limited Build)', labels: ['Limited Build'], separate: false },
  ],
  miraidon: [
    { name: null, labels: ['Ultimate Mode'] },
    { name: 'Miraidon (Low-Power Mode)', labels: ['Low-Power Mode'], separate: false },
  ],
  poltchageist: [
    { name: null, labels: ['Counterfeit Form'] },
    { name: 'Poltchageist (Artisan Form)', labels: ['Artisan Form'], separate: false },
  ],
  sinistcha: [
    { name: null, labels: ['Unremarkable Form'] },
    { name: 'Sinistcha (Masterpiece Form)', labels: ['Masterpiece Form'], separate: false },
  ],
  ogerpon: [
    { name: null, labels: ['Teal Mask'] },
    { name: 'Ogerpon (Wellspring Mask)', labels: ['Wellspring Mask'], separate: false },
    { name: 'Ogerpon (Hearthflame Mask)', labels: ['Hearthflame Mask'], separate: false },
    { name: 'Ogerpon (Cornerstone Mask)', labels: ['Cornerstone Mask'], separate: false },
  ],
  terapagos: [
    { name: null, labels: ['Normal Form'] },
    { name: 'Terapagos (Terastal Form)', labels: ['Terastal Form'], separate: false },
    { name: 'Terapagos (Stellar Form)', labels: ['Stellar Form'], separate: false },
  ],
};

// ---------------------------------------------------------------------------
// Slugs & fetching
// ---------------------------------------------------------------------------

// Names whose generated slug wouldn't be unique/right (♀/♂ strip to nothing)
const SLUG_OVERRIDES = { 'Nidoran♀': 'nidoran-f', 'Nidoran♂': 'nidoran-m' };

function slugify(name) {
  if (SLUG_OVERRIDES[name]) return SLUG_OVERRIDES[name];
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’.]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

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
// Wikitext cleanup
// ---------------------------------------------------------------------------

// Strip wiki markup from a Bulbapedia dex entry
function cleanWikiText(text) {
  let out = text
    .replace(/<small>[\s\S]*?<\/small>/gi, '') // editorial footnotes, game notes
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')                      // html tags like <sc>
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')  // [[link|label]] -> label
    .replace(/\[\[([^\]]*)\]\]/g, '$1');          // [[link]] -> link
  // Resolve templates innermost-first. {{tt|shown|tooltip}}-style templates
  // keep their first argument; link templates like {{p|Name|shown text}}
  // display their last. Argless small-caps templates render a fixed word
  // ({{ScPkmn}} -> "Pokémon"); other argless ones like {{sic}} render nothing.
  const ARGLESS = { scpkmn: 'Pokémon', scball: 'Poké Ball', berries: 'Berries' };
  for (let i = 0; i < 5 && out.includes('{{'); i++) {
    out = out.replace(/\{\{([^{}]*)\}\}/g, (_, inner) => {
      const parts = inner.split('|').map(s => s.trim());
      if (parts.length === 1) return ARGLESS[parts[0].toLowerCase()] ?? '';
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
// Pokédex-entry parsing
// ---------------------------------------------------------------------------

// Returns Map(formLabel -> [entry texts]) from a species page's wikitext.
// The base form's label is '' (entries before any {{Dex/Form|...}} marker);
// each {{Dex/Gen...}} header starts a new game block and resets the form.
// Multi-game lines (Stadium 2 reads the inserted cartridge's dex) hold
// several entries separated by <br>; each part becomes its own entry.
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
        for (const part of entry[1].split(/<br\s*\/?>/i)) {
          const text = cleanWikiText(part);
          if (text) byForm.get(form).push(text);
        }
      }
    }
  }
  return byForm;
}

// ---------------------------------------------------------------------------
// 1. Species list from the National Pokédex page
// ---------------------------------------------------------------------------

const NDEX_TITLE = 'List_of_Pokémon_by_National_Pokédex_number';
const ndexText = await cached(
  'bulbapedia/_ndex.wiki', `${BULBA}?title=${encodeURIComponent(NDEX_TITLE)}&action=raw`);

const species = [];
const seenDex = new Set();
for (const m of ndexText.matchAll(/^\{\{ndex\|(\d{4})\|([^|}]+)/gm)) {
  const dex = Number(m[1]);
  const name = m[2].trim();
  if (seenDex.has(dex)) continue; // one row per species
  seenDex.add(dex);
  species.push({ dex, name, slug: slugify(name) });
}
species.sort((a, b) => a.dex - b.dex);
console.log(`species: ${species.length}`);

// ---------------------------------------------------------------------------
// 2. Fetch every species page (warm cache: zero network)
// ---------------------------------------------------------------------------

const wikitexts = new Map();
await pool(species, async sp => {
  const title = sp.name.replace(/ /g, '_') + '_(Pokémon)';
  wikitexts.set(sp.slug, await cached(
    `bulbapedia/${sp.slug}.wiki`, `${BULBA}?title=${encodeURIComponent(title)}&action=raw`));
}, CONCURRENCY);
console.log(`species pages: ${wikitexts.size}`);

// ---------------------------------------------------------------------------
// 3. Classify labels & assemble answers
// ---------------------------------------------------------------------------

const REGIONS = ['Alolan', 'Galarian', 'Hisuian', 'Paldean'];
// Archive artwork filenames use the region name, not the adjective
const REGION_SUFFIX = { Alolan: 'Alola', Galarian: 'Galar', Hisuian: 'Hisui', Paldean: 'Paldea' };

// A Mega/Primal/Gigantamax/regional label -> the answer name it belongs to
// (one answer per name: sub-variants like Gigantamax Urshifu's two styles or
// Mega Tatsugiri's three forms pool their entries together)
function categoryAnswerName(label, baseName) {
  if (/^Mega\b/.test(label)) return label.replace(/\s*\(.*\)$/, '');
  if (label === 'Primal Reversion' || /^Primal\b/.test(label)) return `Primal ${baseName}`;
  if (/Gigantamax/.test(label)) return `Gigantamax ${baseName}`;
  const region = REGIONS.find(r => label.startsWith(r + ' '));
  if (region) return `${region} ${baseName}`;
  return null;
}

const answers = [];      // { id, name, dex }
const entryFiles = new Map(); // id -> texts[]
const artwork = new Map();    // id -> candidate archive filenames (fetch-artwork.mjs)
const takenIds = new Set();
const notes = [];

function addAnswer(id, name, dex, texts, artCandidates) {
  if (takenIds.has(id)) throw new Error(`duplicate answer id: ${id}`);
  takenIds.add(id);
  answers.push({ id, name, dex });
  entryFiles.set(id, texts);
  artwork.set(id, artCandidates);
}

const pad4 = n => String(n).padStart(4, '0');

// Artwork filenames referenced anywhere on the species' page, for candidates
function pageArtFiles(sp) {
  const re = new RegExp(`${pad4(sp.dex)}[^|\\]}<>\\n]*\\.png`, 'g');
  return [...new Set(wikitexts.get(sp.slug).match(re) ?? [])];
}

for (const sp of species) {
  const byForm = parseDexEntries(wikitexts.get(sp.slug));
  if (byForm.size === 0) notes.push(`no dex entries parsed for ${sp.slug}`);

  const altRows = ALT_FORMS[sp.slug] ?? [];
  const labelToRow = new Map();
  for (const row of altRows) for (const l of row.labels) labelToRow.set(l, row);

  const basePool = [...(byForm.get('') ?? [])];
  const categoryPools = new Map(); // answer name -> {texts, labels}
  const separatePools = new Map(); // ALT_FORMS row -> texts

  for (const [label, texts] of byForm) {
    if (!label) continue;
    const catName = categoryAnswerName(label, sp.name);
    if (catName) {
      if (!categoryPools.has(catName)) categoryPools.set(catName, { texts: [], labels: [] });
      categoryPools.get(catName).texts.push(...texts);
      categoryPools.get(catName).labels.push(label);
      continue;
    }
    const row = labelToRow.get(label);
    if (!row) notes.push(`${sp.slug}: merged unlisted label "${label}"`);
    if (row?.separate) {
      if (!separatePools.has(row)) separatePools.set(row, []);
      separatePools.get(row).push(...texts);
    } else {
      basePool.push(...texts);
    }
  }

  const art = pageArtFiles(sp);
  const baseArt = `${pad4(sp.dex)}${sp.name}.png`;

  addAnswer(sp.slug, sp.name, sp.dex, dedupe(basePool), [baseArt]);

  for (const [name, pool_] of categoryPools) {
    const texts = dedupe(pool_.texts);
    if (!texts.length) { notes.push(`${sp.slug}: no entries for ${name}`); continue; }
    // Candidate artwork: derived suffix guesses plus anything on the page
    // whose name hints at this form; fetch-artwork tries them in order.
    const hints = name.replace(sp.name, '').split(/[^A-Za-z0-9%]+/)
      .filter(w => w.length > 1).map(w => REGION_SUFFIX[w] ?? w);
    const derived = deriveArtNames(name, sp);
    const scanned = art.filter(f => f !== baseArt && hints.some(h => f.includes(h)));
    addAnswer(slugify(name), name, sp.dex, texts, [...new Set([...derived, ...scanned])]);
  }

  for (const [row, texts] of separatePools) {
    const deduped = dedupe(texts);
    if (!deduped.length) { notes.push(`${sp.slug}: no entries for ${row.name}`); continue; }
    const hints = row.name.replace(sp.name, '').split(/[^A-Za-z0-9%]+/).filter(w => w.length > 1);
    const scanned = art.filter(f => hints.some(h => f.includes(h)));
    addAnswer(slugify(row.name), row.name, sp.dex, deduped, scanned.length ? scanned : [baseArt]);
  }
}

// Archive artwork filename conventions, best guess first (verified samples:
// "0006Charizard-Mega X.png", "0892Urshifu-Gigantamax Single Strike.png",
// "0026Raichu-Alola.png", "0128Tauros-Paldea Combat.png")
function deriveArtNames(answerName, sp) {
  const p = pad4(sp.dex);
  const out = [];
  if (answerName.startsWith('Mega ')) {
    const suffix = answerName.match(/ ([XYZ])$/);
    out.push(`${p}${sp.name}-Mega${suffix ? ' ' + suffix[1] : ''}.png`);
  }
  if (answerName.startsWith('Primal ')) out.push(`${p}${sp.name}-Primal.png`);
  if (answerName.startsWith('Gigantamax ')) out.push(`${p}${sp.name}-Gigantamax.png`);
  for (const [adj, suffix] of Object.entries(REGION_SUFFIX)) {
    if (answerName.startsWith(adj + ' ')) out.push(`${p}${sp.name}-${suffix}.png`);
  }
  return out;
}

// Answers sorted: species by dex, each species' form answers right after it
const baseIds = new Set(species.map(sp => sp.slug));
answers.sort((a, b) => a.dex - b.dex
  || (baseIds.has(a.id) ? 0 : 1) - (baseIds.has(b.id) ? 0 : 1)
  || a.id.localeCompare(b.id));

// ---------------------------------------------------------------------------
// 4. Write outputs (data/entries is regenerated from scratch)
// ---------------------------------------------------------------------------

const entriesDir = path.join(ROOT, 'data', 'entries');
await mkdir(entriesDir, { recursive: true });
for (const f of await readdir(entriesDir)) {
  if (f.endsWith('.json')) await unlink(path.join(entriesDir, f));
}
for (const [id, texts] of entryFiles) {
  await writeFile(path.join(entriesDir, `${id}.json`), JSON.stringify(texts));
}
await writeFile(
  path.join(ROOT, 'data', 'species.json'),
  JSON.stringify(answers));
// Build-tooling manifest for fetch-artwork.mjs, not served by the site
await writeFile(
  path.join(RAW, 'artwork-manifest.json'),
  JSON.stringify(Object.fromEntries(artwork), null, 1));

const forms = answers.length - species.length;
console.log(`answers: ${species.length} species + ${forms} forms = ${answers.length}`);
if (notes.length) {
  console.log(`notes (${notes.length}):`);
  for (const n of notes) console.log(`  ${n}`);
}
console.log(`network requests this run: ${fetched}`);
