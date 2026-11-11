'use strict';

// Every sound is synthesized from math, then played through Web Audio.

const SR = 44100;

/** Small seeded PRNG (returns 0..1), so synthesized sounds and the background are the same every run. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function normalize(buf, target = 1) {
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    if (peak > 0) for (let i = 0; i < buf.length; i++) buf[i] = buf[i] / peak * target;
    return buf;
}

/** Chamberlin state-variable filter. */
class Svf {
    constructor() { this.low = 0; this.band = 0; }
    lowpass(input, cutoff, q) {
        const f = 2 * Math.sin(Math.PI * Math.min(cutoff, 6000) / SR);
        this.low += f * this.band;
        const high = input - this.low - q * this.band;
        this.band += f * high;
        return this.low;
    }
    bandpass(input, cutoff, q) {
        this.lowpass(input, cutoff, q);
        return this.band;
    }
}

// ---- Sound effects ----

/**
 * A dull thud: a soft, low-passed impulse followed by a few low, damped resonances,
 * with a slight downward pitch drop like a heavy ball hitting something solid.
 */
function synthesizeClick(rng) {
    const length = Math.floor(SR * 0.22);
    const buf = new Float32Array(length);
    // Resonant modes: [freq Hz, decay s, amplitude]
    const modes = [
        [110 + rng() * 30, 0.060, 1.0],
        [260 + rng() * 50, 0.030, 0.5],
        [560 + rng() * 90, 0.014, 0.25],
        [1100 + rng() * 200, 0.006, 0.12], // a hint of contact "knock"
    ];
    const phases = modes.map(() => rng() * Math.PI * 2);

    let lp = 0;
    for (let i = 0; i < length; i++) {
        const t = i / SR;
        let s = 0;
        // Pitch drops ~25% in the first few milliseconds, which reads as "weight".
        const bend = 1 + 0.25 * Math.exp(-t / 0.012);
        for (let m = 0; m < modes.length; m++)
            s += modes[m][2] * Math.exp(-t / modes[m][1]) * Math.sin(2 * Math.PI * modes[m][0] * bend * t + phases[m]);

        // Initial impact: a few ms of heavily low-passed noise (soft, not snappy).
        const noise = rng() * 2 - 1;
        lp += (noise - lp) * 0.06;
        s += 3.0 * lp * Math.exp(-t / 0.005);

        // Soft 1 ms attack so it's a thump rather than a click.
        buf[i] = s * Math.min(1, t / 0.001);
    }
    return normalize(buf);
}

/** Game-over sound: an impact followed by a descending "power-down". */
function synthesizeLose() {
    const length = Math.floor(SR * 1.4);
    const buf = new Float32Array(length);
    const rng = mulberry32(99);
    let ph1 = 0, ph2 = 0.3, subPh = 0, lp = 0, noiseLp = 0;

    for (let i = 0; i < length; i++) {
        const t = i / SR;

        // Impact: short noise crack + low boom
        const noise = rng() * 2 - 1;
        noiseLp += (noise - noiseLp) * 0.35;
        const crack = noiseLp * Math.exp(-t / 0.04) * 0.9;
        subPh += 2 * Math.PI * (40 + 90 * Math.exp(-t / 0.05)) / SR;
        const boom = Math.sin(subPh) * Math.exp(-t / 0.35) * 0.9;

        // Power-down: two detuned saws sliding from ~520 Hz to ~55 Hz, with a wobble
        const sweep = 55 + 465 * Math.exp(-t / 0.35);
        const wobble = 1 + 0.03 * Math.sin(2 * Math.PI * 7 * t);
        ph1 = (ph1 + sweep * wobble / SR) % 1;
        ph2 = (ph2 + sweep * wobble * 1.012 / SR) % 1;
        const saw = ((2 * ph1 - 1) + (2 * ph2 - 1)) * 0.5;
        const cutoff = 300 + 2500 * Math.exp(-t / 0.4);
        lp += (saw - lp) * (1 - Math.exp(-2 * Math.PI * cutoff / SR));
        const env = Math.min(1, t / 0.01) * Math.min(1, (1.4 - t) / 0.5);

        buf[i] = Math.tanh((crack + boom + lp * env * 0.6) * 1.2);
    }
    return normalize(buf);
}

// ---- Power-up and event effects ----

/**
 * Builds every power-up and ball-event sound from a few primitives: pitch-swept tones,
 * filtered noise sweeps and short bursts. Returns { name: Float32Array }.
 */
function synthesizeEffects() {
    const rng = mulberry32(4242);
    const make = seconds => new Float32Array(Math.floor(SR * seconds));
    const midi = n => 440 * Math.pow(2, (n - 69) / 12);

    /**
     * Adds a tone from f0 to f1 Hz (exponential glide) starting at `at` seconds.
     * wave: 'sine' | 'tri' | 'square' | 'saw'. vib: [rate Hz, depth fraction].
     */
    function tone(buf, at, dur, f0, f1, { wave = 'sine', vol = 1, attack = 0.005, decay = null, vib = null } = {}) {
        const start = Math.floor(at * SR), n = Math.floor(dur * SR);
        let ph = rng();
        for (let i = 0; i < n && start + i < buf.length; i++) {
            const t = i / SR, p = t / dur;
            let f = f0 * Math.pow(f1 / f0, p);
            if (vib) f *= 1 + vib[1] * Math.sin(2 * Math.PI * vib[0] * t);
            ph = (ph + f / SR) % 1;
            let v;
            switch (wave) {
                case 'tri': v = 1 - 4 * Math.abs(ph - 0.5); break;
                case 'square': v = ph < 0.5 ? 0.7 : -0.7; break;
                case 'saw': v = (2 * ph - 1) * 0.7; break;
                default: v = Math.sin(2 * Math.PI * ph);
            }
            const env = Math.min(1, t / attack) * (decay ? Math.exp(-t / decay) : Math.min(1, (dur - t) / 0.02));
            buf[start + i] += v * env * vol;
        }
    }

    /** Band-passed noise whose centre sweeps from c0 to c1 Hz; env(p) shapes it over 0..1. */
    function noise(buf, at, dur, c0, c1, { vol = 1, q = 0.6, env = p => Math.sin(Math.PI * p) } = {}) {
        const start = Math.floor(at * SR), n = Math.floor(dur * SR);
        const f = new Svf();
        for (let i = 0; i < n && start + i < buf.length; i++) {
            const p = i / n;
            const c = c0 * Math.pow(c1 / c0, p);
            buf[start + i] += f.bandpass(rng() * 2 - 1, c, q) * env(p) * vol;
        }
    }

    const fx = {};

    // Good power-up: a bright rising major arpeggio with a sparkle on top.
    fx.powerUp = make(0.55);
    [72, 76, 79, 84].forEach((n, i) => tone(fx.powerUp, i * 0.055, 0.3, midi(n), midi(n), { wave: 'tri', vol: 0.7, decay: 0.12 }));
    tone(fx.powerUp, 0.22, 0.3, midi(91), midi(91), { vol: 0.25, decay: 0.08 });

    // Curse: a sour, wobbling downward slide (tritone apart).
    fx.curse = make(0.8);
    tone(fx.curse, 0, 0.75, 520, 150, { wave: 'saw', vol: 0.5, vib: [9, 0.05] });
    tone(fx.curse, 0, 0.75, 368, 106, { wave: 'square', vol: 0.3, vib: [9, 0.05] });

    // Slow-mo: a deep "time-stretch" whoosh falling in pitch.
    fx.slow = make(0.9);
    tone(fx.slow, 0, 0.85, 700, 90, { wave: 'tri', vol: 0.6 });
    noise(fx.slow, 0, 0.85, 3000, 250, { vol: 0.6 });

    // Tiny: a quick upward zip.
    fx.tiny = make(0.3);
    tone(fx.tiny, 0, 0.18, 400, 2200, { wave: 'square', vol: 0.4 });
    tone(fx.tiny, 0.17, 0.12, 2400, 2400, { vol: 0.35, decay: 0.04 });

    // Shield: a shimmering chord that swells in.
    fx.shield = make(0.9);
    for (const n of [67, 71, 74, 79])
        tone(fx.shield, 0, 0.85, midi(n), midi(n), { vol: 0.35, attack: 0.08, vib: [6, 0.006] });
    noise(fx.shield, 0, 0.6, 5000, 8000, { vol: 0.15 });

    // Autopilot: robotic computer bleeps.
    fx.auto = make(0.45);
    [880, 1320, 990, 1760].forEach((f, i) => tone(fx.auto, i * 0.09, 0.07, f, f, { wave: 'square', vol: 0.35 }));

    // Freeze: crystalline high tinkles over a cold hiss.
    fx.freeze = make(0.8);
    [96, 91, 98, 93, 100].forEach((n, i) => tone(fx.freeze, i * 0.045, 0.4, midi(n), midi(n), { vol: 0.35, decay: 0.09 }));
    noise(fx.freeze, 0, 0.7, 6000, 3000, { vol: 0.35, q: 0.3, env: p => Math.exp(-p * 4) });

    // Bomb: a big boom with a crackling tail.
    fx.boom = make(1.1);
    tone(fx.boom, 0, 1.0, 120, 30, { vol: 1.0, attack: 0.002, decay: 0.3 });
    noise(fx.boom, 0, 1.0, 2500, 120, { vol: 2.0, q: 0.9, env: p => Math.exp(-p * 5) });

    // Rush wind-up: a rising warning tone. Launch: a fast whoosh.
    fx.incoming = make(0.5);
    tone(fx.incoming, 0, 0.45, 300, 900, { wave: 'saw', vol: 0.4 });
    fx.launch = make(0.35);
    noise(fx.launch, 0, 0.33, 600, 4000, { vol: 0.9, env: p => Math.min(1, p * 8) * Math.exp(-p * 4) });

    // Wobble: a bendy warble.
    fx.wobble = make(0.6);
    tone(fx.wobble, 0, 0.55, 330, 330, { wave: 'tri', vol: 0.55, vib: [11, 0.18] });

    // Giant: a swelling low rumble that climbs.
    fx.giant = make(0.9);
    tone(fx.giant, 0, 0.85, 55, 140, { wave: 'saw', vol: 0.55, attack: 0.3 });
    tone(fx.giant, 0, 0.85, 110, 280, { vol: 0.4, attack: 0.3 });

    // Grow / shrink: matching up and down slides.
    fx.grow = make(0.45);
    tone(fx.grow, 0, 0.4, 180, 520, { wave: 'tri', vol: 0.6 });
    fx.shrink = make(0.45);
    tone(fx.shrink, 0, 0.4, 900, 260, { wave: 'tri', vol: 0.6 });

    // Hunted: a soft "ding-dong, ding-dong" chime. Rounded bell tones keep it friendly,
    // while the repeated falling pair still reads as a heads-up.
    fx.hunted = make(0.85);
    [76, 72, 76, 72].forEach((n, i) => {
        const at = i * 0.16;
        tone(fx.hunted, at, 0.32, midi(n), midi(n), { vol: 0.6, attack: 0.01, decay: 0.12 });
        tone(fx.hunted, at, 0.2, midi(n + 12), midi(n + 12), { wave: 'tri', vol: 0.12, attack: 0.01, decay: 0.05 });
    });

    // Speed up: a revving engine-like rise.
    fx.speedUp = make(0.55);
    tone(fx.speedUp, 0, 0.5, 90, 420, { wave: 'saw', vol: 0.5, vib: [30, 0.08] });
    noise(fx.speedUp, 0, 0.5, 800, 3000, { vol: 0.3 });

    // Merge announced: two notes slide toward each other. Merged: a wet "gloop".
    fx.merge = make(0.5);
    tone(fx.merge, 0, 0.45, 300, 440, { vol: 0.5 });
    tone(fx.merge, 0, 0.45, 650, 440, { vol: 0.5 });
    fx.merged = make(0.3);
    tone(fx.merged, 0, 0.25, 180, 600, { vol: 0.9, decay: 0.08 });

    // Split announced: a cracking creak. Split: a sharp pop.
    fx.split = make(0.5);
    for (let i = 0; i < 6; i++) noise(fx.split, i * 0.07 + rng() * 0.02, 0.03, 2500, 1500, { vol: 1.2, q: 0.4 });
    fx.splitPop = make(0.3);
    noise(fx.splitPop, 0, 0.12, 4000, 800, { vol: 1.4, env: p => Math.exp(-p * 6) });
    tone(fx.splitPop, 0, 0.2, 900, 300, { vol: 0.6, decay: 0.05 });

    // New ball: a friendly two-note chime. Move it: a nagging double beep.
    fx.newBall = make(0.6);
    tone(fx.newBall, 0, 0.5, midi(79), midi(79), { vol: 0.5, decay: 0.15 });
    tone(fx.newBall, 0.1, 0.5, midi(86), midi(86), { vol: 0.5, decay: 0.2 });
    fx.moveIt = make(0.35);
    tone(fx.moveIt, 0, 0.1, 1000, 1000, { wave: 'square', vol: 0.35 });
    tone(fx.moveIt, 0.15, 0.1, 1000, 1000, { wave: 'square', vol: 0.35 });

    // A power-up running out: a soft descending blip.
    fx.expire = make(0.3);
    tone(fx.expire, 0, 0.1, midi(79), midi(79), { wave: 'tri', vol: 0.5, decay: 0.05 });
    tone(fx.expire, 0.08, 0.15, midi(72), midi(72), { wave: 'tri', vol: 0.5, decay: 0.06 });

    for (const k in fx) {
        const b = fx[k];
        // Short fade at the very end so nothing clicks off.
        const fade = Math.floor(0.01 * SR);
        for (let i = 0; i < fade; i++) b[b.length - 1 - i] *= i / fade;
        normalize(b);
    }
    return fx;
}

// ---- Music ----

/**
 * An original, seamlessly looping 128 BPM electronic track in A minor (Am - F - C - G),
 * generated from oscillators and noise. 16 bars: bars 1-8 are drums, offbeat bass, arpeggio
 * and pad, ending in a snare-roll build-up with a noise riser; bars 9-16 add a rolling bass,
 * open hats and a lead melody.
 *
 * render() is a generator that yields between steps so it can run in small slices
 * without freezing the page.
 */
const Music = (() => {
    const BPM = 128;
    const TOTAL_STEPS = 256; // 16th notes
    const STEP_SEC = 60 / BPM / 4;
    const ROOTS = [45, 41, 48, 43]; // A2, F2, C3, G2
    const IS_MINOR = [true, false, false, false];

    // Lead melody per 2-bar chord block: [step within block, MIDI note, length in steps]
    const MELODY = [
        [[0, 76, 3], [3, 74, 3], [6, 72, 2], [8, 74, 4], [12, 76, 4], [16, 79, 6], [22, 76, 2], [24, 74, 8]],
        [[0, 77, 3], [3, 76, 3], [6, 72, 2], [8, 72, 4], [12, 74, 4], [16, 76, 6], [22, 72, 2], [24, 69, 8]],
        [[0, 79, 3], [3, 76, 3], [6, 72, 2], [8, 76, 4], [12, 79, 4], [16, 84, 6], [22, 83, 2], [24, 79, 8]],
        [[0, 79, 3], [3, 81, 3], [6, 83, 2], [8, 81, 4], [12, 79, 4], [16, 74, 6], [22, 76, 2], [24, 71, 8]],
    ];

    const samplePos = steps => Math.round(steps * STEP_SEC * SR);
    const freq = midi => 440 * Math.pow(2, (midi - 69) / 12);
    const add = (buf, pos, v) => { buf[pos % buf.length] += v; };

    function kick(buf, pos) {
        const n = Math.floor(0.4 * SR);
        const rng = mulberry32(pos);
        let phase = 0;
        for (let i = 0; i < n; i++) {
            const t = i / SR;
            phase += 2 * Math.PI * (48 + 120 * Math.exp(-t / 0.03)) / SR;
            let v = Math.sin(phase) * Math.exp(-t / 0.3);
            v += (rng() * 2 - 1) * Math.exp(-t / 0.002) * 0.3; // beater click
            add(buf, pos + i, Math.tanh(v * 1.6) * 0.75);
        }
    }

    function clap(buf, pos, rng, vol) {
        const n = Math.floor(0.25 * SR);
        const f = new Svf();
        for (let i = 0; i < n; i++) {
            const t = i / SR;
            const env = t < 0.03 ? Math.exp(-(t % 0.01) / 0.003) : Math.exp(-(t - 0.03) / 0.1);
            const noise = f.bandpass(rng() * 2 - 1, 1400, 0.8);
            const body = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.04) * 0.3;
            add(buf, pos + i, (noise * env * 1.5 + body) * vol);
        }
    }

    function hat(buf, pos, rng, decay, vol) {
        const n = Math.floor((decay * 6 + 0.01) * SR);
        let p1 = 0, p2 = 0;
        for (let i = 0; i < n; i++) {
            const t = i / SR;
            const x = rng() * 2 - 1;
            const h1 = x - p1; p1 = x;   // differentiate twice = crude high-pass
            const h2 = h1 - p2; p2 = h1;
            add(buf, pos + i, h2 * 0.35 * Math.exp(-t / decay) * vol);
        }
    }

    function bass(buf, pos, length, note, vol) {
        const n = Math.floor(length) + Math.floor(0.02 * SR);
        const f = freq(note);
        let ph1 = 0, ph2 = 0.5;
        const lp = new Svf();
        for (let i = 0; i < n; i++) {
            const t = i / SR;
            ph1 = (ph1 + f / SR) % 1;
            ph2 = (ph2 + f * 1.006 / SR) % 1;
            const saw = (2 * ph1 - 1) + (2 * ph2 - 1);
            const sub = Math.sin(2 * Math.PI * f * 0.5 * t);
            const cutoff = 250 + 1400 * Math.exp(-t / 0.06);
            const v = lp.lowpass(saw * 0.5, cutoff, 0.6) + sub * 0.5;
            const env = Math.min(1, t / 0.003) * (i < length ? 1 : Math.exp(-(i - length) / (0.005 * SR)));
            add(buf, pos + i, v * env * vol);
        }
    }

    function pluck(buf, send, pos, note, vol) {
        const n = Math.floor(0.3 * SR);
        const f = freq(note);
        let ph = 0;
        const lp = new Svf();
        for (let i = 0; i < n; i++) {
            const t = i / SR;
            ph = (ph + f / SR) % 1;
            const pulse = (ph < 0.3 ? 1 : -1) * 0.6 + (2 * ph - 1) * 0.4;
            let v = lp.lowpass(pulse, 800 + 3800 * Math.exp(-t / 0.05), 0.5);
            v *= Math.min(1, t / 0.002) * Math.exp(-t / 0.09) * vol;
            add(buf, pos + i, v);
            add(send, pos + i, v * 0.6);
        }
    }

    function pad(buf, pos, length, note, vol) {
        const f = freq(note);
        const detune = [0.994, 1.0, 1.007];
        const ph = [0.1, 0.4, 0.7];
        const lp = new Svf();
        for (let i = 0; i < length; i++) {
            const t = i / SR;
            let s = 0;
            for (let v = 0; v < 3; v++) {
                ph[v] = (ph[v] + f * detune[v] / SR) % 1;
                s += 2 * ph[v] - 1;
            }
            const env = Math.min(1, t / 0.4) * Math.min(1, (length - i) / (0.3 * SR));
            add(buf, pos + i, lp.lowpass(s / 3, 900, 0.7) * env * vol);
        }
    }

    function lead(buf, send, pos, length, note, vol) {
        const f = freq(note);
        const detune = [0.992, 0.997, 1.0, 1.003, 1.008];
        const ph = detune.map((_, v) => v * 0.21);
        const lp = new Svf();
        const release = Math.floor(0.08 * SR);
        for (let i = 0; i < length + release; i++) {
            const t = i / SR;
            const vib = 1 + 0.003 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.25);
            let s = 0;
            for (let v = 0; v < ph.length; v++) {
                ph[v] = (ph[v] + f * detune[v] * vib / SR) % 1;
                s += 2 * ph[v] - 1;
            }
            const env = Math.min(1, t / 0.006) * (i < length ? 1 : 1 - (i - length) / release);
            const v2 = lp.lowpass(s / ph.length, 2200 + 1800 * Math.exp(-t / 0.15), 0.5) * env * vol;
            add(buf, pos + i, v2);
            add(send, pos + i, v2 * 0.7);
        }
    }

    function riser(buf, start, end, rng) {
        const bp = new Svf();
        const n = end - start;
        for (let i = 0; i < n; i++) {
            const p = i / n;
            const v = bp.bandpass(rng() * 2 - 1, 300 + 4500 * p * p, 0.5);
            add(buf, start + i, v * 0.22 * p * p);
        }
    }

    function* render() {
        const len = samplePos(TOTAL_STEPS);
        const drums = new Float32Array(len); // not ducked
        const synth = new Float32Array(len); // ducked by the kick (sidechain pump)
        const send = new Float32Array(len);  // delay send
        const rng = mulberry32(7);
        const kicks = [];

        for (let st = 0; st < TOTAL_STEPS; st++) {
            const inBar = st % 16;
            const chord = Math.floor(st / 32) % 4;
            const drop = st >= 128;              // second half
            const buildUp = st >= 112 && st < 128;
            const pos = samplePos(st);

            // --- Drums ---
            const kickBreak = st >= 120 && st < 128;
            if (inBar % 4 === 0 && !kickBreak) {
                kick(drums, pos);
                kicks.push(pos);
            }
            if (inBar === 4 || inBar === 12) clap(drums, pos, rng, 0.55);
            if (buildUp) clap(drums, pos, rng, 0.12 + 0.4 * (st - 112) / 16);

            if (drop && inBar % 4 === 2) hat(drums, pos, rng, 0.17, 0.28);
            else hat(drums, pos, rng, 0.025, inBar % 4 === 2 ? 0.22 : 0.1);

            // --- Bass ---
            const bassNote = ROOTS[chord] + 12;
            if (drop) {
                if (inBar % 4 !== 0) bass(synth, pos, samplePos(1) * 0.85, bassNote, 0.32);
            } else if (inBar % 4 === 2) {
                bass(synth, pos, samplePos(2) * 0.9, bassNote, 0.36);
            }

            // --- Arpeggio ---
            const third = IS_MINOR[chord] ? 3 : 4;
            const pattern = [0, 7, 12, third + 12, 12, 7, third, 7];
            const arpNote = ROOTS[chord] + 24 + pattern[inBar % 8];
            const arpVol = drop ? 0.15 : 0.12 + 0.06 * st / 128;
            pluck(synth, send, pos, arpNote, arpVol);

            // --- Pad: one chord every 2 bars ---
            if (st % 32 === 0) {
                const r = ROOTS[chord] + 12;
                for (const n of [r, r + third, r + 7, r + 12])
                    pad(synth, pos, samplePos(32), n, drop ? 0.035 : 0.05);
            }

            // --- Lead melody in the second half ---
            if (drop)
                for (const [step, note, l] of MELODY[chord])
                    if (step === st % 32) lead(synth, send, pos, samplePos(l), note, 0.11);

            yield;
        }

        riser(drums, samplePos(96), samplePos(128), rng);
        yield;

        // Dotted-8th feedback delay, computed circularly so the loop stays seamless.
        const d = samplePos(3);
        const echo = new Float32Array(len);
        for (let pass = 0; pass < 3; pass++) {
            for (let i = 0; i < len; i++) echo[i] = send[i] + 0.38 * echo[(i - d + len) % len];
            yield;
        }
        for (let i = 0; i < len; i++) synth[i] += echo[i] * 0.45;

        // Sidechain duck: synths dip after each kick and swell back.
        const mix = new Float32Array(len);
        let k = 0;
        for (let i = 0; i < len; i++) {
            while (k + 1 < kicks.length && kicks[k + 1] <= i) k++;
            const since = kicks.length === 0 || kicks[0] > i ? 1 : (i - kicks[k]) / SR;
            const duck = 0.3 + 0.7 * Math.pow(Math.min(1, since / 0.2), 1.6);
            mix[i] = drums[i] + synth[i] * duck;
        }
        yield;

        // Gentle saturation and normalize.
        let pre = 0;
        for (let i = 0; i < len; i++) pre = Math.max(pre, Math.abs(mix[i]));
        for (let i = 0; i < len; i++) mix[i] = Math.tanh(mix[i] / pre * 1.4);
        return normalize(mix, 0.9);
    }

    return { render };
})();

/** Runs a generator a few milliseconds at a time, then calls done(result). */
function runInSlices(gen, budgetMs, done) {
    function slice() {
        const t0 = performance.now();
        let r;
        do r = gen.next(); while (!r.done && performance.now() - t0 < budgetMs);
        if (r.done) done(r.value);
        else setTimeout(slice, 0);
    }
    setTimeout(slice, 0);
}

// ---- Playback ----

/** Collision clacks, power-up and event sounds, the game-over sound and the looping soundtrack. */
class GameAudio {
    static MUSIC_LEVEL = 0.3;   // soundtrack's base level
    static MAX_PER_FRAME = 6;

    constructor() {
        const rng = mulberry32(1234);
        this.clickData = Array.from({ length: 8 }, () => synthesizeClick(rng));
        this.loseData = synthesizeLose();
        this.effectData = synthesizeEffects();
        this.effectLastPlayed = {};
        this.musicData = null;
        this.ctx = null;
        this.userVolume = 1;
        this.sfxVolume = 1;
        this.musicWanted = false;
        this.musicVoice = null;
        this.playedThisFrame = 0;
        runInSlices(Music.render(), 8, data => {
            this.musicData = data;
            this._onMusicReady();
        });
    }

    /** Creates/resumes the AudioContext. Must be called from a user gesture (click or key). */
    unlock() {
        if (!this.ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            try { this.ctx = new AC(); } catch { return; }
            this.master = this.ctx.createGain();
            this.master.connect(this.ctx.destination);
            this.musicBus = this.ctx.createGain();
            this.musicBus.gain.value = GameAudio.MUSIC_LEVEL * this.userVolume;
            this.musicBus.connect(this.master);
            this.sfxBus = this.ctx.createGain();
            this.sfxBus.gain.value = this.sfxVolume;
            this.sfxBus.connect(this.master);
            this.clickBuffers = this.clickData.map(d => this._buffer(d));
            this.loseBuffer = this._buffer(this.loseData);
            this.effectBuffers = {};
            for (const k in this.effectData) this.effectBuffers[k] = this._buffer(this.effectData[k]);
            this._onMusicReady();
        }
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    }

    _buffer(data) {
        const b = this.ctx.createBuffer(1, data.length, SR);
        if (b.copyToChannel) b.copyToChannel(data, 0);
        else b.getChannelData(0).set(data);
        return b;
    }

    _onMusicReady() {
        if (!this.ctx || !this.musicData || this.musicBuffer) return;
        this.musicBuffer = this._buffer(this.musicData);
        if (this.musicWanted && !this.musicVoice) this._startVoice();
    }

    /** Music volume, 0..1 (scales the soundtrack's base level). */
    get musicVolume() { return this.userVolume; }
    set musicVolume(v) {
        this.userVolume = Math.min(1, Math.max(0, v));
        if (this.musicBus)
            this.musicBus.gain.setTargetAtTime(GameAudio.MUSIC_LEVEL * this.userVolume, this.ctx.currentTime, 0.01);
    }

    /** Sound-effect volume, 0..1 (collisions, power-ups, events and the game-over sound). */
    get effectsVolume() { return this.sfxVolume; }
    set effectsVolume(v) {
        this.sfxVolume = Math.min(1, Math.max(0, v));
        if (this.sfxBus)
            this.sfxBus.gain.setTargetAtTime(this.sfxVolume, this.ctx.currentTime, 0.01);
    }

    /** Plays a medium thud so the player can hear the effect volume they picked. */
    previewEffect() {
        if (this.ctx && this.ctx.state === 'running') this._oneShot(this.clickBuffers[0], 0.45, 1);
    }

    /** Starts the soundtrack from the top; a track that is still playing dips out first. */
    startMusic() {
        this.musicWanted = true;
        this._startVoice();
    }

    /** Fades the soundtrack out. */
    stopMusic() {
        this.musicWanted = false;
        if (this.musicVoice) {
            this._fadeOut(this.musicVoice, 1.2);
            this.musicVoice = null;
        }
    }

    _startVoice() {
        if (!this.ctx || !this.musicBuffer) return; // starts when the render finishes
        let at = this.ctx.currentTime;
        if (this.musicVoice) {
            this._fadeOut(this.musicVoice, 0.06);
            at += 0.06;
        }
        const src = this.ctx.createBufferSource();
        src.buffer = this.musicBuffer;
        src.loop = true;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(1, at + 0.05);
        src.connect(gain);
        gain.connect(this.musicBus);
        src.start(at);
        this.musicVoice = { src, gain };
    }

    _fadeOut(voice, seconds) {
        const now = this.ctx.currentTime;
        const g = voice.gain.gain;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0, now + seconds);
        voice.src.stop(now + seconds + 0.02);
    }

    _oneShot(buffer, volume, rate) {
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = rate;
        const gain = this.ctx.createGain();
        gain.gain.value = volume;
        src.connect(gain);
        gain.connect(this.sfxBus);
        src.start();
    }

    beginFrame() { this.playedThisFrame = 0; }

    /**
     * @param impactSpeed relative speed along the collision normal (pixels/sec)
     * @param size average radius of the two balls, used to shift the pitch
     */
    play(impactSpeed, size) {
        if (!this.ctx || this.ctx.state !== 'running' || this.playedThisFrame >= GameAudio.MAX_PER_FRAME) return;
        if (impactSpeed < 25) return; // ignore gentle touches / resting contact

        let volume = Math.min(1, Math.max(0.05, impactSpeed / 600));
        volume = Math.pow(volume, 1.3) * 0.6;
        // Larger balls sound slightly lower.
        const rate = Math.min(1.35, Math.max(0.75, 22 / size)) * (0.95 + Math.random() * 0.1);

        this._oneShot(this.clickBuffers[Math.floor(Math.random() * this.clickBuffers.length)], volume, rate);
        this.playedThisFrame++;
    }

    /** Effect loudness, so a bomb is loud and a reminder blip stays in the background. */
    static EFFECT_LEVELS = {
        powerUp: 0.4, curse: 0.35, slow: 0.4, tiny: 0.35, shield: 0.35, auto: 0.18, freeze: 0.4, boom: 0.6,
        incoming: 0.25, launch: 0.3, wobble: 0.3, giant: 0.4, grow: 0.3, shrink: 0.3, hunted: 0.22, speedUp: 0.3,
        merge: 0.3, merged: 0.35, split: 0.3, splitPop: 0.35, newBall: 0.3, moveIt: 0.25, expire: 0.25,
    };

    /** Plays a named power-up or event sound. The same sound won't stack within 60 ms. */
    playEffect(name) {
        if (!this.ctx || this.ctx.state !== 'running' || !this.effectBuffers[name]) return;
        const now = this.ctx.currentTime;
        if (now - (this.effectLastPlayed[name] ?? -1) < 0.06) return;
        this.effectLastPlayed[name] = now;
        this._oneShot(this.effectBuffers[name], GameAudio.EFFECT_LEVELS[name] ?? 0.3, 1);
    }

    playLose() {
        if (this.ctx) this._oneShot(this.loseBuffer, 0.55, 1);
    }
}
