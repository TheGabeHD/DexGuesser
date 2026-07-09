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

- `data/species.json` — id, slug, and display name for every species
  (powers the autocomplete)
- `data/entries/{id}.json` — cleaned, de-duplicated English Pokédex
  entries per species
- `sprites/{id}.png` — icon for every species (from the
  [PokeAPI sprites repo](https://github.com/PokeAPI/sprites))

To refresh the JSON data (e.g. when a new generation is released):

```bash
node scripts/build-data.mjs
```

New sprites can be pulled from the PokeAPI sprites repo with a sparse
clone (`git clone --depth 1 --filter=blob:none --sparse
https://github.com/PokeAPI/sprites.git`, then check out
`/sprites/pokemon/*.png` and copy the base-species files here).

Pokémon data from [PokéAPI](https://pokeapi.co).
