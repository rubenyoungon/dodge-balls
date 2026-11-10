namespace DodgeBalls;

/// <summary>
/// Synthesizes an original, seamlessly looping 128 BPM electronic track in A minor
/// (Am - F - C - G). Everything is generated from oscillators and noise, no samples.
///
/// 16 bars: bars 1-8 are drums, offbeat bass, arpeggio and pad, ending in a snare-roll
/// build-up with a noise riser; bars 9-16 add a rolling bass, open hats and a lead melody.
/// </summary>
static class MusicGenerator
{
    const int SR = 44100;
    const double Bpm = 128;
    const int TotalSteps = 256; // 16th notes
    static readonly double StepSec = 60.0 / Bpm / 4;

    static readonly int[] Roots = { 45, 41, 48, 43 }; // A2, F2, C3, G2
    static readonly bool[] IsMinor = { true, false, false, false };

    // Lead melody per 2-bar chord block: (step within block, MIDI note, length in steps)
    static readonly (int step, int note, int len)[][] Melody =
    {
        new[] { (0, 76, 3), (3, 74, 3), (6, 72, 2), (8, 74, 4), (12, 76, 4), (16, 79, 6), (22, 76, 2), (24, 74, 8) },
        new[] { (0, 77, 3), (3, 76, 3), (6, 72, 2), (8, 72, 4), (12, 74, 4), (16, 76, 6), (22, 72, 2), (24, 69, 8) },
        new[] { (0, 79, 3), (3, 76, 3), (6, 72, 2), (8, 76, 4), (12, 79, 4), (16, 84, 6), (22, 83, 2), (24, 79, 8) },
        new[] { (0, 79, 3), (3, 81, 3), (6, 83, 2), (8, 81, 4), (12, 79, 4), (16, 74, 6), (22, 76, 2), (24, 71, 8) },
    };

    public static float[] Render()
    {
        int len = SamplePos(TotalSteps);
        var drums = new float[len];   // not ducked
        var synth = new float[len];   // ducked by the kick (sidechain pump)
        var send = new float[len];    // delay send
        var rng = new Random(7);
        var kicks = new List<int>();

        for (int st = 0; st < TotalSteps; st++)
        {
            int inBar = st % 16;
            int chord = (st / 32) % 4;
            bool drop = st >= 128;            // second half
            bool buildUp = st >= 112 && st < 128;
            int pos = SamplePos(st);

            // --- Drums ---
            bool kickBreak = st >= 120 && st < 128;
            if (inBar % 4 == 0 && !kickBreak)
            {
                Kick(drums, pos);
                kicks.Add(pos);
            }

            if (inBar == 4 || inBar == 12) Clap(drums, pos, rng, 0.55f);
            if (buildUp) Clap(drums, pos, rng, 0.12f + 0.4f * (st - 112) / 16f);

            if (drop && inBar % 4 == 2) Hat(drums, pos, rng, 0.17, 0.28f);
            else Hat(drums, pos, rng, 0.025, inBar % 4 == 2 ? 0.22f : 0.1f);

            // --- Bass ---
            int bassNote = Roots[chord] + 12;
            if (drop)
            {
                if (inBar % 4 != 0) Bass(synth, pos, SamplePos(1) * 0.85, bassNote, 0.32f);
            }
            else if (inBar % 4 == 2)
            {
                Bass(synth, pos, SamplePos(2) * 0.9, bassNote, 0.36f);
            }

            // --- Arpeggio ---
            int third = IsMinor[chord] ? 3 : 4;
            int[] pattern = { 0, 7, 12, third + 12, 12, 7, third, 7 };
            int arpNote = Roots[chord] + 24 + pattern[inBar % 8];
            float arpVol = drop ? 0.15f : 0.12f + 0.06f * st / 128f;
            Pluck(synth, send, pos, arpNote, arpVol);

            // --- Pad: one chord every 2 bars ---
            if (st % 32 == 0)
            {
                int r = Roots[chord] + 12;
                foreach (int n in new[] { r, r + third, r + 7, r + 12 })
                    Pad(synth, pos, SamplePos(32), n, drop ? 0.035f : 0.05f);
            }

            // --- Lead melody in the second half ---
            if (drop)
                foreach (var m in Melody[chord])
                    if (m.step == st % 32)
                        Lead(synth, send, pos, SamplePos(m.len), m.note, 0.11f);
        }

        Riser(drums, SamplePos(96), SamplePos(128), rng);

        // Dotted-8th feedback delay, computed circularly so the loop stays seamless.
        int d = SamplePos(3);
        var echo = new float[len];
        for (int pass = 0; pass < 3; pass++)
            for (int i = 0; i < len; i++)
                echo[i] = send[i] + 0.38f * echo[(i - d + len) % len];
        for (int i = 0; i < len; i++) synth[i] += echo[i] * 0.45f;

        // Sidechain duck: synths dip after each kick and swell back.
        var mix = new float[len];
        int k = 0;
        for (int i = 0; i < len; i++)
        {
            while (k + 1 < kicks.Count && kicks[k + 1] <= i) k++;
            double since = kicks.Count == 0 || kicks[0] > i ? 1 : (i - kicks[k]) / (double)SR;
            double duck = 0.3 + 0.7 * Math.Pow(Math.Min(1, since / 0.2), 1.6);
            mix[i] = drums[i] + synth[i] * (float)duck;
        }

        // Gentle saturation and normalize.
        float pre = mix.Max(MathF.Abs);
        for (int i = 0; i < len; i++) mix[i] = MathF.Tanh(mix[i] / pre * 1.4f);
        float peak = mix.Max(MathF.Abs);
        for (int i = 0; i < len; i++) mix[i] = mix[i] / peak * 0.9f;
        return mix;
    }

    static int SamplePos(int steps) => (int)Math.Round(steps * StepSec * SR);
    static double Freq(int midi) => 440 * Math.Pow(2, (midi - 69) / 12.0);

    static void Add(float[] buf, int pos, double v) => buf[pos % buf.Length] += (float)v;

    /// <summary>Chamberlin state-variable filter.</summary>
    struct Svf
    {
        double _low, _band;
        public double Low(double input, double cutoff, double q)
        {
            double f = 2 * Math.Sin(Math.PI * Math.Min(cutoff, 6000) / SR);
            _low += f * _band;
            double high = input - _low - q * _band;
            _band += f * high;
            return _low;
        }
        public double Band(double input, double cutoff, double q)
        {
            Low(input, cutoff, q);
            return _band;
        }
    }

    static void Kick(float[] buf, int pos)
    {
        int n = (int)(0.4 * SR);
        double phase = 0;
        var rng = new Random(pos);
        for (int i = 0; i < n; i++)
        {
            double t = (double)i / SR;
            double f = 48 + 120 * Math.Exp(-t / 0.03);
            phase += 2 * Math.PI * f / SR;
            double v = Math.Sin(phase) * Math.Exp(-t / 0.3);
            v += (rng.NextDouble() * 2 - 1) * Math.Exp(-t / 0.002) * 0.3; // beater click
            Add(buf, pos + i, Math.Tanh(v * 1.6) * 0.75);
        }
    }

    static void Clap(float[] buf, int pos, Random rng, float vol)
    {
        int n = (int)(0.25 * SR);
        var f = new Svf();
        for (int i = 0; i < n; i++)
        {
            double t = (double)i / SR;
            double env = t < 0.03
                ? Math.Exp(-(t % 0.01) / 0.003)
                : Math.Exp(-(t - 0.03) / 0.1);
            double noise = f.Band(rng.NextDouble() * 2 - 1, 1400, 0.8);
            double body = Math.Sin(2 * Math.PI * 190 * t) * Math.Exp(-t / 0.04) * 0.3;
            Add(buf, pos + i, (noise * env * 1.5 + body) * vol);
        }
    }

    static void Hat(float[] buf, int pos, Random rng, double decay, float vol)
    {
        int n = (int)((decay * 6 + 0.01) * SR);
        double p1 = 0, p2 = 0;
        for (int i = 0; i < n; i++)
        {
            double t = (double)i / SR;
            double x = rng.NextDouble() * 2 - 1;
            double h1 = x - p1; p1 = x;     // differentiate twice = crude high-pass
            double h2 = h1 - p2; p2 = h1;
            Add(buf, pos + i, h2 * 0.35 * Math.Exp(-t / decay) * vol);
        }
    }

    static void Bass(float[] buf, int pos, double length, int note, float vol)
    {
        int n = (int)length + (int)(0.02 * SR);
        double f = Freq(note);
        double ph1 = 0, ph2 = 0.5;
        var lp = new Svf();
        for (int i = 0; i < n; i++)
        {
            double t = (double)i / SR;
            ph1 = (ph1 + f / SR) % 1;
            ph2 = (ph2 + f * 1.006 / SR) % 1;
            double saw = (2 * ph1 - 1) + (2 * ph2 - 1);
            double sub = Math.Sin(2 * Math.PI * f * 0.5 * t);
            double cutoff = 250 + 1400 * Math.Exp(-t / 0.06);
            double v = lp.Low(saw * 0.5, cutoff, 0.6) + sub * 0.5;
            double env = Math.Min(1, t / 0.003) * (i < length ? 1 : Math.Exp(-(i - length) / (0.005 * SR)));
            Add(buf, pos + i, v * env * vol);
        }
    }

    static void Pluck(float[] buf, float[] send, int pos, int note, float vol)
    {
        int n = (int)(0.3 * SR);
        double f = Freq(note);
        double ph = 0;
        var lp = new Svf();
        for (int i = 0; i < n; i++)
        {
            double t = (double)i / SR;
            ph = (ph + f / SR) % 1;
            double pulse = (ph < 0.3 ? 1 : -1) * 0.6 + (2 * ph - 1) * 0.4;
            double v = lp.Low(pulse, 800 + 3800 * Math.Exp(-t / 0.05), 0.5);
            v *= Math.Min(1, t / 0.002) * Math.Exp(-t / 0.09) * vol;
            Add(buf, pos + i, v);
            Add(send, pos + i, v * 0.6);
        }
    }

    static void Pad(float[] buf, int pos, int length, int note, float vol)
    {
        double f = Freq(note);
        double[] detune = { 0.994, 1.0, 1.007 };
        double[] ph = { 0.1, 0.4, 0.7 };
        var lp = new Svf();
        for (int i = 0; i < length; i++)
        {
            double t = (double)i / SR;
            double s = 0;
            for (int v = 0; v < 3; v++)
            {
                ph[v] = (ph[v] + f * detune[v] / SR) % 1;
                s += 2 * ph[v] - 1;
            }
            double env = Math.Min(1, t / 0.4) * Math.Min(1, (length - i) / (0.3 * SR));
            Add(buf, pos + i, lp.Low(s / 3, 900, 0.7) * env * vol);
        }
    }

    static void Lead(float[] buf, float[] send, int pos, int length, int note, float vol)
    {
        double f = Freq(note);
        double[] detune = { 0.992, 0.997, 1.0, 1.003, 1.008 };
        var ph = new double[detune.Length];
        for (int v = 0; v < ph.Length; v++) ph[v] = v * 0.21;
        var lp = new Svf();
        int release = (int)(0.08 * SR);
        for (int i = 0; i < length + release; i++)
        {
            double t = (double)i / SR;
            double vib = 1 + 0.003 * Math.Sin(2 * Math.PI * 5.5 * t) * Math.Min(1, t / 0.25);
            double s = 0;
            for (int v = 0; v < ph.Length; v++)
            {
                ph[v] = (ph[v] + f * detune[v] * vib / SR) % 1;
                s += 2 * ph[v] - 1;
            }
            double env = Math.Min(1, t / 0.006) * (i < length ? 1 : 1 - (double)(i - length) / release);
            double v2 = lp.Low(s / ph.Length, 2200 + 1800 * Math.Exp(-t / 0.15), 0.5) * env * vol;
            Add(buf, pos + i, v2);
            Add(send, pos + i, v2 * 0.7);
        }
    }

    static void Riser(float[] buf, int start, int end, Random rng)
    {
        var bp = new Svf();
        int n = end - start;
        for (int i = 0; i < n; i++)
        {
            double p = (double)i / n;
            double v = bp.Band(rng.NextDouble() * 2 - 1, 300 + 4500 * p * p, 0.5);
            Add(buf, start + i, v * 0.22 * p * p);
        }
    }
}
