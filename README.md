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

All Pokémon data is baked into the repo so the live site makes **zero**
calls to external APIs:

- `data/species.json` — id, slug, and display name for every guessable
  Pokémon (powers the autocomplete). Mega/Primal forms are included and
  carry their base Pokémon's national dex number in `dex`.
- `data/entries/{id}.json` — cleaned, de-duplicated English Pokédex
  entries per Pokémon
- `sprites/{id}.png` — icon for every Pokémon (from the
  [PokeAPI sprites repo](https://github.com/PokeAPI/sprites)).
  Mega Zygarde has no upstream sprite yet, so `10301.png` is a copy of
  the base Zygarde icon — replace it when upstream adds one.

Base-species entries come from [PokéAPI](https://pokeapi.co). Mega and
Primal forms have their own in-game entries (Sun/Moon, Let's Go, and
Legends: Z-A) that PokéAPI doesn't carry, so those are parsed from each
Pokémon's [Bulbapedia](https://bulbapedia.bulbagarden.net) page.

To refresh the JSON data (e.g. when a new generation is released):

```bash
node scripts/build-data.mjs
```

Every raw download is cached under `raw/` (gitignored, ~30 MB), so
re-running the script makes **no network requests** unless a cache file
is missing. Delete `raw/` to force a full refetch.

New sprites can be pulled from the PokeAPI sprites repo with a sparse
clone (`git clone --depth 1 --filter=blob:none --sparse
https://github.com/PokeAPI/sprites.git`, then check out
`/sprites/pokemon/*.png` and copy the base-species files here).

Pokémon data from [PokéAPI](https://pokeapi.co).
