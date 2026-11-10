using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace DodgeBalls;

/// <summary>
/// Synthesizes billiard-ball "clack" sounds and plays them through a mixer,
/// so many collisions can sound at the same time.
/// </summary>
sealed class CollisionSound : IDisposable
{
    const int SampleRate = 44100;
    const int Variants = 8;
    const int MaxPerFrame = 6;

    readonly WaveFormat _format = WaveFormat.CreateIeeeFloatWaveFormat(SampleRate, 1);
    readonly MixingSampleProvider? _mixer;
    readonly WaveOut? _output;
    readonly float[][] _clicks;
    readonly Random _rng = new();
    int _playedThisFrame;

    public CollisionSound()
    {
        var rng = new Random(1234);
        _clicks = Enumerable.Range(0, Variants).Select(_ => SynthesizeClick(rng)).ToArray();

        try
        {
            _mixer = new MixingSampleProvider(_format) { ReadFully = true };
            _output = new WaveOut { BufferMilliseconds = 20, NumberOfBuffers = 3 };
            _mixer.AddMixerInput(_music);
            Task.Run(() => _music.Data = MusicGenerator.Render());
            _output.Init(_mixer);
            _output.Play();
        }
        catch
        {
            // No audio device: run silently.
            _output?.Dispose();
            _output = null;
            _mixer = null;
        }
    }

    readonly MusicLoop _music = new(WaveFormat.CreateIeeeFloatWaveFormat(SampleRate, 1));

    /// <summary>Starts the soundtrack from the top (it renders in the background at startup).</summary>
    public void StartMusic() => _music.Start();

    /// <summary>Fades the soundtrack out.</summary>
    public void StopMusic() => _music.Stop();

    /// <summary>Music volume, 0..1 (scales the soundtrack's base level).</summary>
    public float MusicVolume
    {
        get => _music.UserVolume;
        set => _music.UserVolume = Math.Clamp(value, 0f, 1f);
    }

    readonly float[] _loseSound = SynthesizeLose();

    /// <summary>Plays the game-over sound: an impact followed by a descending "power-down".</summary>
    public void PlayLose() => _mixer?.AddMixerInput(new OneShot(_loseSound, 0.55f, 1f, _format));

    static float[] SynthesizeLose()
    {
        int length = (int)(SampleRate * 1.4);
        var buf = new float[length];
        var rng = new Random(99);
        double ph1 = 0, ph2 = 0.3, subPh = 0, lp = 0, noiseLp = 0;

        for (int i = 0; i < length; i++)
        {
            double t = (double)i / SampleRate;

            // Impact: short noise crack + low boom
            double noise = rng.NextDouble() * 2 - 1;
            noiseLp += (noise - noiseLp) * 0.35;
            double crack = noiseLp * Math.Exp(-t / 0.04) * 0.9;
            subPh += 2 * Math.PI * (40 + 90 * Math.Exp(-t / 0.05)) / SampleRate;
            double boom = Math.Sin(subPh) * Math.Exp(-t / 0.35) * 0.9;

            // Power-down: two detuned saws sliding from ~520 Hz to ~55 Hz, with a wobble
            double sweep = 55 + 465 * Math.Exp(-t / 0.35);
            double wobble = 1 + 0.03 * Math.Sin(2 * Math.PI * 7 * t);
            ph1 = (ph1 + sweep * wobble / SampleRate) % 1;
            ph2 = (ph2 + sweep * wobble * 1.012 / SampleRate) % 1;
            double saw = ((2 * ph1 - 1) + (2 * ph2 - 1)) * 0.5;
            double cutoff = 300 + 2500 * Math.Exp(-t / 0.4);
            lp += (saw - lp) * (1 - Math.Exp(-2 * Math.PI * cutoff / SampleRate));
            double env = Math.Min(1, t / 0.01) * Math.Min(1, (1.4 - t) / 0.5);
            double tone = lp * env * 0.6;

            buf[i] = (float)Math.Tanh((crack + boom + tone) * 1.2);
        }

        float peak = buf.Max(MathF.Abs);
        for (int i = 0; i < length; i++) buf[i] /= peak;
        return buf;
    }

    public void BeginFrame() => _playedThisFrame = 0;

    /// <param name="impactSpeed">Relative speed along the collision normal (pixels/sec).</param>
    /// <param name="size">Average radius of the two balls, used to shift the pitch.</param>
    public void Play(float impactSpeed, float size)
    {
        if (_mixer == null || _playedThisFrame >= MaxPerFrame) return;
        if (impactSpeed < 25) return; // ignore gentle touches / resting contact

        float volume = Math.Clamp(impactSpeed / 600f, 0.05f, 1f);
        volume = MathF.Pow(volume, 1.3f) * 0.6f;

        // Larger balls sound slightly lower; resample by changing playback rate.
        float rate = Math.Clamp(22f / size, 0.75f, 1.35f) * (0.95f + (float)_rng.NextDouble() * 0.1f);

        _mixer.AddMixerInput(new OneShot(_clicks[_rng.Next(Variants)], volume, rate, _format));
        _playedThisFrame++;
    }

    /// <summary>
    /// A dull thud: a soft, low-passed impulse followed by a few low, damped resonances,
    /// with a slight downward pitch drop like a heavy ball hitting something solid.
    /// </summary>
    static float[] SynthesizeClick(Random rng)
    {
        int length = (int)(SampleRate * 0.22);
        var buf = new float[length];

        // Resonant modes (Hz) with their own decay times and amplitudes.
        var modes = new (double freq, double tau, double amp)[]
        {
            (110 + rng.NextDouble() * 30, 0.060, 1.0),
            (260 + rng.NextDouble() * 50, 0.030, 0.5),
            (560 + rng.NextDouble() * 90, 0.014, 0.25),
            (1100 + rng.NextDouble() * 200, 0.006, 0.12), // a hint of contact "knock"
        };
        var phases = modes.Select(_ => rng.NextDouble() * Math.PI * 2).ToArray();

        double lp = 0;
        for (int i = 0; i < length; i++)
        {
            double t = (double)i / SampleRate;
            double s = 0;

            // Pitch drops ~25% in the first few milliseconds, which reads as "weight".
            double bend = 1 + 0.25 * Math.Exp(-t / 0.012);
            for (int m = 0; m < modes.Length; m++)
                s += modes[m].amp * Math.Exp(-t / modes[m].tau) * Math.Sin(2 * Math.PI * modes[m].freq * bend * t + phases[m]);

            // Initial impact: a few ms of heavily low-passed noise (soft, not snappy).
            double noise = rng.NextDouble() * 2 - 1;
            lp += (noise - lp) * 0.06;
            s += 3.0 * lp * Math.Exp(-t / 0.005);

            // Soft 1 ms attack so it's a thump rather than a click.
            double attack = Math.Min(1, t / 0.001);
            buf[i] = (float)(s * attack);
        }

        float peak = buf.Max(MathF.Abs);
        for (int i = 0; i < length; i++) buf[i] /= peak;
        return buf;
    }

    public void Dispose()
    {
        _output?.Stop();
        _output?.Dispose();
    }

    /// <summary>Loops the soundtrack forever, with fades; outputs silence until it's rendered.</summary>
    sealed class MusicLoop : ISampleProvider
    {
        const float Volume = 0.3f;
        public volatile float UserVolume = 1f;
        public volatile float[]? Data;
        volatile bool _playing;
        volatile bool _restart;
        int _pos;
        float _gain;

        public MusicLoop(WaveFormat format) => WaveFormat = format;
        public WaveFormat WaveFormat { get; }

        public void Start() { _restart = true; _playing = true; }
        public void Stop() => _playing = false;

        public int Read(Span<float> buffer)
        {
            var data = Data;

            float target = _playing ? 1f : 0f;
            float volume = Volume * UserVolume;
            float fadeIn = 1f / (0.05f * SampleRate), fadeOut = 1f / (1.2f * SampleRate);

            for (int n = 0; n < buffer.Length; n++)
            {
                // A restart during a fade-out dips to silence first, then starts from the top.
                if (_restart) target = 0f;
                if (_restart && _gain < 0.001f) { _pos = 0; _restart = false; target = _playing ? 1f : 0f; }

                _gain = _gain < target ? Math.Min(target, _gain + fadeIn) : Math.Max(target, _gain - fadeOut * (_restart ? 20 : 1));

                if (data == null) { buffer[n] = 0; continue; }
                buffer[n] = data[_pos] * _gain * volume;
                if (_gain > 0) _pos = (_pos + 1) % data.Length;
            }
            return buffer.Length; // never finishes
        }
    }

    /// <summary>Plays a buffer once, at a volume and playback rate (linear interpolation).</summary>
    sealed class OneShot : ISampleProvider
    {
        readonly float[] _data;
        readonly float _volume;
        readonly float _rate;
        double _pos;

        public OneShot(float[] data, float volume, float rate, WaveFormat format)
        {
            _data = data; _volume = volume; _rate = rate; WaveFormat = format;
        }

        public WaveFormat WaveFormat { get; }

        public int Read(Span<float> buffer)
        {
            int n = 0;
            while (n < buffer.Length)
            {
                int i = (int)_pos;
                if (i >= _data.Length - 1) break;
                float frac = (float)(_pos - i);
                buffer[n] =(_data[i] + (_data[i + 1] - _data[i]) * frac) * _volume;
                _pos += _rate;
                n++;
            }
            return n; // returning < count tells the mixer this input is finished
        }
    }
}
