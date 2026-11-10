using System.Diagnostics;
using System.Drawing.Drawing2D;

namespace DodgeBalls;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        // DodgeBalls.exe --export-music music.wav  → writes the soundtrack to a file
        if (args.Length == 2 && args[0] == "--export-music")
        {
            var sw = Stopwatch.StartNew();
            var data = MusicGenerator.Render();
            using var w = new NAudio.Wave.WaveFileWriter(args[1], NAudio.Wave.WaveFormat.CreateIeeeFloatWaveFormat(44100, 1));
            w.WriteSamples(data, 0, data.Length);
            File.WriteAllText(args[1] + ".txt",
                $"render {sw.ElapsedMilliseconds} ms, {data.Length / 44100.0:0.0} s, nan={data.Any(float.IsNaN)}, " +
                $"peak={data.Max(MathF.Abs):0.00}, rms={Math.Sqrt(data.Average(x => (double)x * x)):0.000}");
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new GameForm());
    }
}

enum BallMode { Normal, RushWarning, Rushing, Curving, GrowWarning, Growing, Homing, Boosted, Joining, SplitWarning }

class Ball
{
    public float X, Y, VX, VY, R;
    public float Mass => R * R;

    // Random-event state
    public BallMode Mode;
    public float ModeTime;      // seconds left in the current mode
    public float CruiseSpeed;   // speed to return to after a rush
    public float TurnRate;      // rad/s, constant part of a curve (spiral)
    public float WobbleAmp, WobbleFreq, Phase; // oscillating part of a curve (snake)
    public float BaseR, BigR;   // normal and peak radius during a giant event
    public Ball? Partner;       // the ball this one is joining with
    public readonly Queue<PointF> Trail = new();
    public Color TrailColor;
}

enum PowerUpKind { Slow, Shrink, Shield, Bloat } // Bloat is cursed: it makes you bigger

class PowerUp
{
    public float X, Y;
    public PowerUpKind Kind;
    public float Life;   // seconds before it disappears
    public float Age;    // for the bob/pulse animation
}

record Difficulty(string Name, int StartBalls, float SpeedMultiplier, float NewBallEverySeconds, float EventEverySeconds, int MaxEventBalls, Color Color);

class GameForm : Form
{
    static readonly Difficulty[] Difficulties =
    {
        new("Easy",   5, 0.7f,  40f, 12f, 1, Color.FromArgb(60, 170, 100)),
        new("Normal", 8, 1.0f,  30f,  9f, 2, Color.FromArgb(50, 110, 220)),
        new("Hard",  12, 1.35f, 20f,  6f, 3, Color.FromArgb(200, 60, 60)),
    };
    int _difficultyIndex = 1;
    Difficulty CurrentDifficulty => Difficulties[_difficultyIndex];
    readonly float[] _bestByDifficulty = new float[Difficulties.Length];

    const float PlayerRadius = 14f;

    readonly List<Ball> _balls = new();
    readonly Random _rng = new();
    readonly Stopwatch _clock = new();
    readonly System.Windows.Forms.Timer _timer = new() { Interval = 10 };
    readonly CollisionSound _sound = new();

    PointF _mouse;
    bool _gameOver;
    bool _waitingToStart = true;
    float _survived;
    float _spawnTimer;
    double _lastTick;

    public GameForm()
    {
        Text = "Dodge Balls";
        ClientSize = new Size(1000, 700);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        BackColor = Color.FromArgb(18, 20, 28);
        DoubleBuffered = true;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);

        _timer.Tick += (_, _) => Tick();
        MouseLeave += (_, _) => ShowCursor();
        MouseDown += (_, e) => OnMouseDownGame(e);
        MouseMove += (_, e) => { if (_draggingVolume) SetVolumeFromX(e.X); };
        MouseUp += (_, _) => _draggingVolume = false;
        KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Escape) { if (_paused) Resume(); else Pause(); return; }
            if (_paused)
            {
                if (e.KeyCode == Keys.Left) _sound.MusicVolume -= 0.05f;
                if (e.KeyCode == Keys.Right) _sound.MusicVolume += 0.05f;
                return;
            }
            if (_gameOver || _waitingToStart)
            {
                if (e.KeyCode == Keys.Left || e.KeyCode == Keys.A) _difficultyIndex = Math.Max(0, _difficultyIndex - 1);
                if (e.KeyCode == Keys.Right || e.KeyCode == Keys.D) _difficultyIndex = Math.Min(Difficulties.Length - 1, _difficultyIndex + 1);
                if (e.KeyCode >= Keys.D1 && e.KeyCode < Keys.D1 + Difficulties.Length) _difficultyIndex = e.KeyCode - Keys.D1;
                if (e.KeyCode == Keys.Space || e.KeyCode == Keys.R || e.KeyCode == Keys.Enter) StartGame();
            }
        };
        Deactivate += (_, _) => { if (!_gameOver && !_waitingToStart) Pause(); };

        FormClosed += (_, _) => _sound.Dispose();

        _clock.Start();
        _timer.Start();
    }

    // ---- Pause menu ----

    bool _paused;
    bool _draggingVolume;
    bool _cursorHidden;
    PointF _pausedMouse;

    const int MenuW = 380, MenuH = 260;
    Rectangle MenuRect => new((ClientSize.Width - MenuW) / 2, (ClientSize.Height - MenuH) / 2, MenuW, MenuH);
    Rectangle SliderRect => new(MenuRect.X + 40, MenuRect.Y + 120, MenuW - 80, 8);
    Rectangle ResumeButton => new(MenuRect.X + 40, MenuRect.Bottom - 70, 140, 44);
    Rectangle QuitButton => new(MenuRect.Right - 180, MenuRect.Bottom - 70, 140, 44);

    void HideCursor() { if (!_cursorHidden) { Cursor.Hide(); _cursorHidden = true; } }
    void ShowCursor() { if (_cursorHidden) { Cursor.Show(); _cursorHidden = false; } }

    void Pause()
    {
        if (_paused) return;
        _paused = true;
        _pausedMouse = _mouse;
        ShowCursor();
    }

    void Resume()
    {
        _paused = false;
        _draggingVolume = false;
        // Put the cursor back where the red ball was, so resuming doesn't teleport it into a ball.
        if (!_gameOver && !_waitingToStart)
            Cursor.Position = PointToScreen(Point.Round(_pausedMouse));
        if (ClientRectangle.Contains(PointToClient(Cursor.Position))) HideCursor();
        _lastTick = _clock.Elapsed.TotalSeconds;
    }

    void OnMouseDownGame(MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        if (_paused)
        {
            var hit = SliderRect;
            hit.Inflate(10, 14);
            if (hit.Contains(e.Location)) { _draggingVolume = true; SetVolumeFromX(e.X); }
            else if (ResumeButton.Contains(e.Location)) Resume();
            else if (QuitButton.Contains(e.Location)) Close();
            return;
        }
        if (_gameOver || _waitingToStart)
        {
            // Clicking a difficulty starts with it; clicking anywhere else uses the selected one.
            for (int i = 0; i < Difficulties.Length; i++)
                if (DifficultyButton(i).Contains(e.Location)) _difficultyIndex = i;
            StartGame();
        }
    }

    const int DiffW = 150, DiffH = 48, DiffGap = 20;
    Rectangle DifficultyButton(int i)
    {
        int total = Difficulties.Length * DiffW + (Difficulties.Length - 1) * DiffGap;
        int x = (ClientSize.Width - total) / 2 + i * (DiffW + DiffGap);
        return new Rectangle(x, ClientSize.Height / 2 + 110, DiffW, DiffH);
    }

    void DrawDifficultySelector(Graphics g)
    {
        using var labelFont = new Font("Segoe UI", 12);
        using var buttonFont = new Font("Segoe UI", 13, FontStyle.Bold);
        var center = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        g.DrawString("Difficulty  (← / → or 1-3)", labelFont, Brushes.LightGray,
            ClientSize.Width / 2f, DifficultyButton(0).Y - 22, center);

        var mouse = PointToClient(Cursor.Position);
        for (int i = 0; i < Difficulties.Length; i++)
        {
            var d = Difficulties[i];
            var r = DifficultyButton(i);
            bool selected = i == _difficultyIndex;
            bool hover = r.Contains(mouse);
            if (hover) r.Inflate(4, 3); // small pop under the mouse

            using var path = RoundedRect(r, 8);
            var fill = selected ? (hover ? ControlPaint.Light(d.Color, 0.3f) : d.Color)
                     : hover ? Color.FromArgb(170, d.Color)
                     : Color.FromArgb(70, d.Color);
            using var brush = new SolidBrush(fill);
            g.FillPath(brush, path);
            if (selected || hover)
            {
                using var outline = new Pen(selected ? Color.White : Color.FromArgb(160, 255, 255, 255), 2f);
                g.DrawPath(outline, path);
            }
            g.DrawString(d.Name, buttonFont, selected || hover ? Brushes.White : Brushes.Gray, r, center);
        }
    }

    void SetVolumeFromX(int x) => _sound.MusicVolume = (x - SliderRect.X) / (float)SliderRect.Width;

    void DrawPauseMenu(Graphics g)
    {
        using var overlay = new SolidBrush(Color.FromArgb(160, 0, 0, 0));
        g.FillRectangle(overlay, ClientRectangle);

        var m = MenuRect;
        using (var panel = RoundedRect(m, 14))
        {
            using var fill = new SolidBrush(Color.FromArgb(235, 28, 32, 50));
            using var border = new Pen(Color.FromArgb(90, 140, 170, 255), 1.5f);
            g.FillPath(fill, panel);
            g.DrawPath(border, panel);
        }

        var center = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        using var titleFont = new Font("Segoe UI", 26, FontStyle.Bold);
        using var labelFont = new Font("Segoe UI", 12);
        using var buttonFont = new Font("Segoe UI", 13, FontStyle.Bold);
        g.DrawString("PAUSED", titleFont, Brushes.White, m.X + m.Width / 2f, m.Y + 42, center);

        // Volume slider
        var s = SliderRect;
        float vol = _sound.MusicVolume;
        g.DrawString("Music volume", labelFont, Brushes.LightGray, s.X, s.Y - 30);
        var pct = new StringFormat { Alignment = StringAlignment.Far };
        g.DrawString($"{vol * 100:0}%", labelFont, Brushes.White, s.Right, s.Y - 30, pct);
        using (var track = RoundedRect(s, 4))
        using (var trackBrush = new SolidBrush(Color.FromArgb(60, 70, 90)))
            g.FillPath(trackBrush, track);
        int filled = (int)(s.Width * vol);
        if (filled > 0)
        {
            using var fillPath = RoundedRect(new Rectangle(s.X, s.Y, Math.Max(filled, 8), s.Height), 4);
            using var fillBrush = new SolidBrush(Color.FromArgb(70, 140, 255));
            g.FillPath(fillBrush, fillPath);
        }
        DrawBall(g, s.X + filled, s.Y + s.Height / 2f, 11, Color.FromArgb(255, 255, 255), Color.FromArgb(150, 170, 210));

        // Buttons
        var mouse = PointToClient(Cursor.Position);
        DrawButton(g, ResumeButton, "Resume", buttonFont, Color.FromArgb(50, 110, 220), mouse);
        DrawButton(g, QuitButton, "Quit", buttonFont, Color.FromArgb(200, 60, 60), mouse);

        using var hintFont = new Font("Segoe UI", 9);
        using var hint = new SolidBrush(Color.FromArgb(140, 200, 210, 230));
        g.DrawString("Esc to resume", hintFont, hint, m.X + m.Width / 2f, m.Bottom + 16, center);
    }

    static void DrawButton(Graphics g, Rectangle r, string text, Font font, Color color, Point mouse)
    {
        bool hover = r.Contains(mouse);
        using var path = RoundedRect(r, 8);
        using var brush = new SolidBrush(hover ? ControlPaint.Light(color, 0.3f) : color);
        g.FillPath(brush, path);
        var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        g.DrawString(text, font, Brushes.White, r, fmt);
    }

    static GraphicsPath RoundedRect(Rectangle r, int radius)
    {
        int d = radius * 2;
        var p = new GraphicsPath();
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    void StartGame()
    {
        _balls.Clear();
        for (int i = 0; i < CurrentDifficulty.StartBalls; i++) SpawnBall();
        _survived = 0;
        _spawnTimer = 0;
        _eventTimer = 5f; // short grace period before the first event
        _bannerTime = 0;
        _pops.Clear();
        _powerUps.Clear();
        _powerUpTimer = 8f;
        _slowTime = _shrinkTime = _shieldTime = _bloatTime = 0;
        _playerR = PlayerRadius;
        _gameOver = false;
        _waitingToStart = false;
        _sound.StartMusic();
    }

    void SpawnBall()
    {
        float w = ClientSize.Width, h = ClientSize.Height;
        for (int attempt = 0; attempt < 200; attempt++)
        {
            float r = _rng.Next(14, 32);
            float x = r + (float)_rng.NextDouble() * (w - 2 * r);
            float y = r + (float)_rng.NextDouble() * (h - 2 * r);

            // keep a safe distance from the player and from other balls
            if (Dist(x, y, _mouse.X, _mouse.Y) < r + PlayerRadius + 160) continue;
            if (_balls.Any(b => Dist(x, y, b.X, b.Y) < r + b.R + 4)) continue;

            double angle = _rng.NextDouble() * Math.PI * 2;
            float speed = (120 + (float)_rng.NextDouble() * 140 + _survived * 3) * CurrentDifficulty.SpeedMultiplier;
            _balls.Add(new Ball
            {
                X = x, Y = y, R = r,
                VX = (float)Math.Cos(angle) * speed,
                VY = (float)Math.Sin(angle) * speed,
            });
            return;
        }
    }

    static float Dist(float x1, float y1, float x2, float y2)
    {
        float dx = x2 - x1, dy = y2 - y1;
        return MathF.Sqrt(dx * dx + dy * dy);
    }

    void Tick()
    {
        double now = _clock.Elapsed.TotalSeconds;
        float dt = (float)Math.Min(now - _lastTick, 0.05);
        _lastTick = now;

        if (_paused) { Invalidate(); return; }

        // The system cursor is hidden only while playing; menus need it for hovering/clicking.
        bool playing = !_gameOver && !_waitingToStart;
        if (playing && ClientRectangle.Contains(PointToClient(Cursor.Position))) HideCursor();
        else ShowCursor();

        UpdateMouse();

        if (!_gameOver && !_waitingToStart)
        {
            // Sub-step for more stable collisions at high speed
            _sound.BeginFrame();
            const int steps = 4;
            float ballDt = dt * BallTimeScale;
            for (int s = 0; s < steps; s++) Step(ballDt / steps);

            UpdateTrails();
            UpdatePowerUps(dt);
            UpdatePops(dt);

            _survived += dt;
            _eventTimer -= dt;
            if (_eventTimer <= 0) TriggerRandomEvent();
            _bannerTime = Math.Max(0, _bannerTime - dt);
            _spawnTimer += dt;
            if (_spawnTimer >= CurrentDifficulty.NewBallEverySeconds)
            {
                _spawnTimer = 0;
                SpawnBall();
            }

            if (_shieldTime <= 0 && _balls.Any(b => Dist(b.X, b.Y, _mouse.X, _mouse.Y) < b.R + _playerR))
            {
                _gameOver = true;
                _bestByDifficulty[_difficultyIndex] = Math.Max(_bestByDifficulty[_difficultyIndex], _survived);
                StartFall();
                _sound.StopMusic();
                _sound.PlayLose();
            }
        }
        else if (_gameOver)
        {
            FallStep(dt);
        }

        Invalidate();
    }

    const float Gravity = 1800f;
    PointF _playerFallPos;
    float _playerFallVX, _playerFallVY;

    // On losing, every ball gets a small upward pop and then drops out of the window.
    void StartFall()
    {
        foreach (var b in _balls)
        {
            if (b.Mode is BallMode.GrowWarning or BallMode.Growing) b.R = b.BaseR;
            b.Mode = BallMode.Normal;
            b.Partner = null;
            b.Trail.Clear();
            b.VX *= 0.3f;
            b.VY = -150 - (float)_rng.NextDouble() * 350;
        }
        _powerUps.Clear();
        _slowTime = _shieldTime = 0;
        _playerFallPos = _mouse;
        _playerFallVX = 0;
        _playerFallVY = -450;
    }

    void FallStep(float dt)
    {
        foreach (var b in _balls)
        {
            b.VY += Gravity * dt;
            b.X += b.VX * dt;
            b.Y += b.VY * dt;
        }
        _playerFallVY += Gravity * dt;
        _playerFallPos = new PointF(_playerFallPos.X + _playerFallVX * dt, _playerFallPos.Y + _playerFallVY * dt);
    }

    // Track the cursor even outside the window; the red ball stays pinned to the nearest edge.
    void UpdateMouse()
    {
        var p = PointToClient(Cursor.Position);
        _mouse = new PointF(
            Math.Clamp(p.X, _playerR, ClientSize.Width - _playerR),
            Math.Clamp(p.Y, _playerR, ClientSize.Height - _playerR));
    }

    void Step(float dt)
    {
        float w = ClientSize.Width, h = ClientSize.Height;

        foreach (var b in _balls)
        {
            UpdateBehavior(b, dt);
            b.X += b.VX * dt;
            b.Y += b.VY * dt;

            if (b.X - b.R < 0) { b.X = b.R; b.VX = Math.Abs(b.VX); }
            if (b.X + b.R > w) { b.X = w - b.R; b.VX = -Math.Abs(b.VX); }
            if (b.Y - b.R < 0) { b.Y = b.R; b.VY = Math.Abs(b.VY); }
            if (b.Y + b.R > h) { b.Y = h - b.R; b.VY = -Math.Abs(b.VY); }
        }

        // Elastic collisions between blue balls
        for (int i = 0; i < _balls.Count; i++)
        for (int j = i + 1; j < _balls.Count; j++)
        {
            Ball a = _balls[i], c = _balls[j];
            // A rushing ball ghosts through the others so its telegraphed line stays true.
            if (a.Mode == BallMode.Rushing || c.Mode == BallMode.Rushing) continue;
            if (a.Partner == c) continue; // joining balls are allowed to touch
            float dx = c.X - a.X, dy = c.Y - a.Y;
            float distSq = dx * dx + dy * dy;
            float minDist = a.R + c.R;
            if (distSq >= minDist * minDist || distSq == 0) continue;

            float dist = MathF.Sqrt(distSq);
            float nx = dx / dist, ny = dy / dist;

            // Push apart so they don't overlap
            float overlap = minDist - dist;
            float total = a.Mass + c.Mass;
            a.X -= nx * overlap * (c.Mass / total);
            a.Y -= ny * overlap * (c.Mass / total);
            c.X += nx * overlap * (a.Mass / total);
            c.Y += ny * overlap * (a.Mass / total);

            // Exchange momentum along the collision normal
            float relVel = (a.VX - c.VX) * nx + (a.VY - c.VY) * ny;
            if (relVel <= 0) continue; // already separating

            _sound.Play(relVel, (a.R + c.R) / 2);

            float impulse = 2 * relVel / total;
            a.VX -= impulse * c.Mass * nx;
            a.VY -= impulse * c.Mass * ny;
            c.VX += impulse * a.Mass * nx;
            c.VY += impulse * a.Mass * ny;
        }

        ResolveJoinsAndSplits();
    }

    // ---- Power-ups ----

    const float SlowDuration = 5f, ShrinkDuration = 6f, ShieldDuration = 3f;
    const float SlowFactor = 0.4f, ShrunkRadius = 7f;
    const float BloatDuration = 5f, BloatRadius = 26f;
    const float PowerUpRadius = 16f, PowerUpLife = 8f;
    const int MaxPowerUps = 2;

    readonly List<PowerUp> _powerUps = new();
    float _powerUpTimer;
    float _slowTime, _shrinkTime, _shieldTime, _bloatTime;
    float _playerR = PlayerRadius;

    // Eases back to full speed over the last half second of the slow-down.
    float BallTimeScale => _slowTime <= 0 ? 1f : SlowFactor + (1 - SlowFactor) * (1 - Math.Min(1f, _slowTime / 0.5f));

    static Color PowerUpColor(PowerUpKind k) => k switch
    {
        PowerUpKind.Slow => Color.FromArgb(90, 220, 255),
        PowerUpKind.Shrink => Color.FromArgb(255, 220, 70),
        PowerUpKind.Bloat => Color.FromArgb(220, 60, 140),
        _ => Color.FromArgb(255, 255, 255),
    };

    void UpdatePowerUps(float dt)
    {
        _slowTime = Math.Max(0, _slowTime - dt);
        _shrinkTime = Math.Max(0, _shrinkTime - dt);
        _shieldTime = Math.Max(0, _shieldTime - dt);
        _bloatTime = Math.Max(0, _bloatTime - dt);

        // Player radius slides smoothly between normal, shrunk and bloated
        float targetR = _shrinkTime > 0 ? ShrunkRadius : _bloatTime > 0 ? BloatRadius : PlayerRadius;
        _playerR += (targetR - _playerR) * Math.Min(1, dt * 10);

        _powerUpTimer -= dt;
        if (_powerUpTimer <= 0)
        {
            _powerUpTimer = 10f + (float)_rng.NextDouble() * 6f;
            if (_powerUps.Count < MaxPowerUps) SpawnPowerUp();
        }

        for (int i = _powerUps.Count - 1; i >= 0; i--)
        {
            var p = _powerUps[i];
            p.Age += dt;
            p.Life -= dt;
            if (p.Life <= 0) { _powerUps.RemoveAt(i); continue; }
            if (Dist(p.X, p.Y, _mouse.X, _mouse.Y) < PowerUpRadius + _playerR)
            {
                Collect(p.Kind);
                _powerUps.RemoveAt(i);
            }
        }
    }

    void SpawnPowerUp()
    {
        float w = ClientSize.Width, h = ClientSize.Height;
        const float margin = 60;
        for (int attempt = 0; attempt < 50; attempt++)
        {
            float x = margin + (float)_rng.NextDouble() * (w - 2 * margin);
            float y = margin + (float)_rng.NextDouble() * (h - 2 * margin);
            if (Dist(x, y, _mouse.X, _mouse.Y) < 180) continue; // make the player go for it
            if (_powerUps.Any(p => Dist(x, y, p.X, p.Y) < 100)) continue;
            _powerUps.Add(new PowerUp { X = x, Y = y, Kind = (PowerUpKind)_rng.Next(4), Life = PowerUpLife });
            return;
        }
    }

    void Collect(PowerUpKind kind)
    {
        switch (kind)
        {
            case PowerUpKind.Slow: _slowTime = SlowDuration; ShowBanner("SLOW-MO!", PowerUpColor(kind)); break;
            // Tiny and Bloat cancel each other: whichever you grabbed last wins.
            case PowerUpKind.Shrink: _shrinkTime = ShrinkDuration; _bloatTime = 0; ShowBanner("TINY!", PowerUpColor(kind)); break;
            case PowerUpKind.Bloat: _bloatTime = BloatDuration; _shrinkTime = 0; ShowBanner("CURSED! BLOATED!", PowerUpColor(kind)); break;
            case PowerUpKind.Shield: _shieldTime = ShieldDuration; ShowBanner("INVULNERABLE!", PowerUpColor(kind)); break;
        }
    }

    void DrawPowerUps(Graphics g)
    {
        foreach (var p in _powerUps)
        {
            // Blink during the last 2 seconds before it vanishes
            if (p.Life < 2f && ((int)(p.Life * 8)) % 2 == 0) continue;

            var c = PowerUpColor(p.Kind);
            float y = p.Y + MathF.Sin(p.Age * 3) * 4;
            float pulse = 0.5f + 0.5f * MathF.Sin(p.Age * 5);

            float gr = PowerUpRadius + 8 + pulse * 6;
            using (var glow = new SolidBrush(Color.FromArgb((int)(30 + 30 * pulse), c)))
                g.FillEllipse(glow, p.X - gr, y - gr, gr * 2, gr * 2);
            using (var body = new SolidBrush(Color.FromArgb(200, 20, 24, 40)))
                g.FillEllipse(body, p.X - PowerUpRadius, y - PowerUpRadius, PowerUpRadius * 2, PowerUpRadius * 2);
            using (var ring = new Pen(c, 2.5f))
            {
                // The cursed one has a jagged, rotating dashed ring
                if (p.Kind == PowerUpKind.Bloat) { ring.DashStyle = DashStyle.Dash; ring.DashOffset = p.Age * 6; }
                g.DrawEllipse(ring, p.X - PowerUpRadius, y - PowerUpRadius, PowerUpRadius * 2, PowerUpRadius * 2);
            }

            DrawPowerUpIcon(g, p.Kind, p.X, y, c);
        }
    }

    static void DrawPowerUpIcon(Graphics g, PowerUpKind kind, float x, float y, Color c)
    {
        using var brush = new SolidBrush(c);
        using var pen = new Pen(c, 2f);
        switch (kind)
        {
            case PowerUpKind.Slow: // hourglass
                g.FillPolygon(brush, new[] { new PointF(x - 6, y - 8), new PointF(x + 6, y - 8), new PointF(x, y) });
                g.FillPolygon(brush, new[] { new PointF(x, y), new PointF(x - 6, y + 8), new PointF(x + 6, y + 8) });
                g.DrawLine(pen, x - 7, y - 9, x + 7, y - 9);
                g.DrawLine(pen, x - 7, y + 9, x + 7, y + 9);
                break;
            case PowerUpKind.Shrink: // small dot with arrows pointing in
                g.FillEllipse(brush, x - 3, y - 3, 6, 6);
                foreach (var (dx, dy) in new[] { (1, 1), (-1, 1), (1, -1), (-1, -1) })
                {
                    g.DrawLine(pen, x + dx * 10, y + dy * 10, x + dx * 6, y + dy * 6);
                    g.DrawLine(pen, x + dx * 6, y + dy * 6, x + dx * 6, y + dy * 9);
                    g.DrawLine(pen, x + dx * 6, y + dy * 6, x + dx * 9, y + dy * 6);
                }
                break;
            case PowerUpKind.Bloat: // big dot with arrows pointing out
                g.FillEllipse(brush, x - 5, y - 5, 10, 10);
                foreach (var (dx, dy) in new[] { (1, 1), (-1, 1), (1, -1), (-1, -1) })
                {
                    g.DrawLine(pen, x + dx * 6, y + dy * 6, x + dx * 11, y + dy * 11);
                    g.DrawLine(pen, x + dx * 11, y + dy * 11, x + dx * 11, y + dy * 8);
                    g.DrawLine(pen, x + dx * 11, y + dy * 11, x + dx * 8, y + dy * 11);
                }
                break;
            case PowerUpKind.Shield: // shield shape
                using (var path = new GraphicsPath())
                {
                    path.AddLines(new[]
                    {
                        new PointF(x, y - 9), new PointF(x + 8, y - 6), new PointF(x + 7, y + 2),
                        new PointF(x, y + 10), new PointF(x - 7, y + 2), new PointF(x - 8, y - 6),
                    });
                    path.CloseFigure();
                    g.FillPath(brush, path);
                }
                break;
        }
    }

    void DrawPlayerEffects(Graphics g, PointF player)
    {
        if (_shieldTime > 0)
        {
            // Bubble around the player; flickers in the last second as a warning
            bool visible = _shieldTime > 1f || ((int)(_shieldTime * 12)) % 2 == 0;
            if (visible)
            {
                float r = _playerR + 8 + MathF.Sin(_survived * 12) * 1.5f;
                using var fill = new SolidBrush(Color.FromArgb(50, 255, 255, 255));
                using var ring = new Pen(Color.FromArgb(220, 255, 255, 255), 2.5f);
                g.FillEllipse(fill, player.X - r, player.Y - r, r * 2, r * 2);
                g.DrawEllipse(ring, player.X - r, player.Y - r, r * 2, r * 2);
            }
        }
    }

    void DrawActiveEffects(Graphics g)
    {
        using var font = new Font("Segoe UI", 10, FontStyle.Bold);
        float x = 12, y = 40;
        void Bar(string label, float t, float total, PowerUpKind kind)
        {
            if (t <= 0) return;
            var c = PowerUpColor(kind);
            const float w = 140, h = 18;
            using var bg = new SolidBrush(Color.FromArgb(120, 0, 0, 0));
            using var fg = new SolidBrush(Color.FromArgb(170, c));
            g.FillRectangle(bg, x, y, w, h);
            g.FillRectangle(fg, x, y, w * (t / total), h);
            g.DrawString($"{label} {t:0.0}s", font, Brushes.White, x + 4, y + 1);
            y += h + 4;
        }
        Bar("Slow-mo", _slowTime, SlowDuration, PowerUpKind.Slow);
        Bar("Tiny", _shrinkTime, ShrinkDuration, PowerUpKind.Shrink);
        Bar("Shield", _shieldTime, ShieldDuration, PowerUpKind.Shield);
        Bar("Cursed: big", _bloatTime, BloatDuration, PowerUpKind.Bloat);
    }

    // ---- Rare events: join and split ----

    const float RareEventChance = 0.5f;      // share of events that become a join or split instead
    const float JoinPullSpeed = 260f, JoinTimeout = 3f, JoinMaxRadius = 48f;
    const float SplitWarnTime = 1f, SplitMinRadius = 18f, ChildMinRadius = 12f;
    static readonly Color JoinLight = Color.FromArgb(150, 240, 255), JoinDark = Color.FromArgb(0, 110, 140);
    static readonly Color SplitLight = Color.FromArgb(255, 140, 200), SplitDark = Color.FromArgb(150, 30, 90);

    bool TryJoin()
    {
        // Two nearby balls, both well away from the player
        var free = _balls.Where(b => b.Mode == BallMode.Normal && Dist(b.X, b.Y, _mouse.X, _mouse.Y) > 220).ToList();
        var pairs = new List<(Ball a, Ball b)>();
        for (int i = 0; i < free.Count; i++)
        for (int j = i + 1; j < free.Count; j++)
        {
            Ball a = free[i], b = free[j];
            float mx = (a.X + b.X) / 2, my = (a.Y + b.Y) / 2;
            if (Dist(a.X, a.Y, b.X, b.Y) < 350 && Dist(mx, my, _mouse.X, _mouse.Y) > 250) pairs.Add((a, b));
        }
        if (pairs.Count == 0) return false;

        var (p, q) = pairs[_rng.Next(pairs.Count)];
        foreach (var (x, partner) in new[] { (p, q), (q, p) })
        {
            x.Mode = BallMode.Joining;
            x.Partner = partner;
            x.ModeTime = JoinTimeout;
            x.CruiseSpeed = Speed(x);
        }
        ShowBanner("MERGE!", JoinLight);
        return true;
    }

    bool TrySplit()
    {
        var b = _balls.Where(b => b.Mode == BallMode.Normal && b.R >= SplitMinRadius && Dist(b.X, b.Y, _mouse.X, _mouse.Y) > 220)
                      .OrderBy(_ => _rng.Next()).FirstOrDefault();
        if (b == null) return false;
        b.Mode = BallMode.SplitWarning;
        b.ModeTime = SplitWarnTime;
        b.CruiseSpeed = Speed(b);
        ShowBanner("SPLIT!", SplitLight);
        return true;
    }

    // Runs after each physics sub-step, outside the ball loops, so balls can be added/removed safely.
    void ResolveJoinsAndSplits()
    {
        if (!_balls.Any(b => b.Mode is BallMode.Joining or BallMode.SplitWarning)) return;

        foreach (var a in _balls.ToList())
        {
            if (!_balls.Contains(a)) continue; // already merged this step

            if (a.Mode == BallMode.Joining && a.Partner is { } p)
            {
                if (Dist(a.X, a.Y, p.X, p.Y) < (a.R + p.R) * 0.85f)
                {
                    float m = a.Mass + p.Mass;
                    float mvx = (a.VX * a.Mass + p.VX * p.Mass) / m, mvy = (a.VY * a.Mass + p.VY * p.Mass) / m;
                    double dir = MathF.Abs(mvx) + MathF.Abs(mvy) > 1 ? Math.Atan2(mvy, mvx) : _rng.NextDouble() * Math.PI * 2;
                    float speed = (a.CruiseSpeed + p.CruiseSpeed) / 2;
                    var merged = new Ball
                    {
                        X = (a.X * a.Mass + p.X * p.Mass) / m,
                        Y = (a.Y * a.Mass + p.Y * p.Mass) / m,
                        R = MathF.Min(MathF.Sqrt(a.R * a.R + p.R * p.R), JoinMaxRadius),
                        VX = (float)Math.Cos(dir) * speed,
                        VY = (float)Math.Sin(dir) * speed,
                    };
                    _balls.Remove(a);
                    _balls.Remove(p);
                    _balls.Add(merged);
                    AddPop(merged.X, merged.Y, merged.R, JoinLight);
                }
                else if (a.ModeTime <= 0)
                {
                    // Never met (e.g. blocked by other balls): give up and carry on as normal
                    foreach (var x in new[] { a, p })
                    {
                        x.Mode = BallMode.Normal;
                        x.Partner = null;
                        SetSpeed(x, x.CruiseSpeed);
                    }
                }
            }
            else if (a.Mode == BallMode.SplitWarning && a.ModeTime <= 0)
            {
                // Two halves with the same total area, veering apart from the original heading
                float childR = MathF.Max(ChildMinRadius, a.R / MathF.Sqrt(2));
                float heading = MathF.Atan2(a.VY, a.VX);
                float speed = MathF.Max(a.CruiseSpeed, 120f * CurrentDifficulty.SpeedMultiplier) * 1.1f;
                float px = -MathF.Sin(heading), py = MathF.Cos(heading);
                _balls.Remove(a);
                foreach (int side in new[] { -1, 1 })
                {
                    float dir = heading + side * 0.6f;
                    _balls.Add(new Ball
                    {
                        X = a.X + px * side * (childR + 1),
                        Y = a.Y + py * side * (childR + 1),
                        R = childR,
                        VX = MathF.Cos(dir) * speed,
                        VY = MathF.Sin(dir) * speed,
                    });
                }
                AddPop(a.X, a.Y, a.R, SplitLight);
            }
        }
    }

    // Expanding ring shown when balls join or split
    class Pop { public float X, Y, R, Age; public Color Color; }
    readonly List<Pop> _pops = new();
    const float PopDuration = 0.45f;

    void AddPop(float x, float y, float r, Color c) => _pops.Add(new Pop { X = x, Y = y, R = r, Color = c });

    void UpdatePops(float dt)
    {
        foreach (var p in _pops) p.Age += dt;
        _pops.RemoveAll(p => p.Age >= PopDuration);
    }

    void DrawPops(Graphics g)
    {
        foreach (var p in _pops)
        {
            float t = p.Age / PopDuration;
            float r = p.R + 35 * t;
            using var pen = new Pen(Color.FromArgb((int)(220 * (1 - t)), p.Color), 3f * (1 - t) + 1);
            g.DrawEllipse(pen, p.X - r, p.Y - r, r * 2, r * 2);
        }
    }

    // ---- Random events ----

    static readonly Color RushLight = Color.FromArgb(255, 160, 50), RushDark = Color.FromArgb(170, 60, 0);
    static readonly Color CurveLight = Color.FromArgb(200, 120, 255), CurveDark = Color.FromArgb(90, 30, 170);
    static readonly Color NormalLight = Color.FromArgb(70, 140, 255), NormalDark = Color.FromArgb(20, 50, 160);
    static readonly Color GiantLight = Color.FromArgb(110, 235, 160), GiantDark = Color.FromArgb(20, 120, 70);
    static readonly Color HomingLight = Color.FromArgb(240, 70, 110), HomingDark = Color.FromArgb(110, 10, 40);

    // Homing event: a slow seeker with a limited turn rate, so it can be outmanoeuvred
    const float HomingDuration = 7f, HomingSpeed = 150f, HomingTurnRate = 2.2f;

    // Speed-up event: balls heat up and go faster for a while
    static readonly Color BoostLight = Color.FromArgb(255, 250, 190), BoostDark = Color.FromArgb(210, 130, 20);
    const float BoostFactor = 1.75f, BoostMinDuration = 3f, BoostMaxDuration = 5f;

    // Giant event timing: warning, then grow / hold / shrink
    const float GrowWarnTime = 0.9f, GrowUp = 0.35f, GrowHold = 10f, GrowDown = 0.45f;
    const float GrowTotal = GrowUp + GrowHold + GrowDown;

    float _eventTimer;
    string _bannerText = "";
    Color _bannerColor;
    float _bannerTime;
    const float BannerDuration = 2f;

    void TriggerRandomEvent()
    {
        var d = CurrentDifficulty;
        _eventTimer = d.EventEverySeconds * (0.7f + (float)_rng.NextDouble() * 0.6f);
        int count = _rng.Next(1, d.MaxEventBalls + 1);
        int kind = _rng.Next(5);

        // Rare: two balls join into one, or one ball splits in two
        if (_rng.NextDouble() < RareEventChance && (_rng.Next(2) == 0 ? TryJoin() || TrySplit() : TrySplit() || TryJoin()))
            return;

        if (kind == 2)
        {
            // Giant: one ball swells up for a moment. Only a ball whose full size won't land on the player.
            var b = _balls.Where(b => b.Mode == BallMode.Normal)
                          .Select(b => (ball: b, big: Math.Clamp(b.R * 3f, 70f, 95f)))
                          .Where(p => Dist(p.ball.X, p.ball.Y, _mouse.X, _mouse.Y) > p.big + PlayerRadius + 80)
                          .OrderBy(_ => _rng.Next()).FirstOrDefault();
            if (b.ball == null) return;
            b.ball.Mode = BallMode.GrowWarning;
            b.ball.ModeTime = GrowWarnTime;
            b.ball.BaseR = b.ball.R;
            b.ball.BigR = b.big;
            ShowBanner("GIANT!", GiantLight);
        }
        else if (kind == 4)
        {
            // Speed up: a few balls temporarily go much faster
            var picks = _balls.Where(b => b.Mode == BallMode.Normal)
                              .OrderBy(_ => _rng.Next()).Take(count).ToList();
            if (picks.Count == 0) return;
            foreach (var b in picks)
            {
                b.Mode = BallMode.Boosted;
                b.ModeTime = BoostMinDuration + (float)_rng.NextDouble() * (BoostMaxDuration - BoostMinDuration);
                b.CruiseSpeed = Speed(b);
                b.TrailColor = BoostDark;
            }
            ShowBanner("SPEED UP!", BoostLight);
        }
        else if (kind == 3)
        {
            // Homing: one ball slowly hunts the player
            var b = _balls.Where(b => b.Mode == BallMode.Normal && Dist(b.X, b.Y, _mouse.X, _mouse.Y) > 200)
                          .OrderBy(_ => _rng.Next()).FirstOrDefault();
            if (b == null) return;
            b.Mode = BallMode.Homing;
            b.ModeTime = HomingDuration;
            b.CruiseSpeed = Speed(b);
            b.TrailColor = HomingLight;
            ShowBanner("HUNTED!", HomingLight);
        }
        else if (kind == 0)
        {
            // Rush: only balls far enough away to be dodgeable.
            var picks = _balls.Where(b => b.Mode == BallMode.Normal && Dist(b.X, b.Y, _mouse.X, _mouse.Y) > 250)
                              .OrderBy(_ => _rng.Next()).Take(count).ToList();
            if (picks.Count == 0) return;
            foreach (var b in picks)
            {
                b.Mode = BallMode.RushWarning;
                b.ModeTime = 0.8f;
                b.CruiseSpeed = Speed(b);
                b.TrailColor = RushLight;
            }
            ShowBanner(picks.Count == 1 ? "INCOMING!" : $"INCOMING x{picks.Count}!", RushLight);
        }
        else
        {
            var picks = _balls.Where(b => b.Mode == BallMode.Normal)
                              .OrderBy(_ => _rng.Next()).Take(count).ToList();
            if (picks.Count == 0) return;
            foreach (var b in picks)
            {
                b.Mode = BallMode.Curving;
                b.ModeTime = 4f + (float)_rng.NextDouble() * 2f;
                b.Phase = 0;
                b.TrailColor = CurveLight;
                if (_rng.Next(2) == 0)
                {
                    // Spiral: steady turn in one direction
                    b.TurnRate = (1.5f + (float)_rng.NextDouble() * 1.5f) * (_rng.Next(2) == 0 ? -1 : 1);
                    b.WobbleAmp = 0;
                }
                else
                {
                    // Snake: weaves left and right
                    b.TurnRate = 0;
                    b.WobbleAmp = 4f + (float)_rng.NextDouble() * 2.5f;
                    b.WobbleFreq = 4f + (float)_rng.NextDouble() * 3f;
                }
            }
            ShowBanner("WOBBLE!", CurveLight);
        }
    }

    void ShowBanner(string text, Color color)
    {
        _bannerText = text;
        _bannerColor = color;
        _bannerTime = BannerDuration;
    }

    void UpdateBehavior(Ball b, float dt)
    {
        switch (b.Mode)
        {
            case BallMode.RushWarning:
                // Wind up: slow down, then launch straight at where the player is at that moment.
                b.VX *= MathF.Pow(0.15f, dt);
                b.VY *= MathF.Pow(0.15f, dt);
                b.ModeTime -= dt;
                if (b.ModeTime <= 0)
                {
                    float dx = _mouse.X - b.X, dy = _mouse.Y - b.Y;
                    float len = MathF.Max(1, MathF.Sqrt(dx * dx + dy * dy));
                    float dash = MathF.Max(b.CruiseSpeed * 2f, 450f * CurrentDifficulty.SpeedMultiplier);
                    b.VX = dx / len * dash;
                    b.VY = dy / len * dash;
                    b.Mode = BallMode.Rushing;
                    b.ModeTime = 1.1f;
                }
                break;

            case BallMode.Rushing:
                b.ModeTime -= dt;
                if (b.ModeTime <= 0)
                {
                    SetSpeed(b, b.CruiseSpeed);
                    b.Mode = BallMode.Normal;
                }
                break;

            case BallMode.Curving:
                b.Phase += dt;
                float omega = b.TurnRate + b.WobbleAmp * MathF.Sin(b.Phase * b.WobbleFreq);
                float cos = MathF.Cos(omega * dt), sin = MathF.Sin(omega * dt);
                (b.VX, b.VY) = (b.VX * cos - b.VY * sin, b.VX * sin + b.VY * cos);
                b.ModeTime -= dt;
                if (b.ModeTime <= 0) b.Mode = BallMode.Normal;
                break;

            case BallMode.Homing:
            {
                // Turn toward the player at a limited rate and ease to a gentle speed
                float target = MathF.Atan2(_mouse.Y - b.Y, _mouse.X - b.X);
                float heading = MathF.Atan2(b.VY, b.VX);
                float diff = MathF.IEEERemainder(target - heading, MathF.Tau);
                heading += Math.Clamp(diff, -HomingTurnRate * dt, HomingTurnRate * dt);
                float speed = Speed(b);
                speed += (HomingSpeed * CurrentDifficulty.SpeedMultiplier - speed) * Math.Min(1, dt * 3);
                b.VX = MathF.Cos(heading) * speed;
                b.VY = MathF.Sin(heading) * speed;

                b.ModeTime -= dt;
                if (b.ModeTime <= 0)
                {
                    SetSpeed(b, b.CruiseSpeed);
                    b.Mode = BallMode.Normal;
                }
                break;
            }

            case BallMode.Joining:
            {
                // Pull toward the partner, speeding up as they close in
                var p = b.Partner!;
                float dx = p.X - b.X, dy = p.Y - b.Y;
                float len = MathF.Max(1, MathF.Sqrt(dx * dx + dy * dy));
                float pull = JoinPullSpeed * CurrentDifficulty.SpeedMultiplier;
                float k = Math.Min(1, dt * 4);
                b.VX += (dx / len * pull - b.VX) * k;
                b.VY += (dy / len * pull - b.VY) * k;
                b.ModeTime -= dt;
                break;
            }

            case BallMode.SplitWarning:
                b.ModeTime -= dt;
                break;

            case BallMode.Boosted:
            {
                // Ramp up quickly, hold, then ease back down over the last half second
                float boost = b.ModeTime < 0.5f ? 1 + (BoostFactor - 1) * (b.ModeTime / 0.5f) : BoostFactor;
                float speed = Speed(b);
                SetSpeed(b, speed + (b.CruiseSpeed * boost - speed) * Math.Min(1, dt * 6));
                b.ModeTime -= dt;
                if (b.ModeTime <= 0)
                {
                    SetSpeed(b, b.CruiseSpeed);
                    b.Mode = BallMode.Normal;
                }
                break;
            }

            case BallMode.GrowWarning:
                b.ModeTime -= dt;
                if (b.ModeTime <= 0)
                {
                    b.Mode = BallMode.Growing;
                    b.ModeTime = GrowTotal;
                }
                break;

            case BallMode.Growing:
            {
                b.ModeTime -= dt;
                float e = GrowTotal - b.ModeTime;
                float s = e < GrowUp ? SmoothStep(e / GrowUp)
                        : e < GrowUp + GrowHold ? 1f
                        : 1f - SmoothStep((e - GrowUp - GrowHold) / GrowDown);
                b.R = b.BaseR + (b.BigR - b.BaseR) * s;
                if (b.ModeTime <= 0)
                {
                    b.R = b.BaseR;
                    b.Mode = BallMode.Normal;
                }
                break;
            }
        }
    }

    static float SmoothStep(float t)
    {
        t = Math.Clamp(t, 0f, 1f);
        return t * t * (3 - 2 * t);
    }

    static float Speed(Ball b) => MathF.Sqrt(b.VX * b.VX + b.VY * b.VY);

    static void SetSpeed(Ball b, float speed)
    {
        float s = Speed(b);
        if (s < 0.001f) return;
        b.VX *= speed / s;
        b.VY *= speed / s;
    }

    // Special balls leave a short fading trail; it shrinks away once they're back to normal.
    void UpdateTrails()
    {
        foreach (var b in _balls)
        {
            if (b.Mode is BallMode.Rushing or BallMode.Curving or BallMode.Homing or BallMode.Boosted)
            {
                b.Trail.Enqueue(new PointF(b.X, b.Y));
                if (b.Trail.Count > 14) b.Trail.Dequeue();
            }
            else if (b.Trail.Count > 0) b.Trail.Dequeue();
        }
    }

    void DrawSpecialBall(Graphics g, Ball b)
    {
        int n = b.Trail.Count, i = 0;
        foreach (var p in b.Trail)
        {
            float t = (i + 1f) / (n + 1f);
            using var tb = new SolidBrush(Color.FromArgb((int)(90 * t), b.TrailColor));
            float r = b.R * (0.35f + 0.5f * t);
            g.FillEllipse(tb, p.X - r, p.Y - r, r * 2, r * 2);
            i++;
        }

        switch (b.Mode)
        {
            case BallMode.RushWarning:
            {
                // Aim line, shrinking ring and a flashing ball
                using var pen = new Pen(Color.FromArgb(110, RushLight), 2f) { DashStyle = DashStyle.Dash };
                g.DrawLine(pen, b.X, b.Y, _mouse.X, _mouse.Y);
                bool on = ((int)(b.ModeTime * 12)) % 2 == 0;
                DrawBall(g, b.X, b.Y, b.R, on ? RushLight : NormalLight, on ? RushDark : NormalDark);
                using var ring = new Pen(Color.FromArgb(200, RushLight), 2f);
                float rr = b.R + 4 + b.ModeTime * 14;
                g.DrawEllipse(ring, b.X - rr, b.Y - rr, rr * 2, rr * 2);
                break;
            }
            case BallMode.Rushing:
                DrawBall(g, b.X, b.Y, b.R, RushLight, RushDark);
                break;
            case BallMode.Curving:
                DrawBall(g, b.X, b.Y, b.R, CurveLight, CurveDark);
                break;
            case BallMode.GrowWarning:
            {
                // Dashed outline of the size it's about to reach, plus a flashing ball
                float pulse = 0.5f + 0.5f * MathF.Sin(b.ModeTime * 25);
                using var pen = new Pen(Color.FromArgb((int)(90 + 120 * pulse), GiantLight), 2.5f) { DashStyle = DashStyle.Dash };
                g.DrawEllipse(pen, b.X - b.BigR, b.Y - b.BigR, b.BigR * 2, b.BigR * 2);
                using var fill = new SolidBrush(Color.FromArgb((int)(25 + 25 * pulse), GiantLight));
                g.FillEllipse(fill, b.X - b.BigR, b.Y - b.BigR, b.BigR * 2, b.BigR * 2);
                bool on = ((int)(b.ModeTime * 12)) % 2 == 0;
                DrawBall(g, b.X, b.Y, b.R, on ? GiantLight : NormalLight, on ? GiantDark : NormalDark);
                break;
            }
            case BallMode.Growing:
                DrawBall(g, b.X, b.Y, b.R, GiantLight, GiantDark);
                break;
            case BallMode.Joining:
            {
                // Pulsing tether between the pair (drawn once, by whichever comes first in the list)
                var p = b.Partner!;
                if (_balls.IndexOf(b) < _balls.IndexOf(p))
                {
                    float pulse = 0.5f + 0.5f * MathF.Sin(_survived * 14);
                    using var tether = new Pen(Color.FromArgb((int)(90 + 120 * pulse), JoinLight), 2f + pulse * 2) { DashStyle = DashStyle.Dot };
                    g.DrawLine(tether, b.X, b.Y, p.X, p.Y);
                }
                DrawBall(g, b.X, b.Y, b.R, JoinLight, JoinDark);
                break;
            }
            case BallMode.SplitWarning:
            {
                // Shakes harder and flashes faster right before it splits
                float urgency = 1 - b.ModeTime / SplitWarnTime;
                float sx = ((float)_rng.NextDouble() - 0.5f) * 6 * urgency;
                float sy = ((float)_rng.NextDouble() - 0.5f) * 6 * urgency;
                bool on = ((int)(b.ModeTime * (8 + 16 * urgency))) % 2 == 0;
                DrawBall(g, b.X + sx, b.Y + sy, b.R, on ? SplitLight : NormalLight, on ? SplitDark : NormalDark);
                // A crack across the ball, along the split line
                float a = MathF.Atan2(b.VY, b.VX);
                float cx = MathF.Cos(a) * b.R * 0.8f, cy = MathF.Sin(a) * b.R * 0.8f;
                using var crack = new Pen(Color.FromArgb((int)(120 + 135 * urgency), 255, 255, 255), 2f);
                g.DrawLine(crack, b.X + sx - cx, b.Y + sy - cy, b.X + sx + cx, b.Y + sy + cy);
                break;
            }
            case BallMode.Boosted:
            {
                // Hot glow that flickers
                float flick = 0.6f + 0.4f * MathF.Sin(_survived * 30 + b.X * 0.05f);
                float gr = b.R + 6;
                using var glow = new SolidBrush(Color.FromArgb((int)(70 * flick), BoostDark));
                g.FillEllipse(glow, b.X - gr, b.Y - gr, gr * 2, gr * 2);
                DrawBall(g, b.X, b.Y, b.R, BoostLight, BoostDark);
                break;
            }
            case BallMode.Homing:
            {
                DrawBall(g, b.X, b.Y, b.R, HomingLight, HomingDark);
                // An "eye" that looks at the player
                float a = MathF.Atan2(_mouse.Y - b.Y, _mouse.X - b.X);
                float ex = b.X + MathF.Cos(a) * b.R * 0.45f, ey = b.Y + MathF.Sin(a) * b.R * 0.45f;
                float er = b.R * 0.32f, pr = b.R * 0.16f;
                g.FillEllipse(Brushes.White, ex - er, ey - er, er * 2, er * 2);
                float px = ex + MathF.Cos(a) * er * 0.4f, py = ey + MathF.Sin(a) * er * 0.4f;
                g.FillEllipse(Brushes.Black, px - pr, py - pr, pr * 2, pr * 2);
                break;
            }
            default:
                DrawBall(g, b.X, b.Y, b.R, NormalLight, NormalDark);
                break;
        }
    }

    void DrawBanner(Graphics g)
    {
        if (_bannerTime <= 0 || _gameOver || _waitingToStart) return;
        float t = _bannerTime / BannerDuration;
        int alpha = (int)(255 * Math.Min(1, t * 2));
        float pop = t > 0.85f ? (t - 0.85f) / 0.15f : 0; // brief scale-up when it appears
        using var font = new Font("Segoe UI", 26 + 6 * pop, FontStyle.Bold);
        using var brush = new SolidBrush(Color.FromArgb(alpha, _bannerColor));
        using var shadow = new SolidBrush(Color.FromArgb(alpha / 2, 0, 0, 0));
        var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        g.DrawString(_bannerText, font, shadow, ClientSize.Width / 2f + 2, 72, fmt);
        g.DrawString(_bannerText, font, brush, ClientSize.Width / 2f, 70, fmt);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        _background ??= RenderBackground(ClientSize);
        g.DrawImageUnscaled(_background, 0, 0);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;

        DrawPowerUps(g);
        foreach (var b in _balls) DrawSpecialBall(g, b);
        DrawPops(g);

        var player = _gameOver ? _playerFallPos : _mouse;
        if (!_waitingToStart)
            DrawBall(g, player.X, player.Y, _playerR, Color.FromArgb(255, 90, 90), Color.FromArgb(160, 20, 20));
        if (!_gameOver && !_waitingToStart) { DrawPlayerEffects(g, player); DrawActiveEffects(g); }

        using var hudFont = new Font("Segoe UI", 14, FontStyle.Bold);
        g.DrawString($"Time: {_survived:0.0}s   Balls: {_balls.Count}   Best ({CurrentDifficulty.Name}): {_bestByDifficulty[_difficultyIndex]:0.0}s", hudFont, Brushes.White, 12, 10);

        DrawBanner(g);

        if (_waitingToStart)
            DrawCenterText(g, "DODGE BALLS", "Keep the red ball away from the blue ones.\nClick or press Space to start.");
        else if (_gameOver)
            DrawCenterText(g, "YOU LOSE", $"You survived {_survived:0.0} seconds.\nClick or press Space to play again.");

        if ((_waitingToStart || _gameOver) && !_paused) DrawDifficultySelector(g);
        if (_paused) DrawPauseMenu(g);
    }

    Bitmap? _background;

    // Pre-rendered once (the window can't be resized): dark blue gradient,
    // a soft glow in the middle and a vignette towards the corners.
    static Bitmap RenderBackground(Size size)
    {
        var bmp = new Bitmap(size.Width, size.Height);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = new Rectangle(Point.Empty, size);

        using (var grad = new LinearGradientBrush(rect, Color.FromArgb(24, 26, 44), Color.FromArgb(10, 12, 20), 90f))
            g.FillRectangle(grad, rect);

        // Central glow
        using (var path = new GraphicsPath())
        {
            path.AddEllipse(-size.Width * 0.2f, -size.Height * 0.3f, size.Width * 1.4f, size.Height * 1.5f);
            using var glow = new PathGradientBrush(path)
            {
                CenterColor = Color.FromArgb(40, 70, 110, 200),
                SurroundColors = new[] { Color.FromArgb(0, 70, 110, 200) },
            };
            g.FillRectangle(glow, rect);
        }

        // A few faint specks of dust/stars
        var rng = new Random(42);
        for (int i = 0; i < 120; i++)
        {
            float r = (float)rng.NextDouble() * 1.4f + 0.4f;
            using var b = new SolidBrush(Color.FromArgb(rng.Next(20, 70), 200, 215, 255));
            g.FillEllipse(b, rng.Next(size.Width), rng.Next(size.Height), r, r);
        }

        // Vignette
        using (var path = new GraphicsPath())
        {
            path.AddEllipse(-size.Width * 0.25f, -size.Height * 0.25f, size.Width * 1.5f, size.Height * 1.5f);
            using var vig = new PathGradientBrush(path)
            {
                CenterColor = Color.FromArgb(0, 0, 0, 0),
                SurroundColors = new[] { Color.FromArgb(170, 0, 0, 0) },
                FocusScales = new PointF(0.55f, 0.55f),
            };
            g.FillRectangle(vig, rect);
        }

        return bmp;
    }

    static void DrawBall(Graphics g, float x, float y, float r, Color light, Color dark)
    {
        var rect = new RectangleF(x - r, y - r, r * 2, r * 2);
        // The gradient's path is a bit larger than the ball: GDI+ doesn't paint the
        // anti-aliased edge pixels of a PathGradientBrush, which made the sides look clipped.
        const float pad = 3;
        using var path = new GraphicsPath();
        path.AddEllipse(x - r - pad, y - r - pad, (r + pad) * 2, (r + pad) * 2);
        using var brush = new PathGradientBrush(path)
        {
            CenterPoint = new PointF(x - r * 0.35f, y - r * 0.35f),
            CenterColor = light,
            SurroundColors = new[] { dark },
        };
        g.FillEllipse(brush, rect);
    }

    void DrawCenterText(Graphics g, string title, string sub)
    {
        using var overlay = new SolidBrush(Color.FromArgb(150, 0, 0, 0));
        g.FillRectangle(overlay, ClientRectangle);

        using var titleFont = new Font("Segoe UI", 48, FontStyle.Bold);
        using var subFont = new Font("Segoe UI", 16);
        var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        float cx = ClientSize.Width / 2f, cy = ClientSize.Height / 2f;
        g.DrawString(title, titleFont, Brushes.White, cx, cy - 40, fmt);
        g.DrawString(sub, subFont, Brushes.LightGray, cx, cy + 40, fmt);
    }
}
