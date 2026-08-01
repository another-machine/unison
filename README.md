# Unison

It finds the chromatic notes in what it hears and sings them back at you.

Sixty voices — one per semitone from C2 to B6 — sit at zero gain. Whatever the
detector hears, the matching voice swells. Nothing is sequenced and nothing is
transcribed; the machine is only ever agreeing with what is already playing.

Lives at [unison.amplib.app](https://unison.amplib.app). An earlier version is
at [jakealbaugh/unison](https://github.com/jakealbaugh/unison) — it hand-rolled
its own FFT, frequency table and chromatic bin mapping in one 300-line class.
All of that is `@amplib/music-detection` now, so what is left here is the
instrument: choosing a source, driving the voices, and drawing.

```bash
npm install
npm start        # parcel dev server
npm run build    # static build into dist/
npm run typecheck
```

## Packages

| Package                                                                            | Used for                                      |
| ---------------------------------------------------------------------------------- | --------------------------------------------- |
| [`@amplib/music-detection`](https://www.npmjs.com/package/@amplib/music-detection)   | per-semitone presence, and the chord guess     |
| [`@amplib/devices`](https://www.npmjs.com/package/@amplib/devices)                   | the microphone, unprocessed, and its device list |

Publishing `@amplib/music-detection` is what made this repo possible — it was
the last thing tying the machine to
[another-machine/public-library](https://github.com/another-machine/public-library),
where siblings are imported by relative source path.

## Layout

```
src/index.html      the interface — amplib-ui, no framework
src/app.ts          source switching, the voice bank, the scope
src/app.css         the canvas and the media box; everything else is amplib-ui
src/waveTables.ts   eight periodic waves, from mohayonao/wave-tables
src/amplib-ui.css   a copy of the design system — see "Drift" below
```

## Two sources

**A file**, audio or video. Both go into one `<video>` element:
`createMediaElementSource` may only be called once per element and swapping
`src` does not need a second one, so one element means one node and no
bookkeeping. An audio-only file collapses the box to its control bar.

**A microphone**, with a device picker. The list is only populated *after*
access is granted — before that the browser returns unnamed entries, so a
picker offered any earlier is a list of blanks. `MicrophoneStream` turns off
echo cancellation, noise suppression and automatic gain control, all three of
which would otherwise eat the thing being measured.

The file is monitored through to the speakers; a microphone is not, for
obvious reasons.

## The voices

Each voice is **two** oscillators, not one, so `spread` has something to
spread — a single detuned oscillator is just out of tune, while a pair beating
against each other is the chorus the name asks for. That is 120 oscillators,
built on the first gesture rather than at load.

`shimmer` is four drift LFOs shared round-robin across the sixty voices, each
voice's pair wired to one through opposite-sign gains so the beating moves
rather than the whole voice sliding sharp. Four rather than sixty: past a
handful of unrelated rates it already reads as irregular, and sixty more
oscillators is not worth what it costs.

`attack` and `release` are separate time constants because arriving and leaving
are different gestures — a swell that decays as slowly as it rose smears every
chord into the next one.

## Two things worth knowing

**A hidden page gets no animation frames.** The source keeps playing, so the
voice gains would hold whatever they were when you switched tabs and drone one
frozen chord over it. The bank ducks on `visibilitychange` instead.

**`src/amplib-ui.css` is a copy.** The design system is consumed by copying,
not by a build, and every copy in the org has drifted. Diff against
[amplib-ui](https://github.com/another-machine/amplib-ui) before editing it
here and decide deliberately whether a change belongs upstream.

## What it doesn't do yet

The original's `filter-min` / `filter-max` range, which muted everything
outside a window of the keyboard, and its per-frequency confidence counter.
Both are worth having; neither is here.
