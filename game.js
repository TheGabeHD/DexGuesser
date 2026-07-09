'use strict';

// ---------------------------------------------------------------------------
// Config & constants
// ---------------------------------------------------------------------------

// All data and images are baked into the site by scripts/build-data.mjs,
// so the browser never calls PokéAPI directly.
const SPRITE_URL = id => `sprites/${id}.png`;

const MAX_GUESSES = 3;
const MAX_SUGGESTIONS = 8;

const STORAGE_PROGRESS = 'dexguesser-progress-v1';

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

const state = {
  species: [],      // [{ id, slug, name, searchKey }]
  daily: null,      // today's species object
  entries: [],      // up to 3 redacted pokedex entries
  guesses: [],      // species ids guessed so far (wrong ones + possibly the winner)
  status: 'playing' // 'playing' | 'won' | 'lost'
};

// ---------------------------------------------------------------------------
// Deterministic daily pick (same date -> same Pokémon for everyone)
// ---------------------------------------------------------------------------

function todayKey() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// FNV-1a string hash -> 32-bit seed
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Small seeded PRNG (mulberry32)
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickDaily(speciesList, dateKey) {
  const rng = mulberry32(hashString('dexguesser:' + dateKey));
  return speciesList[Math.floor(rng() * speciesList.length)];
}

// ---------------------------------------------------------------------------
// Species list & names
// ---------------------------------------------------------------------------

// Normalized form used to match what the user types ("mr mime", "farfetchd"...)
function searchKey(str) {
  return str.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
}

async function loadSpeciesList() {
  const res = await fetch('data/species.json');
  if (!res.ok) throw new Error(`species list: HTTP ${res.status}`);
  const data = await res.json();
  return data.map(sp => ({
    ...sp,
    searchKey: searchKey(sp.name) + '|' + searchKey(sp.slug),
  }));
}

// ---------------------------------------------------------------------------
// Pokédex entries
// ---------------------------------------------------------------------------

// Censor the Pokémon's own name so the entry doesn't give it away. "Mega" and
// "Primal" stay visible ("Mega Evolution" is a legitimate part of the hint —
// the player still has to figure out which Mega it is).
const REDACT_KEEP = new Set(['mega', 'primal']);

function redactName(text, species) {
  const tokens = new Set([species.name, species.slug]);
  for (const part of species.name.split(/[\s\-.]+/)) {
    if (part.length >= 3 && !REDACT_KEEP.has(part.toLowerCase())) tokens.add(part);
  }
  for (const part of species.slug.split('-')) {
    if (part.length >= 3 && !REDACT_KEEP.has(part)) tokens.add(part);
  }
  // Longest first so "Mr. Mime" is redacted before "Mime"
  const sorted = [...tokens].sort((a, b) => b.length - a.length);
  let out = text;
  for (const token of sorted) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), '███');
  }
  return out;
}

async function loadEntries(species, dateKey) {
  const res = await fetch(`data/entries/${species.id}.json`);
  if (!res.ok) throw new Error(`entries ${species.id}: HTTP ${res.status}`);
  const unique = await res.json();

  // Deterministically shuffle so the 3 shown entries vary day to day but are
  // identical for every player on a given day
  const rng = mulberry32(hashString('entries:' + dateKey));
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }

  return unique.slice(0, MAX_GUESSES).map(t => redactName(t, species));
}

// ---------------------------------------------------------------------------
// Progress persistence (so a refresh doesn't reset the game)
// ---------------------------------------------------------------------------

function saveProgress() {
  localStorage.setItem(STORAGE_PROGRESS, JSON.stringify({
    date: todayKey(),
    guesses: state.guesses,
    status: state.status,
  }));
}

function restoreProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_PROGRESS));
    if (saved && saved.date === todayKey()) {
      state.guesses = saved.guesses;
      state.status = saved.status;
    }
  } catch { /* corrupt storage -> start fresh */ }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);

// National dex number for display; mega/primal forms carry their base
// Pokémon's number in `dex` (their internal id is a large form id)
const dexNo = sp => String(sp.dex ?? sp.id).padStart(4, '0');

function render() {
  renderDots();
  renderEntries();
  renderHistory();
  renderResult();
}

function renderDots() {
  const dots = [];
  for (let i = 0; i < MAX_GUESSES; i++) {
    const used = i < state.guesses.length && !(state.status === 'won' && i === state.guesses.length - 1);
    const won = state.status === 'won' && i === state.guesses.length - 1;
    dots.push(`<span class="dot ${won ? 'won' : used ? 'used' : ''}"></span>`);
  }
  $('guess-dots').innerHTML = dots.join('');
}

function renderEntries() {
  const wrongCount = state.status === 'won' ? state.guesses.length - 1 : state.guesses.length;
  const revealed = state.status === 'lost'
    ? state.entries.length
    : Math.min(wrongCount + 1, state.entries.length);

  const html = [];
  for (let i = 0; i < revealed; i++) {
    html.push(
      `<div class="entry">
        <div class="entry-label">Entry ${i + 1}</div>
        <p>${state.entries[i]}</p>
      </div>`
    );
  }
  if (state.status === 'playing' && wrongCount + 1 > state.entries.length) {
    html.push(
      `<div class="entry no-entry">
        <p>No more entries exist for this Pokémon.</p>
      </div>`
    );
  }
  $('entries').innerHTML = html.join('');
}

function renderHistory() {
  $('guess-history').innerHTML = state.guesses.map(id => {
    const sp = state.species.find(s => s.id === id);
    const correct = id === state.daily.id;
    return `<span class="chip ${correct ? 'correct' : 'wrong'}">
      ${correct ? '✓' : '✕'} ${sp ? sp.name : '?'}
    </span>`;
  }).join('');
}

function renderResult() {
  const done = state.status !== 'playing';
  $('guess-form').hidden = done;
  $('result').hidden = !done;
  if (!done) return;

  $('result-sprite').src = SPRITE_URL(state.daily.id);
  $('result-sprite').alt = state.daily.name;
  if (state.status === 'won') {
    const n = state.guesses.length;
    $('result-title').textContent = `You got it in ${n} ${n === 1 ? 'guess' : 'guesses'}!`;
    $('result-title').className = 'win';
  } else {
    $('result-title').textContent = 'Out of guesses!';
    $('result-title').className = 'lose';
  }
  $('result-answer').innerHTML =
    `It was <strong>${state.daily.name}</strong> <span class="dexno">#${dexNo(state.daily)}</span>`;
  startCountdown();
}

// ---------------------------------------------------------------------------
// Countdown to the next daily Pokémon (local midnight)
// ---------------------------------------------------------------------------

let countdownTimer = null;

function startCountdown() {
  if (countdownTimer) return;
  const tick = () => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const ms = midnight - now;
    if (ms <= 0) { location.reload(); return; }
    const h = Math.floor(ms / 3600000);
    const m = Math.floor(ms / 60000) % 60;
    const s = Math.floor(ms / 1000) % 60;
    const pad = n => String(n).padStart(2, '0');
    $('countdown').textContent = `Next Pokémon in ${pad(h)}:${pad(m)}:${pad(s)}`;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

// ---------------------------------------------------------------------------
// Guessing
// ---------------------------------------------------------------------------

function submitGuess(species) {
  if (state.status !== 'playing') return;
  if (state.guesses.includes(species.id)) {
    flashInput();
    return;
  }

  state.guesses.push(species.id);
  if (species.id === state.daily.id) {
    state.status = 'won';
  } else if (state.guesses.length >= MAX_GUESSES) {
    state.status = 'lost';
  }

  saveProgress();
  closeSuggestions();
  $('guess-input').value = '';
  render();
}

function flashInput() {
  const input = $('guess-input');
  input.classList.remove('shake');
  void input.offsetWidth; // restart the animation
  input.classList.add('shake');
}

// ---------------------------------------------------------------------------
// Autocomplete dropdown
// ---------------------------------------------------------------------------

let suggestions = [];
let highlighted = -1;

function updateSuggestions() {
  const query = searchKey($('guess-input').value);
  if (!query) { closeSuggestions(); return; }

  const starts = [];
  const contains = [];
  for (const sp of state.species) {
    const keys = sp.searchKey.split('|');
    if (keys.some(k => k.startsWith(query))) starts.push(sp);
    else if (keys.some(k => k.includes(query))) contains.push(sp);
  }
  suggestions = starts.concat(contains).slice(0, MAX_SUGGESTIONS);
  highlighted = suggestions.length ? 0 : -1;

  const ul = $('suggestions');
  if (!suggestions.length) { closeSuggestions(); return; }
  ul.innerHTML = suggestions.map((sp, i) =>
    `<li data-index="${i}" class="${i === highlighted ? 'highlighted' : ''}">
      <img src="${SPRITE_URL(sp.id)}" alt="" loading="lazy" width="40" height="40">
      <span>${sp.name}</span>
      <span class="dexno">#${dexNo(sp)}</span>
    </li>`
  ).join('');
  ul.hidden = false;
}

function closeSuggestions() {
  suggestions = [];
  highlighted = -1;
  $('suggestions').hidden = true;
  $('suggestions').innerHTML = '';
}

function moveHighlight(delta) {
  if (!suggestions.length) return;
  highlighted = (highlighted + delta + suggestions.length) % suggestions.length;
  const items = $('suggestions').querySelectorAll('li');
  items.forEach((li, i) => li.classList.toggle('highlighted', i === highlighted));
  items[highlighted].scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Wiring & startup
// ---------------------------------------------------------------------------

function setupEvents() {
  const input = $('guess-input');

  input.addEventListener('input', updateSuggestions);

  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveHighlight(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveHighlight(-1); }
    else if (e.key === 'Escape') closeSuggestions();
  });

  $('guess-form').addEventListener('submit', e => {
    e.preventDefault();
    if (highlighted >= 0) submitGuess(suggestions[highlighted]);
  });

  $('suggestions').addEventListener('mousedown', e => {
    const li = e.target.closest('li');
    if (li) submitGuess(suggestions[Number(li.dataset.index)]);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.input-wrap')) closeSuggestions();
  });

  $('retry').addEventListener('click', init);
}

async function init() {
  $('error').hidden = true;
  $('loading').hidden = false;
  $('game').hidden = true;

  try {
    state.species = await loadSpeciesList();
    state.daily = pickDaily(state.species, todayKey());
    state.entries = await loadEntries(state.daily, todayKey());
    restoreProgress();

    $('loading').hidden = true;
    $('game').hidden = false;
    render();
    if (state.status === 'playing') $('guess-input').focus();
  } catch (err) {
    console.error(err);
    $('loading').hidden = true;
    $('error').hidden = false;
  }
}

setupEvents();
init();
