#!/usr/bin/env node
// Downloads official artwork from Bulbagarden Archives for every answer in
// data/species.json and saves a 256px PNG to sprites/{id}.png.
//
//   node scripts/fetch-artwork.mjs
//
// Candidate archive filenames come from raw/artwork-manifest.json (written by
// build-data.mjs); candidates are tried in order via Special:FilePath.
// Existing sprite files are skipped, so re-running only fills gaps — flip an
// ALT_FORMS flag in build-data.mjs, rebuild, then run this to get its image.
// Originals (often 1-3 MB) are resized with sips and not kept.
//
// Requires macOS `sips`. Polite to the archive: 2 downloads in flight, UA set.

import { readFile, writeFile, unlink, access, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPRITES = path.join(ROOT, 'sprites');
const FILEPATH = 'https://archives.bulbagarden.net/wiki/Special:FilePath/';
const USER_AGENT = 'DexGuesser-build/1.0 (personal hobby project)';
const SIZE = 256;
const CONCURRENCY = 2;

const answers = JSON.parse(await readFile(path.join(ROOT, 'data', 'species.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(ROOT, 'raw', 'artwork-manifest.json'), 'utf8'));
await mkdir(SPRITES, { recursive: true });

async function download(name) {
  const url = FILEPATH + encodeURIComponent(name);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  // PNG magic check: Special:FilePath 404s render an HTML page
  if (buf.length < 1000 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  return buf;
}

let done = 0, skipped = 0;
const failed = [], used = [];
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < answers.length) {
    const a = answers[next++];
    const out = path.join(SPRITES, `${a.id}.png`);
    try { await access(out); skipped++; continue; } catch { /* missing: fetch it */ }

    const candidates = manifest[a.id] ?? [];
    let buf = null, hit = null;
    for (const c of candidates) {
      buf = await download(c);
      if (buf) { hit = c; break; }
    }
    if (!buf) { failed.push(`${a.id} (tried: ${candidates.join(', ') || 'none'})`); continue; }

    const tmp = out + '.orig';
    await writeFile(tmp, buf);
    execFileSync('sips', ['-Z', String(SIZE), '-s', 'format', 'png', tmp, '--out', out],
      { stdio: 'ignore' });
    await unlink(tmp);
    used.push(`${a.id} <- ${hit}`);
    if (++done % 50 === 0) console.log(`downloaded ${done}...`);
  }
}));

console.log(`done: ${done} downloaded, ${skipped} already present, ${failed.length} failed`);
for (const f of failed) console.log(`FAILED ${f}`);
