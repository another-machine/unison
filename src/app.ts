import { MicrophoneStream } from "@amplib/devices";
import { DetectTone } from "@amplib/music-detection";
import { waveTables, type WaveTable } from "./waveTables";

type SourceKind = "file" | "microphone";

/**
 * One chromatic note's voice. Two oscillators rather than one so `spread` has
 * something to spread — a single detuned oscillator is just out of tune, while
 * a pair beating against each other is the chorus the name asks for.
 */
interface Voice {
  a: OscillatorNode;
  b: OscillatorNode;
  gain: GainNode;
}

const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const ui = {
  chord: element<HTMLSpanElement>("chord"),
  silence: element<HTMLButtonElement>("silence"),
  tabs: {
    file: element<HTMLButtonElement>("tab-file"),
    microphone: element<HTMLButtonElement>("tab-microphone"),
  },
  sources: {
    file: element<HTMLElement>("source-file"),
    microphone: element<HTMLElement>("source-microphone"),
  },
  drop: element<HTMLLabelElement>("drop"),
  file: element<HTMLInputElement>("file"),
  mediaFrame: element<HTMLDivElement>("media-frame"),
  media: element<HTMLVideoElement>("media"),
  mediaCaption: element<HTMLSpanElement>("media-caption"),
  input: element<HTMLSelectElement>("input"),
  listen: element<HTMLButtonElement>("listen"),
  deafen: element<HTMLButtonElement>("deafen"),
  scope: element<HTMLCanvasElement>("scope"),
  scopeCaption: element<HTMLSpanElement>("scope-caption"),
  scopeNotes: element<HTMLSpanElement>("scope-notes"),
  status: element<HTMLParagraphElement>("status"),
  wave: element<HTMLSelectElement>("wave"),
  spread: element<HTMLInputElement>("spread"),
  tone: element<HTMLInputElement>("tone"),
  shimmer: element<HTMLInputElement>("shimmer"),
  level: element<HTMLInputElement>("level"),
  focus: element<HTMLInputElement>("focus"),
  attack: element<HTMLInputElement>("attack"),
  release: element<HTMLInputElement>("release"),
  monitor: element<HTMLInputElement>("monitor"),
};

/** Rates for the drift LFOs, in Hz. Deliberately not multiples of each other. */
const SHIMMER_RATES = [0.037, 0.053, 0.071, 0.089];
/** Cents of drift at shimmer = 1. */
const SHIMMER_CENTS = 14;

let audioContext: AudioContext;
let detector: DetectTone;
let voices: Voice[] = [];
/** Everything the machine sings, so silence is one gain rather than sixty. */
let bank: GainNode;
/** One lowpass across the bank — `tone`. */
let colour: BiquadFilterNode;
/** Drift oscillators, shared round-robin across the voices. */
let lfos: OscillatorNode[] = [];
let shimmerDepths: GainNode[] = [];
/** The source itself, so you can hear what it is listening to. */
let monitor: GainNode;
/**
 * Only ever one per media element — a second `createMediaElementSource` on the
 * same element throws, and swapping `src` does not need a new one.
 */
let mediaSource: MediaElementAudioSourceNode | undefined;
let microphone: MicrophoneStream | undefined;
let microphoneSource: MediaStreamAudioSourceNode | undefined;
/** What is currently feeding the analyser, so it can be unhooked. */
let listening: AudioNode | undefined;
let objectUrl: string | undefined;

const periodicWaves = new Map<string, PeriodicWave>();

initialize();

function initialize() {
  for (const { name, label } of waveTables) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = label;
    ui.wave.append(option);
  }

  ui.tabs.file.addEventListener("click", () => selectSource("file"));
  ui.tabs.microphone.addEventListener("click", () =>
    selectSource("microphone")
  );

  ui.file.addEventListener("change", () => {
    const file = ui.file.files?.[0];
    if (file) loadFile(file);
  });

  ui.drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    ui.drop.dataset.state = "over";
  });
  ui.drop.addEventListener("dragleave", () => {
    ui.drop.dataset.state = ui.drop.hasAttribute("data-ready") ? "" : "empty";
  });
  ui.drop.addEventListener("drop", (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });

  ui.listen.addEventListener("click", () => startMicrophone());
  ui.deafen.addEventListener("click", () => stopMicrophone());
  ui.input.addEventListener("change", () => startMicrophone(ui.input.value));

  ui.silence.addEventListener("click", () => {
    const silenced = ui.silence.getAttribute("aria-pressed") === "true";
    ui.silence.setAttribute("aria-pressed", String(!silenced));
    applyBank();
  });

  ui.wave.addEventListener("change", applyWave);
  ui.spread.addEventListener("input", applySpread);
  ui.tone.addEventListener("input", applyTone);
  ui.shimmer.addEventListener("input", applyShimmer);
  ui.monitor.addEventListener("input", applyMonitor);

  // A hidden page gets no animation frames, so the voice gains would hold
  // whatever they were at the moment you switched away — the source keeps
  // playing and the machine drones one frozen chord over it. Duck until it
  // can see again.
  document.addEventListener("visibilitychange", applyBank);

  requestAnimationFrame(draw);
}

/**
 * The audio graph is built on the first real gesture rather than at load — an
 * AudioContext created before one starts suspended, and a hundred and twenty
 * oscillators is a lot to spin up for a page nobody has asked anything of yet.
 */
function start() {
  if (audioContext) return audioContext.resume();

  audioContext = new AudioContext();
  detector = new DetectTone({ audioContext });

  bank = audioContext.createGain();
  bank.gain.value = bankTarget();

  colour = audioContext.createBiquadFilter();
  colour.type = "lowpass";
  colour.frequency.value = Number(ui.tone.value);
  colour.Q.value = 0.7;

  bank.connect(colour);
  colour.connect(audioContext.destination);

  monitor = audioContext.createGain();
  monitor.gain.value = Number(ui.monitor.value);
  monitor.connect(audioContext.destination);

  // One drift oscillator per rate, not one per voice: 60 more oscillators to
  // give every voice its own wander is not worth what it costs, and four
  // rates across sixty voices is already past the point where it reads as
  // regular.
  lfos = [];
  shimmerDepths = SHIMMER_RATES.map((rate) => {
    const lfo = audioContext.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = rate;
    const depth = audioContext.createGain();
    depth.gain.value = Number(ui.shimmer.value) * SHIMMER_CENTS;
    lfo.connect(depth);
    lfo.start();
    lfos.push(lfo);
    return depth;
  });

  const wave = periodicWave(currentTable());

  voices = detector.notes.map(({ frequency }, i) => {
    const gain = audioContext.createGain();
    gain.gain.value = 0;
    gain.connect(bank);

    const drift = shimmerDepths[i % shimmerDepths.length];
    const [a, b] = [1, -1].map((direction) => {
      const oscillator = audioContext.createOscillator();
      oscillator.setPeriodicWave(wave);
      oscillator.frequency.value = frequency;
      oscillator.detune.value = (direction * Number(ui.spread.value)) / 2;
      // The pair drift in opposite directions off one LFO, so the beating
      // between them moves rather than the whole voice sliding sharp.
      const inverter = audioContext.createGain();
      inverter.gain.value = direction;
      drift.connect(inverter);
      inverter.connect(oscillator.detune);
      oscillator.connect(gain);
      oscillator.start();
      return oscillator;
    });

    return { a, b, gain };
  });

  const first = detector.notes[0];
  const last = detector.notes[detector.notes.length - 1];
  ui.scopeCaption.textContent = `${first.id} – ${last.id} · ${voices.length} voices`;

  return audioContext.resume();
}

function currentTable(): WaveTable {
  const found = waveTables.find(({ name }) => name === ui.wave.value);
  return (found || waveTables[0]).table;
}

function periodicWave(table: WaveTable) {
  const key = ui.wave.value || waveTables[0].name;
  const existing = periodicWaves.get(key);
  if (existing) return existing;
  const wave = audioContext.createPeriodicWave(
    Float32Array.from(table.real),
    Float32Array.from(table.imag)
  );
  periodicWaves.set(key, wave);
  return wave;
}

function applyWave() {
  if (!voices.length) return;
  const wave = periodicWave(currentTable());
  for (const { a, b } of voices) {
    a.setPeriodicWave(wave);
    b.setPeriodicWave(wave);
  }
}

function applySpread() {
  if (!voices.length) return;
  const cents = Number(ui.spread.value) / 2;
  const now = audioContext.currentTime;
  for (const { a, b } of voices) {
    a.detune.setTargetAtTime(cents, now, 0.05);
    b.detune.setTargetAtTime(-cents, now, 0.05);
  }
}

function applyTone() {
  if (!colour) return;
  colour.frequency.setTargetAtTime(
    Number(ui.tone.value),
    audioContext.currentTime,
    0.05
  );
}

function applyShimmer() {
  const depth = Number(ui.shimmer.value) * SHIMMER_CENTS;
  for (const gain of shimmerDepths) {
    gain.gain.setTargetAtTime(depth, audioContext.currentTime, 0.1);
  }
}

function applyMonitor() {
  if (!monitor) return;
  monitor.gain.setTargetAtTime(
    Number(ui.monitor.value),
    audioContext.currentTime,
    0.05
  );
}

function bankTarget() {
  if (document.visibilityState === "hidden") return 0;
  return ui.silence.getAttribute("aria-pressed") === "true" ? 0 : 1;
}

function applyBank() {
  if (!bank) return;
  bank.gain.setTargetAtTime(bankTarget(), audioContext.currentTime, 0.05);
}

/**
 * One source at a time. The analyser keeps whatever it was given until it is
 * explicitly disconnected, so a second source would sum into the first.
 */
async function listenTo(
  source: MediaElementAudioSourceNode | MediaStreamAudioSourceNode
) {
  if (listening && listening !== source) {
    listening.disconnect(detector.analyser);
  }
  await detector.initialize(source);
  listening = source;
}

function selectSource(kind: SourceKind) {
  for (const key of ["file", "microphone"] as SourceKind[]) {
    ui.tabs[key].setAttribute("aria-selected", String(key === kind));
    ui.sources[key].hidden = key !== kind;
  }

  if (kind === "file") {
    stopMicrophone();
    if (mediaSource) listenTo(mediaSource);
  } else {
    ui.media.pause();
  }
}

async function loadFile(file: File) {
  await start();

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);

  const isVideo = file.type.startsWith("video/");
  ui.media.src = objectUrl;
  ui.media.toggleAttribute("data-audio-only", !isVideo);
  ui.mediaFrame.hidden = false;
  ui.mediaCaption.textContent = `${isVideo ? "video" : "audio"} · ${megabytes(
    file.size
  )}`;

  ui.drop.setAttribute("data-ready", "");
  ui.drop.dataset.state = "";
  ui.drop.querySelector(".drop__label")!.textContent = file.name;
  ui.drop.querySelector(".drop__sub")!.textContent = "choose another";

  if (!mediaSource) {
    mediaSource = audioContext.createMediaElementSource(ui.media);
    mediaSource.connect(monitor);
  }
  await listenTo(mediaSource);

  try {
    await ui.media.play();
    say(`playing ${file.name}`, "busy");
  } catch {
    say("press play to start", "");
  }
}

async function startMicrophone(deviceId?: string) {
  try {
    await start();
    microphone?.stop();
    microphone = new MicrophoneStream(deviceId ? { deviceId } : {});
    const stream = await microphone.start();

    // Labels are empty until access has been granted, so the list is worth
    // asking for only after a stream exists.
    const devices = await microphone.refreshDevices();
    const active = stream.getAudioTracks()[0]?.getSettings().deviceId;
    ui.input.innerHTML = "";
    for (const device of devices) {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || device.deviceId;
      option.selected = device.deviceId === active;
      ui.input.append(option);
    }
    ui.input.disabled = devices.length < 2;
    ui.deafen.disabled = false;

    if (microphoneSource) microphoneSource.disconnect();
    microphoneSource = audioContext.createMediaStreamSource(stream);
    await listenTo(microphoneSource);
    say(`listening · ${microphone.label}`, "busy");
  } catch (error) {
    say(`no microphone — ${(error as Error).message}`, "error");
  }
}

function stopMicrophone() {
  if (!microphone) return;
  microphone.stop();
  microphone = undefined;
  if (microphoneSource) {
    if (listening === microphoneSource) {
      microphoneSource.disconnect(detector.analyser);
      listening = undefined;
    }
    microphoneSource.disconnect();
    microphoneSource = undefined;
  }
  ui.deafen.disabled = true;
  say("idle", "");
}

function draw() {
  requestAnimationFrame(draw);
  if (!listening) return;

  const { label, tones } = detector.tick();
  const level = Number(ui.level.value);
  const focus = Number(ui.focus.value);
  const attack = Number(ui.attack.value);
  const release = Number(ui.release.value);
  const now = audioContext.currentTime;

  const context = ui.scope.getContext("2d")!;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(ui.scope.clientWidth * ratio);
  const height = Math.round(ui.scope.clientHeight * ratio);
  if (ui.scope.width !== width || ui.scope.height !== height) {
    ui.scope.width = width;
    ui.scope.height = height;
  }
  context.clearRect(0, 0, width, height);
  context.fillStyle = getComputedStyle(ui.scope).color;

  const step = width / tones.length;
  const heard: string[] = [];

  tones.forEach(({ prominence, notation, octave }, i) => {
    const value = Math.pow(prominence, focus);
    const voice = voices[i];
    if (voice) {
      // Arriving and leaving are different gestures, so they get different
      // time constants — a swell that decays as slowly as it rose smears
      // every chord into the next one.
      const rising = value > voice.gain.gain.value / (level || 1);
      voice.gain.gain.setTargetAtTime(
        value * level,
        now,
        rising ? attack : release
      );
    }

    const bar = value * height * 0.9;
    context.globalAlpha = Math.max(0.06, value);
    context.fillRect(
      i * step,
      (height - bar) / 2,
      Math.max(1, step - ratio),
      Math.max(1, bar)
    );

    if (value > 0.4) heard.push(`${notation}${octave}`);
  });

  context.globalAlpha = 1;
  ui.chord.textContent = label || "—";
  ui.scopeNotes.textContent = heard.join(" ") || " ";
}

function say(message: string, state: "busy" | "error" | "done" | "") {
  ui.status.textContent = message;
  if (state) {
    ui.status.dataset.state = state;
  } else {
    delete ui.status.dataset.state;
  }
}

function megabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
