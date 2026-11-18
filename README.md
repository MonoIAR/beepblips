# beepblips.

**Bleep synthesizer in one file**

[中文 README](README.zh.md)

beepblips (or `beepblips.js` if you prefer) turns a sentence into the "beep bleep" language in video games like Animal Crossing and Celeste. No recorded samples, no neural network: a sawtooth with three formant filters, every syllable gets one blip, and the punctuation decides whether the melody rises, falls, or trails off. The engine is ~47 KiB of plain JavaScript with no I/O, so the same file runs in Node, in the browser, and in the bundled demo page.

## Language it supports

- **ZH** Pinyin: kinda like real Chinese speech, best results.
- **ZH** Hanzi: Hash-based pronunciation only.
- **EN** English: Works fine.
- Other languages: Hash-based pronunciation only.

## Where to start

| You want to | Start with |
| --- | --- |
| Use it as a library | [Install](#install) → [Quick start](#quick-start) → [API](#api-reference) |
| Generate a WAV without writing code | [CLI](#cli) |
| Try it out | [Demo page](#demo-page) — double-click `index.html` |

## Install

### Option 1: copy the file

`beepblips.js` *is* the library. Drop it next to your code and import it:

```js
import {speak, toWav} from './vendor/beepblips.js';
```

Nothing else is needed — no build step, no bundler plugin, no assets, no `window` / `fs` / `fetch` calls inside.

### Option 2: install it as a package

```bash
npm install @monoiar/beepblips
```

`package.json` already maps the root export, so the import name is the package name:

```js
import {speak} from '@monoiar/beepblips';
```

### Option 3: browser, no build step

```html
<script type="module">
  import {speak, toWav} from './beepblips.js';
</script>
```

Serve the page from any static server, or a bundler dev server — browsers block module imports from `file://`. The bundled demo page sidesteps this by inlining the engine at build time, which is why double-clicking `index.html` works.

Node 18+ is required for the bundled CLI and test suite; the engine itself is plain ES2020 and also runs in Deno, Bun, and web workers.

## Quick start

**Node — write a WAV file:**

```js
import {writeFileSync} from 'node:fs';
import {speak, toWav} from './beepblips.js';

const {samples, sampleRate, duration, cues} = speak('Hello! Is this thing on?', {voice: 'bibi'});

writeFileSync('hello.wav', toWav(samples, sampleRate));
console.log(`${duration.toFixed(2)}s, ${cues.length} syllables`);
```

**Browser — play it with Web Audio:**

```js
import {speak} from './beepblips.js';

const ctx = new AudioContext();
const {samples, sampleRate} = speak('Hello!', {voice: 'bibi'});

const buffer = ctx.createBuffer(1, samples.length, sampleRate);
buffer.copyToChannel(samples, 0);

const source = ctx.createBufferSource();
source.buffer = buffer;
source.connect(ctx.destination);
source.start();
```

That is the whole integration: `speak()` hands you a mono `Float32Array`; `toWav()` turns it into file bytes when you need a file.

## API reference

### The contract

- **Pure.** Importing the module only defines functions and freezes its preset data. `speak()` and `render()` return data and never mutate your options or your plan.
- **Deterministic.** Same text + options + `seed` → identical bytes on every run. Safe to commit, hash, or serve as static audio.
- **Separate planning and rendering.** `analyze()` returns a plain-JSON score whose pitches are relative to the voice register; store it, diff it, hand-edit it, or render it with another voice later.
- **Loud failures.** Wrong voice name, out-of-range voice field, bad `sampleRate`, unknown `mode`, malformed plan → `TypeError` naming the field and the allowed values. Nothing silently degrades into NaN.
- **Bounded output.** Samples are clamped to [−1, 1], NaN becomes silence, and empty or punctuation-only text yields zero samples rather than an error.

### Exports at a glance

| Import | What it does |
| --- | --- |
| `speak(text, opts?)` | `analyze` + `render` in one call: samples, cues, plan |
| `analyze(text, opts?)` | Text → `Plan` (no audio), plain JSON |
| `render(plan, opts?)` | `Plan` → samples (+ cues with absolute pitch) |
| `toWav(samples, sampleRate?)` | `Float32Array` → WAV file bytes |
| `defineVoice(overrides, base?)` | Validated custom voice derived from a preset |
| `mouthOf(vowel)` | Vowel → `{open, wide}` for lip-sync |
| `hash(text)` | FNV-1a 32-bit hash; the per-character sound lives here |
| `VOICES`, `VOWELS` | Frozen preset voices and formant table |

### Options

`speak()` accepts every option below. `analyze()` uses the planning options, `render()` the rendering options.

| Option | Default | Accepted | Stage |
| --- | --- | --- | --- |
| `voice` | `'bibi'` | preset name or a voice object | analyze¹, render |
| `tempo` | voice's `tempo` (7) | syllables per second, clamped 1–30 | analyze |
| `pitch` | `0` | transpose in semitones, any finite number | render |
| `mode` | `'auto'` | `'auto'`, `'text'`, `'pinyin'` | analyze |
| `language` | `'auto'` | `'auto'`, `'zh'`, `'en'` — affects number reading only | analyze |
| `readNumbers` | `true` | boolean: words for numbers, or one blip per digit | analyze |
| `readAcronyms` | `true` | boolean: read all-caps 2–5 letter words as letter names | analyze |
| `pauseScale` | `1` | multiplier for punctuation pauses, clamped 0.2–3 | analyze |
| `maxDuration` | `600` | seconds; truncates at an event boundary | analyze |
| `contours` | voice's contours | partial override of the intonation constants | analyze |
| `reverb` | voice's `reverb` (0) | wet mix 0–1 | render |
| `sampleRate` | `44100` | 4000–384000 Hz | render |
| `seed` | `0` | integer; changes breath and noise, not timing | render |
| `cues` | `true` | include the cue list in the result | render |

¹ Only `speak()` reads the voice while planning: it folds the preset's `tempo` and intonation `contours` into the score, so switching voices can nudge the melody as well as the timbre. `analyze()` ignores `voice` entirely — pass `contours` explicitly if you want specific intonation there.

### `speak(text, opts?) → {samples, sampleRate, duration, cues, plan}`

One call, everything computed.

| Field | Type | Notes |
| --- | --- | --- |
| `samples` | `Float32Array` | Mono, −1..1. Longer than `duration` — see below |
| `sampleRate` | `number` | Echoes the effective sample rate |
| `duration` | `number` | Speech length in seconds (`plan.duration`), pauses included |
| `cues` | `Cue[]` | Lip-sync timeline, with absolute `midi` pitch |
| `plan` | `Plan` | The full score, including `warnings` and `truncated` |

The buffer is longer than `duration` by a release tail so nothing clicks: about 0.06 s normally, about 1.26 s when `reverb > 0`.

### `analyze(text, opts?) → Plan`

Text and prosody only — no audio. The result is plain JSON:

```js
analyze('Wait... what?');
```

```json
{
  "version": 1,
  "text": "Wait… what?",
  "mode": "text",
  "language": "en",
  "tempo": 7,
  "events": [
    {
      "kind": "syl", "t0": 0.06, "t1": 0.281,
      "text": "wait", "wordId": 0,
      "vowels": ["a", "i"],
      "onset": {"type": "liquid", "lead": 0.036},
      "coda": null,
      "pitch": [0.75, -3.25],
      "amp": 0.86, "stress": 1, "tone": null,
      "jitter": 0.878, "kindOf": "latin",
      "phraseId": 0, "terminal": true, "finalSyl": true
    },
    {"kind": "pause", "t0": 0.281, "t1": 0.831, "reason": "…", "after": "terminal"},
    {
      "kind": "syl", "t0": 0.831, "t1": 1.053,
      "text": "what", "wordId": 1,
      "vowels": ["a"],
      "onset": {"type": "fric", "freq": 4200, "q": 2.4, "burst": 0.45, "lead": 0.045},
      "coda": null,
      "pitch": [0.25, 6.25],
      "amp": 1, "stress": 1, "tone": null,
      "jitter": 0.936, "kindOf": "latin",
      "phraseId": 1, "terminal": true, "finalSyl": true
    },
    {"kind": "pause", "t0": 1.053, "t1": 1.433, "reason": "?", "after": "terminal"}
  ],
  "cues": [
    {"i": 0, "text": "wait", "t0": 0.06, "t1": 0.281, "pitch": 0.75, "vowel": "a",
     "onset": "liquid", "stress": 1, "tone": null, "mouth": {"open": 1, "wide": 0.267}},
    {"i": 1, "text": "what", "t0": 0.831, "t1": 1.053, "pitch": 0.25, "vowel": "a",
     "onset": "fric", "stress": 1, "tone": null, "mouth": {"open": 1, "wide": 0.267}}
  ],
  "duration": 1.433,
  "truncated": false,
  "warnings": []
}
```

Field notes:

- **Time is in seconds.** A render leaves a 0.06 s lead-in, so the first syllable starts at `t0 = 0.06`.
- **`pitch` is a list of anchors in semitones relative to the voice `register`**, so the same plan renders at any pitch. The register and the `pitch` transpose are added at render time.
- **`amp`** is relative loudness: 1 normally, 1.22 for exclamations, 0.86 for sentences trailing off.
- **`tone`** is the Chinese tone number (1–4, with 0 for the neutral tone) when the syllable has one, otherwise `null`.
- **`stress`**, **`terminal`**, **`finalSyl`**, and **`phraseId`** carry the prosody decisions: word stress, end of sentence, end of clause, and which sentence the syllable belongs to.
- **`kindOf`** is `latin`, `pinyin`, `cjk`, or `other`; an onset gesture is `none`, `stop`, `fric`, `nasal`, or `liquid` — as `event.onset.type` in the plan, and as the plain string `cue.onset`.
- **`cues`** is the animation view of the same data, and the render stage adds absolute `midi` to it.
- **`warnings`** collects recoverable input problems (for example, a pinyin token that could not be parsed); **`truncated`** is `true` when `maxDuration` cut the text short.

### `render(plan, opts?) → {samples, sampleRate, duration, cues}`

Turns any plan with this shape into audio, including a hand-written one. The plan is validated first: `version` must be `1`, `events` must be an array sorted by `t0` with `t1 >= t0`, and `duration` must be non-negative.

`render()` adds `midi = voice.register + pitch + cue.pitch` to every cue, which is the value you want for mapping syllables onto a MIDI-driven instrument or a pitch display.

### `toWav(samples, sampleRate = 44100) → Uint8Array`

16-bit PCM, mono, 44-byte header. Samples are clamped to ±1 and non-finite values become silence, so this never produces a corrupt file.

### `defineVoice(overrides, base = 'bibi') → Voice`

Deep-merges overrides onto a preset, then validates the numeric fields. Nested objects merge instead of replacing, so `{vibrato: {depth: 0.02}}` keeps the preset's rate and onset.

### `mouthOf(vowel) → {open, wide}`

`open` is jaw opening 0..1, `wide` is spread 0..1. Unknown vowels fall back to `a`.

### `hash(text) → number`

The 32-bit FNV-1a hash the engine uses to give every character a stable sound. Handy when you want to key something else by the same identity.

### Errors

| Situation | Result |
| --- | --- |
| Unknown voice name | `TypeError` listing the available presets |
| Voice field out of range or wrong type | `TypeError` naming the field, the range, and what it received |
| `mode` other than `text` / `pinyin` | `TypeError` |
| `pitch` not a finite number | `TypeError` |
| `sampleRate` outside 4000–384000 | `TypeError` |
| `toWav` with `sampleRate <= 0` | `TypeError` |
| Plan not matching the schema | `TypeError` describing the broken field |

Text input never throws: odd input becomes `warnings` or `truncated` instead. Note that the message strings are currently in Chinese, so check `err instanceof TypeError` and the field name rather than parsing the text.

## Recipes

### Lip-sync a character

```js
import {speak} from './beepblips.js';

const {cues} = speak('No way. Really?', {voice: 'bibi'});

// cues are sorted by time, so one cursor is enough for normal playback
let next = 0;
function mouthAt(t) {
  while (next < cues.length && t >= cues[next].t1) next += 1;
  const cue = cues[next];
  return cue && t >= cue.t0 ? cue.mouth : {open: 0, wide: 0};
}
```

Gaps between syllables return a closed mouth, which is the pause you want during punctuation.

### One score, many voices

```js
import {analyze, render} from './beepblips.js';

const score = analyze('今天吃白饭？没饭了！');

for (const [voice, pitch] of [['bibi', 0], ['warm', -3], ['robot', 0]]) {
  const {samples} = render(score, {voice, pitch});
  // identical timing and length, different timbre and register
}
```

### A button that always sounds the same

```js
import {speak, toWav} from './beepblips.js';

const {samples, sampleRate} = speak('ok', {voice: 'squeak', sampleRate: 22050});
const url = URL.createObjectURL(new Blob([toWav(samples, sampleRate)], {type: 'audio/wav'}));

button.addEventListener('click', () => new Audio(url).play());
```

`speak` is deterministic, so you can pre-render a handful of UI blips once and cache the URLs.

### Hand-write a jingle

`render()` does not need `analyze()` — any object with the plan shape works:

```js
const jingle = {
  version: 1,
  text: 'ding',
  duration: 0.35,
  events: [
    {kind: 'syl', t0: 0, t1: 0.35, text: 'ding', vowels: ['i'], pitch: [0, 12], amp: 1},
  ],
};

const {samples} = render(jingle, {voice: 'squeak'});
```

Each `syl` event carries `t0`, `t1`, and a `pitch` anchor list. Optional fields fall back to sensible defaults when omitted: `vowels` → `a`, `amp` → 1, `onset` → no consonant.

### Retune a syllable

```js
const plan = analyze('Wait... what?');
const first = plan.events.find((event) => event.kind === 'syl');

first.pitch = first.pitch.map((semitones) => semitones + 2);  // two semitones higher
const {samples} = render(plan, {voice: 'warm'});
```

The plan is plain JSON, so storing it in a file, patching it in a test, or generating it from a sequencer all work the same way.

## Voices

```js
import {VOICES, defineVoice} from './beepblips.js';

VOICES.bibi;   // a frozen preset; read it, copy it, don't edit it

const mine = defineVoice({
  register: 66,                 // MIDI center pitch
  formantScale: 1.05,           // shorter tract, brighter vowels
  breath: 0.12,                 // breathiness
  vibrato: {depth: 0.02},       // nested merge keeps rate and onset
  contours: {question: 7},      // a higher rising tail
  source: 'pulse',
  reverb: 0.2,
});
```

### Presets

| Name | Sounds like | Register / tempo / formant scale |
| --- | --- | --- |
| `bibi` | Bright little character, the default | 74 / 7 / 1.18 |
| `warm` | Low and gentle, tails tend to sag | 57 / 6 / 0.94 |
| `robot` | Pulse wave, no vibrato, mechanical | 62 / 7.6 / 1.05 |
| `squeak` | Piercing and fast, cartoon soprano | 84 / 8.4 / 1.32 |

### Voice fields

| Field | Range | What it does |
| --- | --- | --- |
| `register` | 12–120 | MIDI center pitch; the plan's relative semitones are added on top |
| `tempo` | 1–30 | Default syllables per second |
| `formantScale` | 0.5–2 | Vocal tract length: >1 means shorter tract and higher formants |
| `tilt` | 0–1 | Source spectral tilt: 0 bright, 1 dull |
| `breath` | 0–0.5 | Noise mixed into the source |
| `jitter` | 0–2 | Per-syllable pitch wobble multiplier (semitones) |
| `vibrato` | `{rate, depth ≤ 0.3, onset}` | Hz, depth, and seconds of delay after the phrase starts |
| `source` | `'saw'` or `'pulse'` | Oscillator shape |
| `pulseWidth` | 0.05–0.95 | Width for the pulse source |
| `articulation` | `{consonant ≥ 0, attack > 0, release > 0}` | Consonant strength and envelope times |
| `vowels` | key → `[f1, f2, f3]` Hz | Optional; merged over the built-in `VOWELS` table |
| `drive` / `gain` | 0.1–10 / 0.01–4 | Soft-clipping drive and output gain |
| `reverb` | 0–1 | Default wet mix (the `reverb` option wins) |
| `contours` | partial object | `decline`, `comma`, `question`, `exclaim`, `statement`, `ellipsis`, `accent`, `cjkAccent` |

Presets are deep-frozen, `defineVoice()` always returns a fresh object, and its numeric fields are validated — a typo in a voice name or an out-of-range value throws instead of quietly turning into a strange sound.

## How the text is read

1. **Normalize.** Full-width characters become half-width, `。` becomes `.`, `、` becomes `,`, `……` and `...` collapse to `…`, decorative quotes and brackets are dropped, thousand separators are removed, and hyphens inside words survive.
2. **Segment.** `. ! ? …` and newlines end a sentence; `, ; :` split clauses. Decimals (`3.14`) and in-word hyphens are never split.
3. **Classify.** `?` makes a rising tail, `!` makes the sentence louder and higher, `…` trails off lower and longer, everything else falls like a statement, and a clause break only half-stops.
4. **Expand to syllables.** Hanzi get one blip per character. Latin words split on vowel groups (`beepblips` → *beep·blips*, `synthesis` → *syn·the·sis*, `table` → *ta·ble*). Numbers become words (`2024` → *two thousand twenty-four*, in Chinese *二千零二十四*), and decimals are read digit by digit after "point". All-caps words of 2–5 letters are spelled out (`API` → *A P I*). Emoji, kana, Hangul, and Cyrillic characters each get one blip. ASCII punctuation is silent.
5. **Choose the phonetics.** For Hanzi a hash of the character picks the vowel, consonant, tone, and micro-jitter — the same character always sounds the same, and the four dimensions are decorrelated so a text does not collapse into five repeating voices. Latin words derive their vowels and consonants from their own letters.
6. **Plan the prosody.** Every clause gets a downward drift, the sentence kind adds a terminal contour on top, stressed syllables sit higher, and the last syllable of a clause is stretched (0.78× the base for ordinary syllables, 1.35× at a clause end, 1.55× at a sentence end). Pauses follow the punctuation.

Pause lengths, before `pauseScale`:

| Punctuation | Pause |
| --- | --- |
| `…` | 0.55 s |
| `.` `?` `!` | 0.38 s |
| `;` `:` | 0.26 s |
| `,` | 0.20 s |
| newline or none | 0.30 s |

## Pinyin mode

When you want real vowels for Chinese text instead of hashed ones, hand the engine pinyin:

```js
speak('ni3 hao3', {mode: 'pinyin'});
speak('hǎo', {mode: 'pinyin'});                 // tone marks work too
speak('jin1 tian1 chi1 shen2 me5');             // no mode needed: auto-detection catches it
```

- Syllables are space-separated. Initials, finals, and all four tones map to consonant gestures, formants, and pitch contours, and abbreviations such as `zh` / `ch` / `sh`, `j` / `q` / `x`, `ü`, `iu`, `ui`, and `un` are expanded to full forms.
- Tone 5 (or `0`) is the neutral tone.
- `mode: 'auto'` is conservative: it only switches to pinyin when every token looks like pinyin *and* at least one carries a tone mark or a tone digit, so ordinary English is never mistaken for pinyin.
- A token that cannot be parsed falls back to ordinary text and is reported in `plan.warnings`, so one bad syllable does not break the sentence.

## How it works

```
text ─normalize─> sentences/clauses ─tokenize─> pronunciation ─prosody─> Plan ─render─> samples ─toWav─> WAV
```

The render stage runs one continuous voice: anti-aliased sawtooth (or a pulse built from two sawtooths) → spectral tilt → three TPT band-passes whose formants glide from syllable to syllable (that glide is what creates the coarticulation) → consonant gestures (stop closures with bursts, fricative noise, nasals, liquids) → amplitude envelope → breath and vibrato → `tanh` soft clip → optional Schroeder reverb → DC blocker → WAV.

Every timbre and prosody parameter is data, so designing a voice never means touching the DSP.

## CLI

Text in, WAV out — no code required:

```bash
node cli.mjs "今天吃白饭？没饭了！" -o out.wav
node cli.mjs --mode pinyin "ni3 hao3" --voice warm --reverb 0.25 --cues
node cli.mjs "hello, world" --voice robot --json
```

| Flag | Meaning |
| --- | --- |
| `-o, --out <file>` | Output path (default `beepblips.wav`) |
| `--voice <name>` | `bibi`, `warm`, `robot`, `squeak` |
| `--tempo <n>` | Syllables per second |
| `--pitch <semitones>` | Transpose |
| `--mode <mode>` | `auto`, `text`, `pinyin` |
| `--lang <lang>` | `auto`, `zh`, `en` |
| `--rate <Hz>` | Sample rate |
| `--seed <n>` | Jitter and noise seed |
| `--reverb <0..1>` | Wet mix |
| `--cues` | Print the syllable timeline |
| `--json` | Print the plan as JSON instead of writing a file |
| `-h, --help` | Show usage |
| `-v, --version` | Show the version |

It also prints a one-line summary: length, number of syllables, character count, and the voice used. `--cues` adds a table of start/end time, vowel, and pitch per syllable.

Exit codes: `0` success, `1` unparsable arguments or empty text, `2` any failure during synthesis or writing — including an unknown voice name. The help text and console messages are currently in Chinese.

## Demo page

Double-click `index.html`. Type a sentence, pick a voice, hit **Blip!**, and save the result with **Download WAV**. Below the fold:

- **Number language**, sample rate, seed (+ **Randomize**), pause scale, and max duration
- **Read numbers aloud** and **Read acronyms as letters** toggles
- **Custom voice**: a dozen parameters applied live, with **Copy voice JSON** to take them into your code
- **Download cues (CSV)**: every syllable's start, end, and mouth opening, ready for animation
- A waveform scope and a per-syllable mouth-shape timeline

The page inlines the engine, so after editing `beepblips.js` run `node build.mjs` to refresh it.

## Tests and build

```bash
npm test                 # node --test, 39 cases, no dependencies
node build.mjs           # inline the engine into index.html
node build.mjs --check   # verify the demo page is in sync (CI)
```

Coverage: normalization and segmentation, Latin syllabification, number reading, pinyin parsing, prosody contours, hash decorrelation, render finiteness / peak / DC offset, pitch accuracy of a hand-written plan, reverb tail, WAV header fields, build synchronization, demo-page DOM references, and a smoke run of the demo script inside a minimal DOM.

## Limits

- It's beep, not actual text to speech: there is no pronunciation dictionary, and the vowels of arbitrary Hanzi come from a hash. For real vowels, use pinyin mode.
- Latin syllabification is heuristic — fine for common words, wrong for rare ones.
- Output is mono 16-bit WAV; there is no real-time scheduling and no streaming. Everything renders synchronously — roughly 150× real time on a laptop, but blocking for long texts.
- The buffer is allocated up front: ten minutes at 44.1 kHz is about 106 MB of `Float32Array`, and `maxDuration` defaults to 600 seconds.
- Pinyin mode expects space-separated syllables. Hanzi mixed into a pinyin string is not an error, but each such character falls back to a hashed vowel and adds a warning.
- Numbers longer than 12 digits are read digit by digit.
- No TypeScript declarations are shipped yet.

## License

beepblips is licensed under the MIT License.
(c) 2026 MIAR STAFF.
