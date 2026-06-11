// Synthesized UI sound — no audio assets, everything is generated with the
// Web Audio API. Two voices: a soft wooden tap for buttons, and a short
// marimba-like phrase that plays while the seller reviews the piece.

let ctx = null;

function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// A single struck tone: fast attack, exponential ring-out, with a faint
// octave partial for marimba warmth.
function strike(c, dest, freq, when, dur, peak) {
  [
    [freq, peak],
    [freq * 2, peak * 0.18],
  ].forEach(([f, p]) => {
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(p, when + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(gain).connect(dest);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  });
}

// ——— Button tap: a quiet wooden tick ———

export function playTap() {
  const c = ensureCtx();
  if (!c) return;
  const now = c.currentTime;
  strike(c, c.destination, 940, now, 0.09, 0.1);
  strike(c, c.destination, 1880, now, 0.05, 0.035);
}

// ——— Ready-screen music: ~6s, F major pentatonic over a low drone ———

let musicGain = null;

export function startReadyMusic() {
  const c = ensureCtx();
  if (!c) return;
  stopReadyMusic(0.05);

  musicGain = c.createGain();
  musicGain.gain.value = 1;
  musicGain.connect(c.destination);

  const t0 = c.currentTime + 0.15;

  // Low F3 drone, slow swell in and out — the room tone.
  const drone = c.createOscillator();
  drone.type = 'sine';
  drone.frequency.value = 174.61;
  const droneGain = c.createGain();
  droneGain.gain.setValueAtTime(0, t0);
  droneGain.gain.linearRampToValueAtTime(0.045, t0 + 1.4);
  droneGain.gain.setValueAtTime(0.045, t0 + 4.2);
  droneGain.gain.linearRampToValueAtTime(0.0001, t0 + 6.5);
  drone.connect(droneGain).connect(musicGain);
  drone.start(t0);
  drone.stop(t0 + 6.6);

  // An unhurried six-note phrase: F4 A4 C5 G4 A4 F4.
  const phrase = [
    [349.23, 0.0],
    [440.0, 0.9],
    [523.25, 1.8],
    [392.0, 2.7],
    [440.0, 3.6],
    [349.23, 4.7],
  ];
  phrase.forEach(([freq, dt]) => strike(c, musicGain, freq, t0 + dt, 2.0, 0.13));
}

export function stopReadyMusic(fade = 0.35) {
  if (!musicGain || !ctx) return;
  const gain = musicGain;
  musicGain = null;
  const now = ctx.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(0.0001, now + fade);
  setTimeout(() => gain.disconnect(), fade * 1000 + 150);
}
