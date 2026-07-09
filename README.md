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
  Pokémon (powers the autocomplete). Mega, Primal, Gigantamax, and
  regional (Alolan/Galarian/Hisuian/Paldean) forms are included and
  carry their base Pokémon's national dex number in `dex`.
- `data/entries/{id}.json` — cleaned, de-duplicated English Pokédex
  entries per Pokémon
- `sprites/{id}.png` — icon for every Pokémon (from the
  [PokeAPI sprites repo](https://github.com/PokeAPI/sprites)).
  Mega Zygarde has no upstream sprite yet, so `10301.png` is a copy of
  the base Zygarde icon — replace it when upstream adds one.

Base-species entries come from [PokéAPI](https://pokeapi.co). Mega,
Primal, Gigantamax, and regional forms have their own in-game entries
that PokéAPI doesn't separate out, so those are parsed from each
Pokémon's [Bulbapedia](https://bulbapedia.bulbagarden.net) page. Forms
that share entries are combined (e.g. Gigantamax Toxtricity's two
modes); forms with distinct entries are separate answers (e.g.
Gigantamax Urshifu's two styles, Paldean Tauros's three breeds).
Where PokéAPI attaches a regional form's entry text to the base
species, the build subtracts it from the base Pokémon's pool.

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

## Credits

- Pokédex data from [PokéAPI](https://pokeapi.co) and
  [Bulbapedia](https://bulbapedia.bulbagarden.net) (form entries, used
  under [CC BY-NC-SA 2.5](https://creativecommons.org/licenses/by-nc-sa/2.5/))
- Sprites from the [PokéAPI sprites repo](https://github.com/PokeAPI/sprites)
- Pokémon and all related names are © Nintendo, Game Freak, and The
  Pokémon Company. This is an unofficial fan project.
