# DexGuesser

A daily game: guess the Pokémon from its Pokédex entries. You get three
guesses, and each wrong guess reveals another entry.

Fully static site — plain HTML/CSS/JS with no build step, framework, or
backend. Everyone gets the same Pokémon each day because the pick is
seeded from the date.

## Running locally

The game loads its data with `fetch()`, which browsers block on `file://`
pages, so serve the folder instead of double-clicking `index.html`:

```bash
python3 -m http.server
# then open http://localhost:8000
```

## Data

Everything comes from [Bulbapedia](https://bulbapedia.bulbagarden.net)
and is baked into the repo, so the live site makes **zero** calls to
external APIs:

- `data/species.json` — `{id, name, dex}` for every guessable answer
  (powers the autocomplete). `id` is a name slug used as the file key;
  `dex` is the national dex number (forms carry their base Pokémon's).
- `data/entries/{id}.json` — cleaned, de-duplicated English Pokédex
  entries per answer
- `sprites/{id}.png` — official artwork for every answer, downscaled
  to 256px (from the
  [Bulbagarden Archives](https://archives.bulbagarden.net))

Answer rules: every species is one answer, and Mega, Primal,
Gigantamax, and regional (Alolan/Galarian/Hisuian/Paldean) forms are
separate answers — one per name, so sub-variants pool their entries
(one Gigantamax Urshifu, one Paldean Tauros). Every other form's
entries merge into its species' answer; the `ALT_FORMS` table in
`scripts/build-data.mjs` lists them all, and flipping a form's
`separate` flag promotes it to its own answer. Everything Bulbapedia
files under a Pokémon's "Pokédex entries" section is included
(main series, Legends, Stadium, Pokopia, ...).

To refresh the data (e.g. when a new generation is released):

```bash
node scripts/build-data.mjs     # dex entries + species list
node scripts/fetch-artwork.mjs  # images for any answers missing one
```

Every downloaded wiki page is cached under `raw/` (gitignored), so
re-running the build makes **no network requests** unless a page is
missing — delete a file under `raw/bulbapedia/` to refetch just that
Pokémon. Artwork lives in `sprites/` (committed); `fetch-artwork.mjs`
only downloads images that don't exist yet.

## Credits

- Pokédex data from [Bulbapedia](https://bulbapedia.bulbagarden.net)
  (used under
  [CC BY-NC-SA 2.5](https://creativecommons.org/licenses/by-nc-sa/2.5/))
- Artwork via the [Bulbagarden Archives](https://archives.bulbagarden.net)
- Pokémon and all related names and images are © Nintendo, Game Freak,
  and The Pokémon Company. This is an unofficial fan project.
