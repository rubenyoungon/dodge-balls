'use strict';

// The game runs in a fixed 1000x700 coordinate space; the canvas
// is scaled to fit the window. While playing with a mouse, it is captured with the Pointer
// Lock API and the red ball moves by the mouse's movement. On a touch screen there is no
// lock: the red ball moves by how far the finger drags, like a trackpad, so the finger
// never has to cover it.

(() => {
    const W = 1000, H = 700;
    const TAU = Math.PI * 2;

    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const sound = new GameAudio();

    // ---- Small helpers ----

    const rgb = (r, g, b) => [r, g, b];
    const css = (c, a = 255) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(255, a)) / 255})`;
    const lighten = (c, amount) => c.map(v => Math.round(v + (255 - v) * amount));
    const WHITE = rgb(255, 255, 255), LIGHT_GRAY = rgb(211, 211, 211), GRAY = rgb(128, 128, 128);

    const rand = Math.random;
    const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo)); // lo <= n < hi
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);
    const smoothStep = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
    const pickRandom = arr => arr.length ? arr[Math.floor(rand() * arr.length)] : null;
    function shuffle(a) {
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }
    const rect = (x, y, w, h) => ({ x, y, w, h });
    const inflate = (r, dx, dy) => rect(r.x - dx, r.y - dy, r.w + 2 * dx, r.h + 2 * dy);
    const contains = (r, p) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

    const store = {
        get(key, fallback) {
            try { const v = localStorage.getItem('dodgeballs.' + key); return v == null ? fallback : JSON.parse(v); }
            catch { return fallback; }
        },
        set(key, value) {
            try { localStorage.setItem('dodgeballs.' + key, JSON.stringify(value)); } catch { /* not available */ }
        },
    };

    // ---- Game data ----

    const Mode = {
        Normal: 0, RushWarning: 1, Rushing: 2, Curving: 3, GrowWarning: 4,
        Growing: 5, Homing: 6, Boosted: 7, Joining: 8, SplitWarning: 9, Resizing: 10,
    };

    function makeBall(props) {
        return Object.assign({
            x: 0, y: 0, vx: 0, vy: 0, r: 0,
            mode: Mode.Normal,
            modeTime: 0,     // seconds left in the current mode
            cruiseSpeed: 0,  // speed to return to after an event
            turnRate: 0,     // rad/s, constant part of a curve (spiral)
            wobbleAmp: 0, wobbleFreq: 0, phase: 0, // oscillating part of a curve (snake)
            baseR: 0, bigR: 0, // normal and peak radius during a giant event
            targetR: 0,      // new permanent radius during a resize event
            partner: null,   // the ball this one is joining with
            frozenTime: 0,   // seconds left frozen in place (freeze power-up); its event is paused meanwhile
            newTime: 0,      // seconds left of the "just arrived" highlight
            trail: [],
            trailColor: WHITE,
        }, props);
    }
    const mass = b => b.r * b.r;
    const speedOf = b => Math.hypot(b.vx, b.vy);
    /** Sets a ball's speed after a bounce; if the bounce stopped it dead, it moves off along (ux, uy). */
    function keepSpeed(b, speed, ux, uy) {
        if (speedOf(b) < 0.001) { b.vx = ux; b.vy = uy; }
        setSpeed(b, speed);
    }
    function setSpeed(b, speed) {
        const s = speedOf(b);
        if (s < 0.001) return;
        b.vx *= speed / s;
        b.vy *= speed / s;
    }

    // Bloat and Sluggish are cursed: they make you bigger or slower
    const PowerUpKind = { Slow: 0, Shrink: 1, Shield: 2, Bloat: 3, Auto: 4, Freeze: 5, Destroy: 6, Sluggish: 7 };

    const DIFFICULTIES = [
        { name: 'Easy', startBalls: 5, speed: 0.7, newBallEvery: 40, eventEvery: 12, maxEventBalls: 1, idleLimit: 5, color: rgb(60, 170, 100) },
        { name: 'Normal', startBalls: 8, speed: 1.0, newBallEvery: 30, eventEvery: 9, maxEventBalls: 2, idleLimit: 3, color: rgb(50, 110, 220) },
        { name: 'Hard', startBalls: 12, speed: 1.35, newBallEvery: 20, eventEvery: 6, maxEventBalls: 3, idleLimit: 2, color: rgb(200, 60, 60) },
    ];
    let difficultyIndex = clamp(store.get('difficulty', 1) | 0, 0, DIFFICULTIES.length - 1);
    const currentDifficulty = () => DIFFICULTIES[difficultyIndex];
    const best = DIFFICULTIES.map((_, i) => Number(store.get('best', [])[i]) || 0);

    const PLAYER_RADIUS = 14;

    // ---- State ----

    let balls = [];
    let mouse = { x: W / 2, y: H / 2 };   // the red ball while playing
    let cursor = { x: -1, y: -1 };        // the visible cursor, for menus
    let gameOver = false;
    let waitingToStart = true;
    let survived = 0;
    let spawnTimer = 0;

    const playing = () => !gameOver && !waitingToStart;

    // ---- Pointer lock, pause menu and input ----

    let paused = false;
    let pausedAt = 0;
    let draggingSlider = -1;     // index into SLIDERS being dragged, or -1
    let focusedSlider = 0;      // the slider the arrow keys adjust
    let locked = false;
    let pendingStart = false;   // waiting for the lock before starting a game
    let pendingResume = false;  // waiting for the lock before resuming
    let lockMessage = '';
    let lockMessageTime = 0;

    // Touch play: no pointer lock, the ball follows the drag of one finger.
    // Starts out guessed from the device, then follows whatever was used last.
    let touchMode = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches)
        || typeof canvas.requestPointerLock !== 'function';
    let dragId = null;     // the pointer currently steering the ball
    let dragLast = null;   // its last position, in game units

    // Volume sliders in the pause menu: [label, storage key, sound property]
    const SLIDERS = [
        ['Music volume', 'volume', 'musicVolume'],
        ['Effects volume', 'effectsVolume', 'effectsVolume'],
    ];
    for (const [, key, prop] of SLIDERS) sound[prop] = clamp(Number(store.get(key, 1)), 0, 1);

    function requestLock() {
        if (document.pointerLockElement === canvas) { onLocked(); return; }
        try {
            const result = canvas.requestPointerLock();
            if (result && result.catch) result.catch(lockFailed);
        } catch {
            lockFailed();
        }
    }

    function lockFailed() {
        if (!pendingStart && !pendingResume) return;
        pendingStart = pendingResume = false;
        // Browsers refuse a new lock for about a second after Esc releases one.
        lockMessage = 'Couldn’t capture the mouse — click again';
        lockMessageTime = 2.5;
    }

    function onLocked() {
        lockMessageTime = 0;
        if (pendingStart) {
            pendingStart = false;
            startGame();
        } else if (pendingResume) {
            pendingResume = false;
            paused = false;
            draggingSlider = -1;
        }
    }

    document.addEventListener('pointerlockerror', lockFailed);
    document.addEventListener('pointerlockchange', () => {
        locked = document.pointerLockElement === canvas;
        if (locked) onLocked();
        else if (playing()) pause(); // Esc (handled by the browser) or switching away
    });

    function requestStart() {
        if (touchMode) { startGame(); return; }
        pendingStart = true;
        requestLock();
    }

    function pause() {
        if (paused) return;
        paused = true;
        pausedAt = performance.now();
        pendingResume = false;
        if (document.pointerLockElement === canvas) document.exitPointerLock();
    }

    function resume() {
        if (playing() && !touchMode) {
            // The red ball stays where it was; capturing the mouse again resumes the game.
            pendingResume = true;
            requestLock();
        } else {
            paused = false;
            draggingSlider = -1;
        }
    }

    function quitToMenu() {
        paused = false;
        draggingSlider = -1;
        if (playing()) sound.stopMusic();
        balls = [];
        powerUps.length = 0;
        pops.length = 0;
        survived = 0;
        banners.length = 0;
        gameOver = false;
        waitingToStart = true;
        mouse = clampPlayer(cursor);
    }

    function toGame(e) {
        const r = canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
    }

    const clampPlayer = p => ({ x: clamp(p.x, playerR, W - playerR), y: clamp(p.y, playerR, H - playerR) });

    // Pointer Events cover the mouse, touch and pens with one set of handlers.
    canvas.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (!e.isPrimary && dragId !== null) return; // a second finger doesn't take over
        e.preventDefault();
        touchMode = e.pointerType !== 'mouse' || typeof canvas.requestPointerLock !== 'function';
        sound.unlock();
        const p = toGame(e);
        cursor = p;
        if (touchMode) {
            try { canvas.setPointerCapture(e.pointerId); } catch { /* not supported */ }
            dragId = e.pointerId;
            dragLast = p;
        }
        if (paused) {
            const hit = SLIDERS.findIndex((_, i) => contains(inflate(sliderRect(i), 10, 14), p));
            if (hit >= 0) { draggingSlider = focusedSlider = hit; setVolumeFromX(p.x); }
            else if (contains(resumeButton(), p)) resume();
            else if (contains(quitButton(), p)) quitToMenu();
            return;
        }
        if (gameOver || waitingToStart) {
            // Clicking a difficulty starts with it; clicking anywhere else uses the selected one.
            for (let i = 0; i < DIFFICULTIES.length; i++)
                if (contains(difficultyButton(i), p)) setDifficulty(i);
            // Don't start the ball hidden under the touch pause button.
            mouse = clampPlayer(touchMode && contains(inflate(pauseButton(), 40, 40), p) ? { x: W / 2, y: H / 2 } : p);
            requestStart();
        } else if (touchMode) {
            if (contains(inflate(pauseButton(), 8, 8), p)) { dragId = null; pause(); }
            // Otherwise this finger now steers the ball (see pointermove).
        } else if (!locked) {
            // Playing without the lock shouldn't happen, but a click recaptures the mouse.
            requestLock();
        }
    });

    window.addEventListener('pointermove', e => {
        if (dragId !== null && e.pointerId === dragId) {
            const p = toGame(e);
            const dx = p.x - dragLast.x, dy = p.y - dragLast.y;
            dragLast = p;
            cursor = p;
            if (draggingSlider >= 0) setVolumeFromX(p.x);
            // Move the ball by the finger's movement, not to the finger, so it stays visible.
            if (playing() && !paused && autoTime <= 0)
                mouse = clampPlayer({ x: mouse.x + dx * TOUCH_SPEED * moveScale(), y: mouse.y + dy * TOUCH_SPEED * moveScale() });
            return;
        }
        if (e.pointerType !== 'mouse') return;
        if (locked) {
            if (!playing() || paused || autoTime > 0) return; // the autopilot is steering
            // Some browsers occasionally report a huge jump; ignore those.
            if (Math.abs(e.movementX) > 500 || Math.abs(e.movementY) > 500) return;
            const k = W / canvas.getBoundingClientRect().width * moveScale(); // screen pixels -> game units
            mouse = clampPlayer({ x: mouse.x + e.movementX * k, y: mouse.y + e.movementY * k });
            return;
        }
        cursor = toGame(e);
        if (draggingSlider >= 0) setVolumeFromX(cursor.x);
        if (!playing()) mouse = clampPlayer(cursor);
    });

    function pointerEnd(e) {
        if (e.pointerType !== 'mouse') {
            if (e.pointerId !== dragId) return;
            dragId = null;
            cursor = { x: -1, y: -1 }; // no hover effects left behind by a finger
            sound.unlock(); // iOS only allows starting audio on the end of a touch
        }
        if (draggingSlider >= 0) {
            const [, key, prop] = SLIDERS[draggingSlider];
            store.set(key, sound[prop]);
            if (prop === 'effectsVolume') sound.previewEffect();
        }
        draggingSlider = -1;
    }
    window.addEventListener('pointerup', pointerEnd);
    window.addEventListener('pointercancel', pointerEnd);
    canvas.addEventListener('contextmenu', e => e.preventDefault()); // long press

    window.addEventListener('keydown', e => {
        if (['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
        if (e.code !== 'Escape') sound.unlock();

        if (e.code === 'Escape') {
            // Ignore the same Esc press that just released the lock and paused the game.
            if (paused) { if (performance.now() - pausedAt > 300) resume(); }
            else pause();
            return;
        }
        if (paused) {
            if (e.code === 'ArrowUp') focusedSlider = Math.max(0, focusedSlider - 1);
            if (e.code === 'ArrowDown') focusedSlider = Math.min(SLIDERS.length - 1, focusedSlider + 1);
            if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
                const [, key, prop] = SLIDERS[focusedSlider];
                sound[prop] += e.code === 'ArrowLeft' ? -0.05 : 0.05;
                store.set(key, sound[prop]);
                if (prop === 'effectsVolume') sound.previewEffect();
            }
            return;
        }
        if (gameOver || waitingToStart) {
            if (e.code === 'ArrowLeft' || e.code === 'KeyA') setDifficulty(Math.max(0, difficultyIndex - 1));
            if (e.code === 'ArrowRight' || e.code === 'KeyD') setDifficulty(Math.min(DIFFICULTIES.length - 1, difficultyIndex + 1));
            const digit = /^Digit(\d)$/.exec(e.code);
            if (digit && +digit[1] >= 1 && +digit[1] <= DIFFICULTIES.length) setDifficulty(+digit[1] - 1);
            if (e.code === 'Space' || e.code === 'KeyR' || e.code === 'Enter') requestStart();
        }
    });

    window.addEventListener('blur', () => { if (playing()) pause(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && playing()) pause(); });

    function setDifficulty(i) {
        difficultyIndex = i;
        store.set('difficulty', i);
    }

    // ---- Menu layout ----

    const MENU_W = 380, MENU_H = 320;
    const menuRect = () => rect(Math.floor((W - MENU_W) / 2), Math.floor((H - MENU_H) / 2), MENU_W, MENU_H);
    const sliderRect = i => { const m = menuRect(); return rect(m.x + 40, m.y + 115 + i * 62, MENU_W - 80, 8); };
    const resumeButton = () => { const m = menuRect(); return rect(m.x + 40, m.y + m.h - 70, 140, 44); };
    const quitButton = () => { const m = menuRect(); return rect(m.x + m.w - 180, m.y + m.h - 70, 140, 44); };

    const pauseButton = () => rect(W - 64, 8, 56, 56); // touch only
    const TOUCH_SPEED = 1.15; // a little faster than the finger, since phone screens are small

    const DIFF_W = 150, DIFF_H = 48, DIFF_GAP = 20;
    function difficultyButton(i) {
        const total = DIFFICULTIES.length * DIFF_W + (DIFFICULTIES.length - 1) * DIFF_GAP;
        return rect(Math.floor((W - total) / 2) + i * (DIFF_W + DIFF_GAP), H / 2 + 110, DIFF_W, DIFF_H);
    }

    function setVolumeFromX(x) {
        const s = sliderRect(draggingSlider);
        sound[SLIDERS[draggingSlider][2]] = (x - s.x) / s.w;
    }

    // ---- Game flow ----

    function startGame() {
        balls = [];
        survived = 0;
        for (let i = 0; i < currentDifficulty().startBalls; i++) spawnBall();
        spawnTimer = 0;
        eventTimer = 5; // short grace period before the first event
        banners.length = 0;
        pops.length = 0;
        powerUps.length = 0;
        powerUpTimer = 8;
        slowTime = shrinkTime = shieldTime = bloatTime = autoTime = sluggishTime = 0;
        autoVel = { x: 0, y: 0 };
        playerR = PLAYER_RADIUS;
        mouse = clampPlayer(mouse);
        idleAnchor = { x: mouse.x, y: mouse.y };
        idleTime = 0;
        gameOver = false;
        waitingToStart = false;
        paused = false;
        sound.startMusic();
    }

    function spawnBall() {
        for (let attempt = 0; attempt < 200; attempt++) {
            const r = randInt(14, 32);
            const x = r + rand() * (W - 2 * r);
            const y = r + rand() * (H - 2 * r);

            // keep a safe distance from the player and from other balls
            if (dist(x, y, mouse.x, mouse.y) < r + PLAYER_RADIUS + 160) continue;
            if (balls.some(b => dist(x, y, b.x, b.y) < r + b.r + 4)) continue;

            const angle = rand() * TAU;
            const speed = (120 + rand() * 140 + survived * 3) * currentDifficulty().speed;
            const b = makeBall({ x, y, r, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed });
            balls.push(b);
            return b;
        }
        return null;
    }

    function update(dt) {
        if (playing()) {
            mouse = clampPlayer(mouse); // the radius can change with power-ups
            if (autoTime > 0) autoPilot(dt);

            // Sub-step for more stable collisions at high speed
            sound.beginFrame();
            const steps = 4;
            const ballDt = dt * ballTimeScale();
            for (let s = 0; s < steps; s++) step(ballDt / steps);

            updateTrails();
            updatePowerUps(dt);
            updatePops(dt);
            for (const b of balls) b.newTime = Math.max(0, b.newTime - dt);

            updateIdle(dt);

            survived += dt;
            eventTimer -= dt;
            if (eventTimer <= 0) triggerRandomEvent();
            updateBanners(dt);
            spawnTimer += dt;
            if (spawnTimer >= currentDifficulty().newBallEvery) {
                spawnTimer = 0;
                const b = spawnBall();
                if (b) { // starting balls don't get this, only ones added mid-run
                    b.newTime = NEW_BALL_HIGHLIGHT;
                    showBanner('NEW BALL!', NEW_BALL_GLOW);
                    sound.playEffect('newBall');
                }
            }

            const hit = shieldTime <= 0 && balls.some(b => dist(b.x, b.y, mouse.x, mouse.y) < b.r + playerR);
            if (hit) {
                gameOver = true;
                if (survived > best[difficultyIndex]) {
                    best[difficultyIndex] = survived;
                    store.set('best', best);
                }
                startFall();
                sound.stopMusic();
                sound.playLose();
                if (document.pointerLockElement === canvas) document.exitPointerLock();
            }
        } else if (gameOver) {
            fallStep(dt);
        }
    }

    const GRAVITY = 1800;
    let playerFall = { x: 0, y: 0, vx: 0, vy: 0 };

    // On losing, every ball gets a small upward pop and then drops out of the window.
    function startFall() {
        for (const b of balls) {
            if (b.mode === Mode.GrowWarning || b.mode === Mode.Growing) b.r = b.baseR;
            if (b.mode === Mode.Resizing) b.r = b.targetR;
            b.mode = Mode.Normal;
            b.partner = null;
            b.frozenTime = 0;
            b.newTime = 0;
            b.trail.length = 0;
            b.vx *= 0.3;
            b.vy = -150 - rand() * 350;
        }
        powerUps.length = 0;
        slowTime = shieldTime = autoTime = sluggishTime = 0;
        playerFall = { x: mouse.x, y: mouse.y, vx: 0, vy: -450 };
    }

    function fallStep(dt) {
        for (const b of balls) {
            b.vy += GRAVITY * dt;
            b.x += b.vx * dt;
            b.y += b.vy * dt;
        }
        playerFall.vy += GRAVITY * dt;
        playerFall.x += playerFall.vx * dt;
        playerFall.y += playerFall.vy * dt;
    }

    function step(dt) {
        for (const b of balls) {
            if (b.frozenTime > 0) continue; // stays put; keeps its velocity for when it thaws
            updateBehavior(b, dt);
            b.x += b.vx * dt;
            b.y += b.vy * dt;

            // Bounce off the walls; only a ball actually moving into the wall makes a sound.
            if (b.x - b.r < 0) { b.x = b.r; if (b.vx < 0) sound.play(-b.vx, b.r); b.vx = Math.abs(b.vx); }
            if (b.x + b.r > W) { b.x = W - b.r; if (b.vx > 0) sound.play(b.vx, b.r); b.vx = -Math.abs(b.vx); }
            if (b.y - b.r < 0) { b.y = b.r; if (b.vy < 0) sound.play(-b.vy, b.r); b.vy = Math.abs(b.vy); }
            if (b.y + b.r > H) { b.y = H - b.r; if (b.vy > 0) sound.play(b.vy, b.r); b.vy = -Math.abs(b.vy); }
        }

        // Elastic collisions between blue balls
        for (let i = 0; i < balls.length; i++) {
            for (let j = i + 1; j < balls.length; j++) {
                const a = balls[i], c = balls[j];
                if (a.partner === c) continue; // joining balls are allowed to touch
                const dx = c.x - a.x, dy = c.y - a.y;
                const distSq = dx * dx + dy * dy;
                const minDist = a.r + c.r;
                if (distSq >= minDist * minDist || distSq === 0) continue;

                const d = Math.sqrt(distSq);
                const nx = dx / d, ny = dy / d;

                // A frozen ball is a fixed obstacle: the other ball bounces off it like a wall.
                if (a.frozenTime > 0 || c.frozenTime > 0) {
                    if (a.frozenTime > 0 && c.frozenTime > 0) continue;
                    const [m, ux, uy] = a.frozenTime > 0 ? [c, nx, ny] : [a, -nx, -ny]; // u points from ice to mover
                    m.x += ux * (minDist - d);
                    m.y += uy * (minDist - d);
                    const vn = m.vx * ux + m.vy * uy;
                    if (vn < 0) {
                        sound.play(-vn, (a.r + c.r) / 2);
                        m.vx -= 2 * vn * ux;
                        m.vy -= 2 * vn * uy;
                    }
                    continue;
                }

                // Push apart so they don't overlap
                const overlap = minDist - d;
                const ma = mass(a), mc = mass(c), total = ma + mc;
                a.x -= nx * overlap * (mc / total);
                a.y -= ny * overlap * (mc / total);
                c.x += nx * overlap * (ma / total);
                c.y += ny * overlap * (ma / total);

                // Exchange momentum along the collision normal
                const relVel = (a.vx - c.vx) * nx + (a.vy - c.vy) * ny;
                if (relVel <= 0) continue; // already separating

                sound.play(relVel, (a.r + c.r) / 2);

                // A rushing ball bounces off the others instead of passing through them, but both balls
                // keep their own speed: the rusher stays fast and the ball it hits isn't flung at dash speed.
                const rush = a.mode === Mode.Rushing || c.mode === Mode.Rushing;
                const speedA = speedOf(a), speedC = speedOf(c);

                const impulse = 2 * relVel / total;
                a.vx -= impulse * mc * nx;
                a.vy -= impulse * mc * ny;
                c.vx += impulse * ma * nx;
                c.vy += impulse * ma * ny;

                if (rush) {
                    keepSpeed(a, speedA, -nx, -ny);
                    keepSpeed(c, speedC, nx, ny);
                }
            }
        }

        resolveJoinsAndSplits();
    }

    // ---- Power-ups ----

    const SLOW_DURATION = 5, SHRINK_DURATION = 6, SHIELD_DURATION = 3;
    const SLOW_FACTOR = 0.4, SHRUNK_RADIUS = 7;
    const BLOAT_DURATION = 5, BLOAT_RADIUS = 26;
    const POWERUP_RADIUS = 16, POWERUP_LIFE = 8;
    const MAX_POWERUPS = 2;

    const powerUps = [];
    let powerUpTimer = 0;
    const AUTO_DURATION = 5;
    const FREEZE_DURATION = 4;
    const DESTROY_CHANCE = 0.04; // the bomb is rare: about 1 in 25 power-ups
    const SLUGGISH_DURATION = 3.4, SLUGGISH_FACTOR = 0.5; // your moves only go half as far
    // The curses together are a bit rarer than one good power-up each, so grabbing stays worth it.
    const CURSE_CHANCE = 0.2;
    const GOOD_KINDS = [PowerUpKind.Slow, PowerUpKind.Shrink, PowerUpKind.Shield, PowerUpKind.Auto, PowerUpKind.Freeze];
    const CURSED_KINDS = [PowerUpKind.Bloat, PowerUpKind.Sluggish];
    const isCursed = kind => CURSED_KINDS.includes(kind);
    let slowTime = 0, shrinkTime = 0, shieldTime = 0, bloatTime = 0, autoTime = 0, sluggishTime = 0;
    const moveScale = () => sluggishTime > 0 ? SLUGGISH_FACTOR : 1;
    let playerR = PLAYER_RADIUS;

    // Eases back to full speed over the last half second of the slow-down.
    const ballTimeScale = () => slowTime <= 0 ? 1 : SLOW_FACTOR + (1 - SLOW_FACTOR) * (1 - Math.min(1, slowTime / 0.5));

    function powerUpColor(kind) {
        switch (kind) {
            case PowerUpKind.Slow: return rgb(90, 220, 255);
            case PowerUpKind.Shrink: return rgb(255, 220, 70);
            case PowerUpKind.Bloat: return rgb(220, 60, 140);
            case PowerUpKind.Auto: return rgb(160, 255, 90);
            case PowerUpKind.Freeze: return rgb(170, 200, 255);
            case PowerUpKind.Destroy: return rgb(255, 150, 40);
            case PowerUpKind.Sluggish: return rgb(160, 100, 235);
            default: return rgb(255, 255, 255);
        }
    }

    function updatePowerUps(dt) {
        // A timed power-up (or curse) that runs out on its own gives a soft blip.
        const tick = t => {
            const left = Math.max(0, t - dt);
            if (t > 0 && left === 0) sound.playEffect('expire');
            return left;
        };
        slowTime = tick(slowTime);
        shrinkTime = tick(shrinkTime);
        shieldTime = tick(shieldTime);
        bloatTime = tick(bloatTime);
        autoTime = tick(autoTime);
        sluggishTime = tick(sluggishTime);
        for (const b of balls) b.frozenTime = Math.max(0, b.frozenTime - dt);

        // Player radius slides smoothly between normal, shrunk and bloated
        const targetR = shrinkTime > 0 ? SHRUNK_RADIUS : bloatTime > 0 ? BLOAT_RADIUS : PLAYER_RADIUS;
        playerR += (targetR - playerR) * Math.min(1, dt * 10);

        powerUpTimer -= dt;
        if (powerUpTimer <= 0) {
            powerUpTimer = 10 + rand() * 6;
            if (powerUps.length < MAX_POWERUPS) spawnPowerUp();
        }

        for (let i = powerUps.length - 1; i >= 0; i--) {
            const p = powerUps[i];
            p.age += dt;
            p.life -= dt;
            if (p.life <= 0) { powerUps.splice(i, 1); continue; }
            if (dist(p.x, p.y, mouse.x, mouse.y) < POWERUP_RADIUS + playerR) {
                collect(p.kind);
                powerUps.splice(i, 1);
            }
        }
    }

    function spawnPowerUp() {
        const margin = 60;
        for (let attempt = 0; attempt < 50; attempt++) {
            const x = margin + rand() * (W - 2 * margin);
            const y = margin + rand() * (H - 2 * margin);
            if (dist(x, y, mouse.x, mouse.y) < 180) continue; // make the player go for it
            if (powerUps.some(p => dist(x, y, p.x, p.y) < 100)) continue;
            const kind = rand() < DESTROY_CHANCE ? PowerUpKind.Destroy
                : rand() < CURSE_CHANCE ? pickRandom(CURSED_KINDS) : pickRandom(GOOD_KINDS);
            powerUps.push({ x, y, kind, life: POWERUP_LIFE, age: 0 });
            return;
        }
    }

    const COLLECT_SOUNDS = {
        [PowerUpKind.Slow]: 'slow', [PowerUpKind.Shrink]: 'tiny', [PowerUpKind.Bloat]: 'curse',
        [PowerUpKind.Sluggish]: 'curse', [PowerUpKind.Shield]: 'shield', [PowerUpKind.Auto]: 'auto',
        [PowerUpKind.Freeze]: 'freeze', [PowerUpKind.Destroy]: 'boom',
    };

    function collect(kind) {
        // Good power-ups get a shared pickup chime plus their own sound; curses and the bomb stand alone.
        if (!isCursed(kind) && kind !== PowerUpKind.Destroy) sound.playEffect('powerUp');
        if (COLLECT_SOUNDS[kind]) sound.playEffect(COLLECT_SOUNDS[kind]);
        switch (kind) {
            case PowerUpKind.Slow: slowTime = SLOW_DURATION; showBanner('SLOW-MO!', powerUpColor(kind)); break;
            // Tiny and Bloat cancel each other: whichever you grabbed last wins.
            case PowerUpKind.Shrink: shrinkTime = SHRINK_DURATION; bloatTime = 0; showBanner('TINY!', powerUpColor(kind)); break;
            // The two curses don't stack either (big and slow at once is nearly certain death).
            case PowerUpKind.Bloat: bloatTime = BLOAT_DURATION; shrinkTime = sluggishTime = 0; showBanner('CURSED! BLOATED!', powerUpColor(kind)); break;
            case PowerUpKind.Sluggish: sluggishTime = SLUGGISH_DURATION; bloatTime = 0; showBanner('CURSED! SLUGGISH!', powerUpColor(kind)); break;
            case PowerUpKind.Shield: shieldTime = SHIELD_DURATION; showBanner('INVULNERABLE!', powerUpColor(kind)); break;
            case PowerUpKind.Auto:
                if (autoTime <= 0) autoVel = { x: 0, y: 0 };
                autoTime = AUTO_DURATION;
                showBanner('AUTOPILOT!', powerUpColor(kind));
                break;
            case PowerUpKind.Freeze: {
                // The nearest ball that isn't already frozen
                let target = null;
                for (const b of balls)
                    if (b.frozenTime <= 0 && (!target || dist(b.x, b.y, mouse.x, mouse.y) < dist(target.x, target.y, mouse.x, mouse.y)))
                        target = b;
                if (target) {
                    target.frozenTime = FREEZE_DURATION;
                    addPop(target.x, target.y, target.r, powerUpColor(kind));
                }
                showBanner('FROZEN!', powerUpColor(kind));
                break;
            }
            case PowerUpKind.Destroy: {
                // Takes out the ball closest to the player, the one most likely to hit them next.
                let target = null;
                for (const b of balls)
                    if (!target || dist(b.x, b.y, mouse.x, mouse.y) < dist(target.x, target.y, mouse.x, mouse.y)) target = b;
                if (target) {
                    // A ball that was merging with it just carries on alone
                    for (const b of balls)
                        if (b.partner === target) {
                            b.partner = null;
                            b.mode = Mode.Normal;
                            setSpeed(b, b.cruiseSpeed);
                        }
                    balls = balls.filter(b => b !== target);
                    addPop(target.x, target.y, target.r, powerUpColor(kind));
                    addPop(target.x, target.y, target.r + 20, WHITE);
                }
                showBanner('BOOM!', powerUpColor(kind));
                break;
            }
        }
    }

    // ---- Autopilot: steers the red ball by itself for a few seconds ----
    // Each frame it tries a set of moves (16 directions at two speeds, or standing still), predicts where
    // every ball will be over the next fraction of a second, and picks the move that stays clearest.

    const AUTO_SPEED = 480, AUTO_HORIZON = 0.6, AUTO_SAMPLES = 6;
    const AUTO_MOVES = [{ dx: 0, dy: 0, speed: 0 }];
    for (let i = 0; i < 16; i++)
        for (const speed of [AUTO_SPEED, AUTO_SPEED * 0.5])
            AUTO_MOVES.push({ dx: Math.cos(i / 16 * TAU), dy: Math.sin(i / 16 * TAU), speed });
    let autoVel = { x: 0, y: 0 };

    // Where (and how big) ball b will be after `t` seconds of ball time. `playerAt(t)` gives the
    // player's position at a ball time, used to aim balls that are about to rush.
    function predictBall(b, t, playerAt) {
        if (b.frozenTime > 0) return { x: b.x, y: b.y, r: b.r }; // a frozen ball stays put (close enough over the horizon)
        let x = b.x + b.vx * t, y = b.y + b.vy * t, r = b.r;
        if (b.mode === Mode.RushWarning && t > b.modeTime) {
            // It launches at wherever the player is when its wind-up ends
            const sx = b.x + b.vx * b.modeTime, sy = b.y + b.vy * b.modeTime;
            const target = playerAt(b.modeTime);
            const len = Math.max(1, dist(sx, sy, target.x, target.y));
            const dash = rushDashSpeed(b) * (t - b.modeTime);
            x = sx + (target.x - sx) / len * dash;
            y = sy + (target.y - sy) / len * dash;
        }
        if (b.mode === Mode.GrowWarning || b.mode === Mode.Growing) r = b.bigR;
        if (b.mode === Mode.Resizing) r = Math.max(b.r, b.targetR);
        return { x: clamp(x, r, W - r), y: clamp(y, r, H - r), r };
    }

    function autoPilot(dt) {
        const timeScale = ballTimeScale(); // in slow-mo the balls cover less ground
        const curSpeed = Math.hypot(autoVel.x, autoVel.y);
        let best = AUTO_MOVES[0], bestScore = Infinity;

        for (const m of AUTO_MOVES) {
            const playerAt = t => clampPlayer({ x: mouse.x + m.dx * m.speed * t, y: mouse.y + m.dy * m.speed * t });
            let score = 0, end = mouse;
            for (let k = 1; k <= AUTO_SAMPLES; k++) {
                const t = AUTO_HORIZON * k / AUTO_SAMPLES;
                const w = (AUTO_SAMPLES + 1 - k) / AUTO_SAMPLES; // the near future matters most
                const p = end = playerAt(t);
                for (const b of balls) {
                    const q = predictBall(b, t * timeScale, bt => playerAt(bt / timeScale));
                    const gap = dist(p.x, p.y, q.x, q.y) - q.r - playerR;
                    score += w * (gap < 4 ? 40 : Math.exp(-gap / 35));
                }
                // Corners and walls are where you get pinned
                const wallGap = Math.min(p.x, W - p.x, p.y, H - p.y) - playerR;
                score += w * 0.4 * Math.exp(-wallGap / 40);
            }
            score += 0.2 * dist(end.x, end.y, W / 2, H / 2) / W;    // drift back towards open space
            if (curSpeed > 1 && m.speed > 0)                          // don't zig-zag for nothing
                score += 0.08 * (1 - (m.dx * autoVel.x + m.dy * autoVel.y) / curSpeed);
            if (score < bestScore) { bestScore = score; best = m; }
        }

        const k = Math.min(1, dt * 12);
        autoVel.x += (best.dx * best.speed - autoVel.x) * k;
        autoVel.y += (best.dy * best.speed - autoVel.y) * k;
        mouse = clampPlayer({ x: mouse.x + autoVel.x * dt, y: mouse.y + autoVel.y * dt });
    }

    // ---- Rare events: join and split ----

    const RARE_EVENT_CHANCE = 0.5; // share of events that become a join or split instead
    const JOIN_PULL_SPEED = 260, JOIN_TIMEOUT = 3, JOIN_MAX_RADIUS = 48;
    const SPLIT_WARN_TIME = 1, SPLIT_MIN_RADIUS = 18, CHILD_MIN_RADIUS = 12;
    const TRIPLE_SPLIT_AFTER = 90, TRIPLE_SPLIT_CHANCE = 0.4; // later in a run, some splits make three balls
    const JOIN_LIGHT = rgb(150, 240, 255), JOIN_DARK = rgb(0, 110, 140);
    const SPLIT_LIGHT = rgb(255, 140, 200), SPLIT_DARK = rgb(150, 30, 90);

    function tryJoin() {
        // Two nearby balls, both well away from the player
        const free = balls.filter(b => b.mode === Mode.Normal && dist(b.x, b.y, mouse.x, mouse.y) > 220);
        const pairs = [];
        for (let i = 0; i < free.length; i++) {
            for (let j = i + 1; j < free.length; j++) {
                const a = free[i], b = free[j];
                const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
                if (dist(a.x, a.y, b.x, b.y) < 350 && dist(mx, my, mouse.x, mouse.y) > 250) pairs.push([a, b]);
            }
        }
        if (pairs.length === 0) return false;

        const [p, q] = pickRandom(pairs);
        for (const [x, partner] of [[p, q], [q, p]]) {
            x.mode = Mode.Joining;
            x.partner = partner;
            x.modeTime = JOIN_TIMEOUT;
            x.cruiseSpeed = speedOf(x);
        }
        showBanner('MERGE!', JOIN_LIGHT);
        sound.playEffect('merge');
        return true;
    }

    function trySplit() {
        const b = pickRandom(balls.filter(b =>
            b.mode === Mode.Normal && b.r >= SPLIT_MIN_RADIUS && dist(b.x, b.y, mouse.x, mouse.y) > 220));
        if (!b) return false;
        b.mode = Mode.SplitWarning;
        b.modeTime = SPLIT_WARN_TIME;
        b.cruiseSpeed = speedOf(b);
        b.splitParts = survived >= TRIPLE_SPLIT_AFTER && rand() < TRIPLE_SPLIT_CHANCE ? 3 : 2;
        showBanner(b.splitParts === 3 ? 'SPLIT x3!' : 'SPLIT!', SPLIT_LIGHT);
        sound.playEffect('split');
        return true;
    }

    // Runs after each physics sub-step, outside the ball loops, so balls can be added/removed safely.
    function resolveJoinsAndSplits() {
        if (!balls.some(b => b.mode === Mode.Joining || b.mode === Mode.SplitWarning)) return;

        for (const a of balls.slice()) {
            if (!balls.includes(a)) continue; // already merged this step

            if (a.mode === Mode.Joining && a.partner) {
                const p = a.partner;
                if (dist(a.x, a.y, p.x, p.y) < (a.r + p.r) * 0.85) {
                    const ma = mass(a), mp = mass(p), m = ma + mp;
                    const mvx = (a.vx * ma + p.vx * mp) / m, mvy = (a.vy * ma + p.vy * mp) / m;
                    const dir = Math.abs(mvx) + Math.abs(mvy) > 1 ? Math.atan2(mvy, mvx) : rand() * TAU;
                    const speed = (a.cruiseSpeed + p.cruiseSpeed) / 2;
                    const merged = makeBall({
                        x: (a.x * ma + p.x * mp) / m,
                        y: (a.y * ma + p.y * mp) / m,
                        r: Math.min(Math.sqrt(a.r * a.r + p.r * p.r), JOIN_MAX_RADIUS),
                        vx: Math.cos(dir) * speed,
                        vy: Math.sin(dir) * speed,
                    });
                    balls = balls.filter(b => b !== a && b !== p);
                    balls.push(merged);
                    addPop(merged.x, merged.y, merged.r, JOIN_LIGHT);
                    sound.playEffect('merged');
                } else if (a.modeTime <= 0) {
                    // Never met (e.g. blocked by other balls): give up and carry on as normal
                    for (const x of [a, p]) {
                        x.mode = Mode.Normal;
                        x.partner = null;
                        setSpeed(x, x.cruiseSpeed);
                    }
                }
            } else if (a.mode === Mode.SplitWarning && a.modeTime <= 0) {
                // Pieces with the same total area as the original
                const parts = a.splitParts === 3 ? 3 : 2;
                const childR = Math.max(CHILD_MIN_RADIUS, a.r / Math.sqrt(parts));
                const heading = Math.atan2(a.vy, a.vx);
                const speed = Math.max(a.cruiseSpeed, 120 * currentDifficulty().speed) * 1.1;
                balls = balls.filter(b => b !== a);
                if (parts === 2) {
                    // Two halves veering apart from the original heading
                    const px = -Math.sin(heading), py = Math.cos(heading);
                    for (const side of [-1, 1]) {
                        const dir = heading + side * 0.6;
                        balls.push(makeBall({
                            x: a.x + px * side * (childR + 1),
                            y: a.y + py * side * (childR + 1),
                            r: childR,
                            vx: Math.cos(dir) * speed,
                            vy: Math.sin(dir) * speed,
                        }));
                    }
                } else {
                    // Three pieces bursting outward, evenly spaced around the old heading
                    const spread = childR * 1.2 + 1; // far enough apart that they don't overlap
                    for (let k = 0; k < 3; k++) {
                        const dir = heading + k * TAU / 3;
                        balls.push(makeBall({
                            x: a.x + Math.cos(dir) * spread,
                            y: a.y + Math.sin(dir) * spread,
                            r: childR,
                            vx: Math.cos(dir) * speed,
                            vy: Math.sin(dir) * speed,
                        }));
                    }
                }
                addPop(a.x, a.y, a.r, SPLIT_LIGHT);
                sound.playEffect('splitPop');
            }
        }
    }

    // Expanding ring shown when balls join or split
    const pops = [];
    const POP_DURATION = 0.45;
    const addPop = (x, y, r, color) => pops.push({ x, y, r, color, age: 0 });

    function updatePops(dt) {
        for (const p of pops) p.age += dt;
        for (let i = pops.length - 1; i >= 0; i--) if (pops[i].age >= POP_DURATION) pops.splice(i, 1);
    }

    // ---- Random events ----

    const RUSH_LIGHT = rgb(255, 160, 50), RUSH_DARK = rgb(170, 60, 0);
    const CURVE_LIGHT = rgb(200, 120, 255), CURVE_DARK = rgb(90, 30, 170);
    const NORMAL_LIGHT = rgb(70, 140, 255), NORMAL_DARK = rgb(20, 50, 160);
    const FROZEN_LIGHT = rgb(235, 248, 255), FROZEN_DARK = rgb(120, 170, 220);
    const GIANT_LIGHT = rgb(110, 235, 160), GIANT_DARK = rgb(20, 120, 70);
    const HOMING_LIGHT = rgb(240, 70, 110), HOMING_DARK = rgb(110, 10, 40);

    // Homing event: a slow seeker with a limited turn rate, so it can be outmanoeuvred
    const HOMING_DURATION = 7, HOMING_SPEED = 150, HOMING_TURN_RATE = 2.2;

    // Speed-up event: balls heat up and go faster for a while
    const BOOST_LIGHT = rgb(255, 250, 190), BOOST_DARK = rgb(210, 130, 20);
    const BOOST_FACTOR = 1.75, BOOST_MIN_DURATION = 3, BOOST_MAX_DURATION = 5;

    // Giant event timing: warning, then grow / hold / shrink
    const GROW_WARN_TIME = 0.9, GROW_UP = 0.35, GROW_HOLD = 10, GROW_DOWN = 0.45;
    const GROW_TOTAL = GROW_UP + GROW_HOLD + GROW_DOWN;

    // Resize event: balls permanently grow or shrink, after a short warning
    const RESIZE_LIGHT = rgb(235, 235, 250), RESIZE_DARK = rgb(90, 95, 140);
    const RESIZE_WARN_TIME = 0.8, RESIZE_TIME = 0.4;
    const RESIZE_GROW = 1.5, RESIZE_SHRINK = 0.65;
    const RESIZE_MIN_RADIUS = 8, RESIZE_MAX_RADIUS = JOIN_MAX_RADIUS;

    let eventTimer = 0;
    // Banners stack: the newest sits on top and older ones slide down beneath it until they fade.
    const banners = []; // { text, color, time, y }
    const BANNER_DURATION = 2, MAX_BANNERS = 4, BANNER_TOP = 70, BANNER_GAP = 42;

    function triggerRandomEvent() {
        const d = currentDifficulty();
        eventTimer = d.eventEvery * (0.7 + rand() * 0.6);
        const count = randInt(1, d.maxEventBalls + 1);
        const kind = randInt(0, 6);

        // Rare: two balls join into one, or one ball splits in two
        if (rand() < RARE_EVENT_CHANCE && (randInt(0, 2) === 0 ? tryJoin() || trySplit() : trySplit() || tryJoin()))
            return;

        const normal = () => balls.filter(b => b.mode === Mode.Normal);

        if (kind === 5) {
            // Resize: a few balls permanently grow or shrink. Growing balls must stay clear of the player.
            const grow = randInt(0, 2) === 0;
            const picks = shuffle(normal().filter(b => grow
                ? b.r < RESIZE_MAX_RADIUS - 2 &&
                  dist(b.x, b.y, mouse.x, mouse.y) > Math.min(b.r * RESIZE_GROW, RESIZE_MAX_RADIUS) + PLAYER_RADIUS + 80
                : b.r > RESIZE_MIN_RADIUS + 2)).slice(0, count);
            if (picks.length === 0) return;
            for (const b of picks) {
                b.mode = Mode.Resizing;
                b.modeTime = RESIZE_WARN_TIME + RESIZE_TIME;
                b.baseR = b.r;
                b.targetR = grow ? Math.min(b.r * RESIZE_GROW, RESIZE_MAX_RADIUS) : Math.max(b.r * RESIZE_SHRINK, RESIZE_MIN_RADIUS);
            }
            showBanner(grow ? 'GROW!' : 'SHRINK!', RESIZE_LIGHT);
            sound.playEffect(grow ? 'grow' : 'shrink');
        } else if (kind === 2) {
            // Giant: one ball swells up for a moment. Only a ball whose full size won't land on the player.
            const pick = pickRandom(normal()
                .map(b => ({ ball: b, big: clamp(b.r * 3, 70, 95) }))
                .filter(p => dist(p.ball.x, p.ball.y, mouse.x, mouse.y) > p.big + PLAYER_RADIUS + 80));
            if (!pick) return;
            const b = pick.ball;
            b.mode = Mode.GrowWarning;
            b.modeTime = GROW_WARN_TIME;
            b.baseR = b.r;
            b.bigR = pick.big;
            showBanner('GIANT!', GIANT_LIGHT);
            sound.playEffect('giant');
        } else if (kind === 4) {
            // Speed up: a few balls temporarily go much faster
            const picks = shuffle(normal()).slice(0, count);
            if (picks.length === 0) return;
            for (const b of picks) {
                b.mode = Mode.Boosted;
                b.modeTime = BOOST_MIN_DURATION + rand() * (BOOST_MAX_DURATION - BOOST_MIN_DURATION);
                b.cruiseSpeed = speedOf(b);
                b.trailColor = BOOST_DARK;
            }
            showBanner('SPEED UP!', BOOST_LIGHT);
            sound.playEffect('speedUp');
        } else if (kind === 3) {
            // Homing: one ball slowly hunts the player
            const b = pickRandom(normal().filter(b => dist(b.x, b.y, mouse.x, mouse.y) > 200));
            if (!b) return;
            b.mode = Mode.Homing;
            b.modeTime = HOMING_DURATION;
            b.cruiseSpeed = speedOf(b);
            b.trailColor = HOMING_LIGHT;
            showBanner('HUNTED!', HOMING_LIGHT);
            sound.playEffect('hunted');
        } else if (kind === 0) {
            // Rush: only balls far enough away to be dodgeable.
            const picks = shuffle(normal().filter(b => dist(b.x, b.y, mouse.x, mouse.y) > 250)).slice(0, count);
            if (picks.length === 0) return;
            for (const b of picks) {
                b.mode = Mode.RushWarning;
                b.modeTime = 0.8;
                b.cruiseSpeed = speedOf(b);
                b.trailColor = RUSH_LIGHT;
            }
            showBanner(picks.length === 1 ? 'INCOMING!' : `INCOMING x${picks.length}!`, RUSH_LIGHT);
            sound.playEffect('incoming');
        } else {
            const picks = shuffle(normal()).slice(0, count);
            if (picks.length === 0) return;
            for (const b of picks) {
                b.mode = Mode.Curving;
                b.modeTime = 4 + rand() * 2;
                b.phase = 0;
                b.trailColor = CURVE_LIGHT;
                if (randInt(0, 2) === 0) {
                    // Spiral: steady turn in one direction
                    b.turnRate = (1.5 + rand() * 1.5) * (randInt(0, 2) === 0 ? -1 : 1);
                    b.wobbleAmp = 0;
                } else {
                    // Snake: weaves left and right
                    b.turnRate = 0;
                    b.wobbleAmp = 4 + rand() * 2.5;
                    b.wobbleFreq = 4 + rand() * 3;
                }
            }
            showBanner('WOBBLE!', CURVE_LIGHT);
            sound.playEffect('wobble');
        }
    }

    // ---- Anti-camping: standing still sends the two nearest balls rushing at you ----

    const IDLE_MOVE_RADIUS = 30;   // moving less than this from where you stopped counts as standing still
    const IDLE_WARN_TIME = 1.2;    // a ring closes in on the player over the last stretch
    const idleLimit = () => currentDifficulty().idleLimit; // seconds standing still before the rush; shorter on harder settings
    const IDLE_RUSH_MIN_DIST = 150; // too-close balls are skipped so the rush stays dodgeable
    let idleAnchor = { x: W / 2, y: H / 2 };
    let idleTime = 0;

    function updateIdle(dt) {
        if (autoTime > 0 || dist(mouse.x, mouse.y, idleAnchor.x, idleAnchor.y) > IDLE_MOVE_RADIUS) {
            idleAnchor = { x: mouse.x, y: mouse.y };
            idleTime = 0;
            return;
        }
        const before = idleTime;
        idleTime += dt;
        // The moment the warning ring appears, tell the player to move.
        if (before < idleLimit() - IDLE_WARN_TIME && idleTime >= idleLimit() - IDLE_WARN_TIME) {
            showBanner('MOVE IT!', RUSH_LIGHT);
            sound.playEffect('moveIt');
        }
        if (idleTime < idleLimit()) return;

        const picks = balls
            .filter(b => b.mode === Mode.Normal && b.frozenTime <= 0 && dist(b.x, b.y, mouse.x, mouse.y) > IDLE_RUSH_MIN_DIST)
            .sort((a, b) => dist(a.x, a.y, mouse.x, mouse.y) - dist(b.x, b.y, mouse.x, mouse.y))
            .slice(0, 2);
        if (picks.length === 0) return; // nothing free right now; try again next frame
        for (const b of picks) {
            b.mode = Mode.RushWarning;
            b.modeTime = 0.8;
            b.cruiseSpeed = speedOf(b);
            b.trailColor = RUSH_LIGHT;
        }
        showBanner(picks.length === 1 ? 'INCOMING!' : 'INCOMING! x2', RUSH_LIGHT);
        sound.playEffect('incoming');
        idleTime = 0; // keep standing still and it happens again
    }

    function drawIdleWarning(player) {
        const left = idleLimit() - idleTime;
        if (left > IDLE_WARN_TIME) return;
        const t = 1 - left / IDLE_WARN_TIME; // 0 → 1 as the rush gets closer
        strokeCircle(player.x, player.y, playerR + 6 + 40 * (1 - t), css(RUSH_LIGHT, 60 + 160 * t), 2, 'dash', survived * 8);
    }

    function showBanner(text, color) {
        // The same text again just moves back to the top instead of showing twice
        const i = banners.findIndex(b => b.text === text);
        if (i >= 0) banners.splice(i, 1);
        banners.unshift({ text, color, time: BANNER_DURATION, y: BANNER_TOP });
        if (banners.length > MAX_BANNERS) banners.pop();
    }

    function updateBanners(dt) {
        for (const b of banners) b.time -= dt;
        for (let i = banners.length - 1; i >= 0; i--) if (banners[i].time <= 0) banners.splice(i, 1);
        // Each one eases to its slot
        banners.forEach((b, i) => { b.y += (BANNER_TOP + i * BANNER_GAP - b.y) * Math.min(1, dt * 12); });
    }

    const rushDashSpeed = b => Math.max(b.cruiseSpeed * 2, 450 * currentDifficulty().speed);

    function updateBehavior(b, dt) {
        const d = currentDifficulty();
        switch (b.mode) {
            case Mode.RushWarning:
                // Wind up: slow down, then launch straight at where the player is at that moment.
                b.vx *= Math.pow(0.15, dt);
                b.vy *= Math.pow(0.15, dt);
                b.modeTime -= dt;
                if (b.modeTime <= 0) {
                    const dx = mouse.x - b.x, dy = mouse.y - b.y;
                    const len = Math.max(1, Math.hypot(dx, dy));
                    const dash = rushDashSpeed(b);
                    b.vx = dx / len * dash;
                    b.vy = dy / len * dash;
                    b.mode = Mode.Rushing;
                    b.modeTime = 1.1;
                    sound.playEffect('launch');
                }
                break;

            case Mode.Rushing:
                b.modeTime -= dt;
                if (b.modeTime <= 0) {
                    setSpeed(b, b.cruiseSpeed);
                    b.mode = Mode.Normal;
                }
                break;

            case Mode.Curving: {
                b.phase += dt;
                const omega = b.turnRate + b.wobbleAmp * Math.sin(b.phase * b.wobbleFreq);
                const cos = Math.cos(omega * dt), sin = Math.sin(omega * dt);
                [b.vx, b.vy] = [b.vx * cos - b.vy * sin, b.vx * sin + b.vy * cos];
                b.modeTime -= dt;
                if (b.modeTime <= 0) b.mode = Mode.Normal;
                break;
            }

            case Mode.Homing: {
                // Turn toward the player at a limited rate and ease to a gentle speed
                const target = Math.atan2(mouse.y - b.y, mouse.x - b.x);
                let heading = Math.atan2(b.vy, b.vx);
                const diff = target - heading - TAU * Math.round((target - heading) / TAU);
                heading += clamp(diff, -HOMING_TURN_RATE * dt, HOMING_TURN_RATE * dt);
                let speed = speedOf(b);
                speed += (HOMING_SPEED * d.speed - speed) * Math.min(1, dt * 3);
                b.vx = Math.cos(heading) * speed;
                b.vy = Math.sin(heading) * speed;

                b.modeTime -= dt;
                if (b.modeTime <= 0) {
                    setSpeed(b, b.cruiseSpeed);
                    b.mode = Mode.Normal;
                }
                break;
            }

            case Mode.Joining: {
                // Pull toward the partner, speeding up as they close in
                const p = b.partner;
                const dx = p.x - b.x, dy = p.y - b.y;
                const len = Math.max(1, Math.hypot(dx, dy));
                const pull = JOIN_PULL_SPEED * d.speed;
                const k = Math.min(1, dt * 4);
                b.vx += (dx / len * pull - b.vx) * k;
                b.vy += (dy / len * pull - b.vy) * k;
                b.modeTime -= dt;
                break;
            }

            case Mode.SplitWarning:
                b.modeTime -= dt;
                break;

            case Mode.Boosted: {
                // Ramp up quickly, hold, then ease back down over the last half second
                const boost = b.modeTime < 0.5 ? 1 + (BOOST_FACTOR - 1) * (b.modeTime / 0.5) : BOOST_FACTOR;
                const speed = speedOf(b);
                setSpeed(b, speed + (b.cruiseSpeed * boost - speed) * Math.min(1, dt * 6));
                b.modeTime -= dt;
                if (b.modeTime <= 0) {
                    setSpeed(b, b.cruiseSpeed);
                    b.mode = Mode.Normal;
                }
                break;
            }

            case Mode.GrowWarning:
                b.modeTime -= dt;
                if (b.modeTime <= 0) {
                    b.mode = Mode.Growing;
                    b.modeTime = GROW_TOTAL;
                }
                break;

            case Mode.Growing: {
                b.modeTime -= dt;
                const e = GROW_TOTAL - b.modeTime;
                const s = e < GROW_UP ? smoothStep(e / GROW_UP)
                    : e < GROW_UP + GROW_HOLD ? 1
                        : 1 - smoothStep((e - GROW_UP - GROW_HOLD) / GROW_DOWN);
                b.r = b.baseR + (b.bigR - b.baseR) * s;
                if (b.modeTime <= 0) {
                    b.r = b.baseR;
                    b.mode = Mode.Normal;
                }
                break;
            }

            case Mode.Resizing: {
                // Hold during the warning, then ease to the new size and keep it
                const wasWarning = b.modeTime > RESIZE_TIME;
                b.modeTime -= dt;
                const s = smoothStep(1 - b.modeTime / RESIZE_TIME);
                b.r = b.baseR + (b.targetR - b.baseR) * s;
                if (wasWarning && b.modeTime <= RESIZE_TIME) addPop(b.x, b.y, b.baseR, RESIZE_LIGHT);
                if (b.modeTime <= 0) {
                    b.r = b.targetR;
                    b.mode = Mode.Normal;
                }
                break;
            }
        }
    }

    // Special balls leave a short fading trail; it shrinks away once they're back to normal.
    function updateTrails() {
        for (const b of balls) {
            const special = b.mode === Mode.Rushing || b.mode === Mode.Curving || b.mode === Mode.Homing || b.mode === Mode.Boosted;
            if (special && b.frozenTime <= 0) {
                b.trail.push({ x: b.x, y: b.y });
                if (b.trail.length > 14) b.trail.shift();
            } else if (b.trail.length > 0) {
                b.trail.shift();
            }
        }
    }

    // ---- Drawing primitives ----

    const font = (pt, bold) =>
        `${bold ? 'bold ' : ''}${(pt * 4 / 3).toFixed(1)}px "Segoe UI", system-ui, -apple-system, Roboto, sans-serif`;

    function drawText(text, x, y, pt, bold, fill, align = 'left', baseline = 'top') {
        ctx.font = font(pt, bold);
        ctx.fillStyle = fill;
        ctx.textAlign = align;
        ctx.textBaseline = baseline;
        ctx.fillText(text, x, y);
    }

    /** Draws text (possibly several lines) centered on a point. */
    function drawCentered(text, cx, cy, pt, bold, fill) {
        const lines = text.split('\n');
        const lineHeight = pt * 4 / 3 * 1.35;
        const y0 = cy - (lines.length - 1) * lineHeight / 2;
        lines.forEach((line, i) => drawText(line, cx, y0 + i * lineHeight, pt, bold, fill, 'center', 'middle'));
    }

    function circlePath(x, y, r) {
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0, r), 0, TAU);
    }

    function fillCircle(x, y, r, fill) {
        circlePath(x, y, r);
        ctx.fillStyle = fill;
        ctx.fill();
    }

    /** dash: null, 'dash' (GDI+ Dash: 3w on, 1w off) or 'dot' (1w on, 1w off). */
    function setPen(stroke, width, dash = null, dashOffset = 0) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = width;
        ctx.setLineDash(dash === 'dash' ? [3 * width, width] : dash === 'dot' ? [width, width] : []);
        ctx.lineDashOffset = dashOffset * width;
    }

    function strokeCircle(x, y, r, stroke, width, dash = null, dashOffset = 0) {
        setPen(stroke, width, dash, dashOffset);
        circlePath(x, y, r);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    function line(x1, y1, x2, y2, stroke, width, dash = null) {
        setPen(stroke, width, dash);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    function roundRectPath(r, radius) {
        const { x, y, w, h } = r;
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.arcTo(x + w, y, x + w, y + h, radius);
        ctx.arcTo(x + w, y + h, x, y + h, radius);
        ctx.arcTo(x, y + h, x, y, radius);
        ctx.arcTo(x, y, x + w, y, radius);
        ctx.closePath();
    }

    /** A shaded ball: light near the upper-left, dark at the rim. */
    function drawBall(x, y, r, light, dark) {
        const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, 0, x, y, r + 3);
        g.addColorStop(0, css(light));
        g.addColorStop(1, css(dark));
        fillCircle(x, y, r, g);
    }

    // ---- Drawing the game ----

    function drawPowerUps() {
        for (const p of powerUps) {
            // Blink during the last 2 seconds before it vanishes
            if (p.life < 2 && Math.floor(p.life * 8) % 2 === 0) continue;

            const c = powerUpColor(p.kind);
            const y = p.y + Math.sin(p.age * 3) * 4;
            const pulse = 0.5 + 0.5 * Math.sin(p.age * 5);

            fillCircle(p.x, y, POWERUP_RADIUS + 8 + pulse * 6, css(c, 30 + 30 * pulse));
            fillCircle(p.x, y, POWERUP_RADIUS, css(rgb(20, 24, 40), 200));
            // Cursed ones have a jagged, rotating dashed ring
            if (isCursed(p.kind)) strokeCircle(p.x, y, POWERUP_RADIUS, css(c), 2.5, 'dash', -p.age * 6);
            else strokeCircle(p.x, y, POWERUP_RADIUS, css(c), 2.5);
            // The rare bomb has sparks circling it so it stands out
            if (p.kind === PowerUpKind.Destroy)
                for (let i = 0; i < 4; i++) {
                    const a = p.age * 2.5 + i * TAU / 4;
                    const twinkle = 0.5 + 0.5 * Math.sin(p.age * 9 + i * 2);
                    fillCircle(p.x + Math.cos(a) * (POWERUP_RADIUS + 9), y + Math.sin(a) * (POWERUP_RADIUS + 9),
                        1.5 + 1.5 * twinkle, css(rgb(255, 230, 120), 150 + 100 * twinkle));
                }

            drawPowerUpIcon(p.kind, p.x, y, c);
        }
    }

    function drawPowerUpIcon(kind, x, y, c) {
        const fill = css(c);
        const poly = points => {
            ctx.beginPath();
            points.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py));
            ctx.closePath();
            ctx.fillStyle = fill;
            ctx.fill();
        };
        const corners = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
        switch (kind) {
            case PowerUpKind.Slow: // hourglass
                poly([[x - 6, y - 8], [x + 6, y - 8], [x, y]]);
                poly([[x, y], [x - 6, y + 8], [x + 6, y + 8]]);
                line(x - 7, y - 9, x + 7, y - 9, fill, 2);
                line(x - 7, y + 9, x + 7, y + 9, fill, 2);
                break;
            case PowerUpKind.Shrink: // small dot with arrows pointing in
                fillCircle(x, y, 3, fill);
                for (const [dx, dy] of corners) {
                    line(x + dx * 10, y + dy * 10, x + dx * 6, y + dy * 6, fill, 2);
                    line(x + dx * 6, y + dy * 6, x + dx * 6, y + dy * 9, fill, 2);
                    line(x + dx * 6, y + dy * 6, x + dx * 9, y + dy * 6, fill, 2);
                }
                break;
            case PowerUpKind.Bloat: // big dot with arrows pointing out
                fillCircle(x, y, 5, fill);
                for (const [dx, dy] of corners) {
                    line(x + dx * 6, y + dy * 6, x + dx * 11, y + dy * 11, fill, 2);
                    line(x + dx * 11, y + dy * 11, x + dx * 11, y + dy * 8, fill, 2);
                    line(x + dx * 11, y + dy * 11, x + dx * 8, y + dy * 11, fill, 2);
                }
                break;
            case PowerUpKind.Auto: // steering wheel
                strokeCircle(x, y, 8, fill, 2);
                fillCircle(x, y, 2.5, fill);
                for (const a of [-Math.PI / 2, Math.PI / 6, Math.PI * 5 / 6])
                    line(x, y, x + Math.cos(a) * 8, y + Math.sin(a) * 8, fill, 2);
                break;
            case PowerUpKind.Shield: // shield shape
                poly([[x, y - 9], [x + 8, y - 6], [x + 7, y + 2], [x, y + 10], [x - 7, y + 2], [x - 8, y - 6]]);
                break;
            case PowerUpKind.Sluggish: // snail
                strokeCircle(x + 1, y - 1, 6, fill, 2); // shell
                strokeCircle(x + 1, y - 1, 2.5, fill, 1.5);
                line(x - 9, y + 6, x + 9, y + 6, fill, 2.5); // body
                line(x - 8, y + 6, x - 9, y - 1, fill, 2); // head and feelers
                line(x - 9, y - 1, x - 11, y - 5, fill, 1.5);
                line(x - 9, y - 1, x - 7, y - 5, fill, 1.5);
                break;
            case PowerUpKind.Destroy: // bomb with a lit fuse
                fillCircle(x - 1, y + 2, 7, fill);
                ctx.fillStyle = fill;
                ctx.fillRect(x + 2, y - 8, 4, 4); // the cap
                line(x + 4, y - 8, x + 7, y - 11, fill, 1.5); // the fuse
                fillCircle(x + 8, y - 12, 2, css(rgb(255, 240, 160)));
                break;
            case PowerUpKind.Freeze: // snowflake
                for (let k = 0; k < 3; k++) {
                    const a = Math.PI / 2 + k * TAU / 6;
                    const cx = Math.cos(a) * 9, cy = Math.sin(a) * 9;
                    line(x - cx, y - cy, x + cx, y + cy, fill, 2);
                    for (const sgn of [-1, 1]) { // little V at each tip
                        const tx = x + sgn * cx * 0.65, ty = y + sgn * cy * 0.65;
                        for (const side of [-1, 1]) {
                            const b2 = a + (sgn < 0 ? Math.PI : 0) + side * 2.4;
                            line(tx, ty, tx + Math.cos(b2) * 4, ty + Math.sin(b2) * 4, fill, 1.5);
                        }
                    }
                }
                break;
        }
    }

    function drawPlayerEffects(player) {
        // Autopilot: three dots orbiting the player; they flicker in the last second
        if (autoTime > 0 && (autoTime > 1 || Math.floor(autoTime * 12) % 2 === 0)) {
            const c = css(powerUpColor(PowerUpKind.Auto), 230);
            for (let i = 0; i < 3; i++) {
                const a = survived * 6 + i * TAU / 3;
                fillCircle(player.x + Math.cos(a) * (playerR + 7), player.y + Math.sin(a) * (playerR + 7), 3, c);
            }
        }

        // Sluggish: a thick, slowly turning purple goo ring; flickers in the last second
        if (sluggishTime > 0 && (sluggishTime > 1 || Math.floor(sluggishTime * 12) % 2 === 0)) {
            const c = powerUpColor(PowerUpKind.Sluggish);
            fillCircle(player.x, player.y, playerR + 6, css(c, 60));
            strokeCircle(player.x, player.y, playerR + 6, css(c, 230), 3, 'dash', survived * 2);
        }

        if (shieldTime <= 0) return;
        // Bubble around the player; flickers in the last second as a warning
        const visible = shieldTime > 1 || Math.floor(shieldTime * 12) % 2 === 0;
        if (!visible) return;
        const r = playerR + 8 + Math.sin(survived * 12) * 1.5;
        fillCircle(player.x, player.y, r, css(WHITE, 50));
        strokeCircle(player.x, player.y, r, css(WHITE, 220), 2.5);
    }

    function drawActiveEffects() {
        const x = 12;
        let y = 40;
        const bar = (label, t, total, kind) => {
            if (t <= 0) return;
            const c = powerUpColor(kind);
            const w = 140, h = 18;
            ctx.fillStyle = css(rgb(0, 0, 0), 120);
            ctx.fillRect(x, y, w, h);
            ctx.fillStyle = css(c, 170);
            ctx.fillRect(x, y, w * (t / total), h);
            drawText(`${label} ${t.toFixed(1)}s`, x + 4, y + h / 2 + 1, 10, true, 'white', 'left', 'middle');
            y += h + 4;
        };
        bar('Slow-mo', slowTime, SLOW_DURATION, PowerUpKind.Slow);
        bar('Tiny', shrinkTime, SHRINK_DURATION, PowerUpKind.Shrink);
        bar('Shield', shieldTime, SHIELD_DURATION, PowerUpKind.Shield);
        bar('Cursed: big', bloatTime, BLOAT_DURATION, PowerUpKind.Bloat);
        bar('Cursed: slow', sluggishTime, SLUGGISH_DURATION, PowerUpKind.Sluggish);
        bar('Autopilot', autoTime, AUTO_DURATION, PowerUpKind.Auto);
    }

    function drawPops() {
        for (const p of pops) {
            const t = p.age / POP_DURATION;
            strokeCircle(p.x, p.y, p.r + 35 * t, css(p.color, 220 * (1 - t)), 3 * (1 - t) + 1);
        }
    }

    function drawSpecialBall(b) {
        const n = b.trail.length;
        b.trail.forEach((p, i) => {
            const t = (i + 1) / (n + 1);
            fillCircle(p.x, p.y, b.r * (0.35 + 0.5 * t), css(b.trailColor, 90 * t));
        });

        // Frozen: an icy ball with a frost ring; flickers back to its own look in the last second
        if (b.frozenTime > 0 && (b.frozenTime > 1 || Math.floor(b.frozenTime * 10) % 2 === 0)) {
            drawBall(b.x, b.y, b.r, FROZEN_LIGHT, FROZEN_DARK);
            strokeCircle(b.x, b.y, b.r + 3, css(FROZEN_LIGHT, 200), 2, 'dash');
            for (let k = 0; k < 3; k++) { // a little six-spoke frost mark
                const a = k * TAU / 6, s = b.r * 0.45;
                line(b.x - Math.cos(a) * s, b.y - Math.sin(a) * s, b.x + Math.cos(a) * s, b.y + Math.sin(a) * s, css(WHITE, 170), 1.5);
            }
            return;
        }

        switch (b.mode) {
            case Mode.RushWarning: {
                // Aim line, shrinking ring and a flashing ball
                line(b.x, b.y, mouse.x, mouse.y, css(RUSH_LIGHT, 110), 2, 'dash');
                const on = Math.floor(b.modeTime * 12) % 2 === 0;
                drawBall(b.x, b.y, b.r, on ? RUSH_LIGHT : NORMAL_LIGHT, on ? RUSH_DARK : NORMAL_DARK);
                strokeCircle(b.x, b.y, b.r + 4 + b.modeTime * 14, css(RUSH_LIGHT, 200), 2);
                break;
            }
            case Mode.Rushing:
                drawBall(b.x, b.y, b.r, RUSH_LIGHT, RUSH_DARK);
                break;
            case Mode.Curving:
                drawBall(b.x, b.y, b.r, CURVE_LIGHT, CURVE_DARK);
                break;
            case Mode.GrowWarning: {
                // Dashed outline of the size it's about to reach, plus a flashing ball
                const pulse = 0.5 + 0.5 * Math.sin(b.modeTime * 25);
                strokeCircle(b.x, b.y, b.bigR, css(GIANT_LIGHT, 90 + 120 * pulse), 2.5, 'dash');
                fillCircle(b.x, b.y, b.bigR, css(GIANT_LIGHT, 25 + 25 * pulse));
                const on = Math.floor(b.modeTime * 12) % 2 === 0;
                drawBall(b.x, b.y, b.r, on ? GIANT_LIGHT : NORMAL_LIGHT, on ? GIANT_DARK : NORMAL_DARK);
                break;
            }
            case Mode.Growing:
                drawBall(b.x, b.y, b.r, GIANT_LIGHT, GIANT_DARK);
                break;
            case Mode.Resizing: {
                // Dashed outline of the new size; the ball flashes until it starts changing
                if (b.modeTime > RESIZE_TIME) {
                    const pulse = 0.5 + 0.5 * Math.sin(b.modeTime * 25);
                    strokeCircle(b.x, b.y, b.targetR, css(RESIZE_LIGHT, 90 + 120 * pulse), 2, 'dash', survived * 6);
                    const on = Math.floor(b.modeTime * 12) % 2 === 0;
                    drawBall(b.x, b.y, b.r, on ? RESIZE_LIGHT : NORMAL_LIGHT, on ? RESIZE_DARK : NORMAL_DARK);
                } else {
                    drawBall(b.x, b.y, b.r, RESIZE_LIGHT, RESIZE_DARK);
                }
                break;
            }
            case Mode.Joining: {
                // Pulsing tether between the pair (drawn once, by whichever comes first in the list)
                const p = b.partner;
                if (balls.indexOf(b) < balls.indexOf(p)) {
                    const pulse = 0.5 + 0.5 * Math.sin(survived * 14);
                    line(b.x, b.y, p.x, p.y, css(JOIN_LIGHT, 90 + 120 * pulse), 2 + pulse * 2, 'dot');
                }
                drawBall(b.x, b.y, b.r, JOIN_LIGHT, JOIN_DARK);
                break;
            }
            case Mode.SplitWarning: {
                // Shakes harder and flashes faster right before it splits
                const urgency = 1 - b.modeTime / SPLIT_WARN_TIME;
                const sx = (rand() - 0.5) * 6 * urgency;
                const sy = (rand() - 0.5) * 6 * urgency;
                const on = Math.floor(b.modeTime * (8 + 16 * urgency)) % 2 === 0;
                drawBall(b.x + sx, b.y + sy, b.r, on ? SPLIT_LIGHT : NORMAL_LIGHT, on ? SPLIT_DARK : NORMAL_DARK);
                // A crack along the split line; a three-way split cracks in a Y between the pieces
                const a = Math.atan2(b.vy, b.vx);
                const crack = css(WHITE, 120 + 135 * urgency);
                if (b.splitParts === 3) {
                    for (let k = 0; k < 3; k++) {
                        const ca = a + TAU / 6 + k * TAU / 3;
                        line(b.x + sx, b.y + sy, b.x + sx + Math.cos(ca) * b.r * 0.8, b.y + sy + Math.sin(ca) * b.r * 0.8, crack, 2);
                    }
                } else {
                    const cx = Math.cos(a) * b.r * 0.8, cy = Math.sin(a) * b.r * 0.8;
                    line(b.x + sx - cx, b.y + sy - cy, b.x + sx + cx, b.y + sy + cy, crack, 2);
                }
                break;
            }
            case Mode.Boosted: {
                // Hot glow that flickers
                const flick = 0.6 + 0.4 * Math.sin(survived * 30 + b.x * 0.05);
                fillCircle(b.x, b.y, b.r + 6, css(BOOST_DARK, 70 * flick));
                drawBall(b.x, b.y, b.r, BOOST_LIGHT, BOOST_DARK);
                break;
            }
            case Mode.Homing: {
                drawBall(b.x, b.y, b.r, HOMING_LIGHT, HOMING_DARK);
                // An "eye" that looks at the player
                const a = Math.atan2(mouse.y - b.y, mouse.x - b.x);
                const ex = b.x + Math.cos(a) * b.r * 0.45, ey = b.y + Math.sin(a) * b.r * 0.45;
                const er = b.r * 0.32, pr = b.r * 0.16;
                fillCircle(ex, ey, er, 'white');
                fillCircle(ex + Math.cos(a) * er * 0.4, ey + Math.sin(a) * er * 0.4, pr, 'black');
                break;
            }
            default:
                drawBall(b.x, b.y, b.r, NORMAL_LIGHT, NORMAL_DARK);
                break;
        }
        drawNewBallHighlight(b);
    }

    // A ball added mid-run flashes white and sends out bright rings so you notice where it appeared.
    const NEW_BALL_HIGHLIGHT = 2;
    const NEW_BALL_LIGHT = rgb(255, 255, 255), NEW_BALL_GLOW = rgb(255, 230, 120);
    function drawNewBallHighlight(b) {
        if (b.newTime <= 0) return;
        const age = NEW_BALL_HIGHLIGHT - b.newTime;
        const fade = Math.min(1, b.newTime / 0.5); // everything fades out over the last half second

        // Glow behind the ball and a white flash that blinks a few times
        fillCircle(b.x, b.y, b.r + 10, css(NEW_BALL_GLOW, 70 * fade));
        if (Math.floor(age * 6) % 2 === 0) fillCircle(b.x, b.y, b.r, css(NEW_BALL_LIGHT, 170 * fade));

        // Three rings rippling a short way outward, one after another
        for (let k = 0; k < 3; k++) {
            const t = (age * 1.5 + k / 3) % 1;
            strokeCircle(b.x, b.y, b.r + 5 + 22 * t, css(NEW_BALL_GLOW, 230 * (1 - t) * fade), 2 * (1 - t) + 1);
        }
        strokeCircle(b.x, b.y, b.r + 4, css(NEW_BALL_LIGHT, 230 * fade), 2.5);
    }

    function drawBanners() {
        if (gameOver || waitingToStart) return;
        // Oldest first, so the newest is drawn on top while they slide past each other
        for (let i = banners.length - 1; i >= 0; i--) {
            const b = banners[i];
            const t = b.time / BANNER_DURATION;
            const alpha = 255 * Math.min(1, t * 2);
            const pop = t > 0.85 ? (t - 0.85) / 0.15 : 0; // brief scale-up when it appears
            const pt = 26 + 6 * pop;
            drawText(b.text, W / 2 + 2, b.y + 2, pt, true, css(rgb(0, 0, 0), alpha / 2), 'center', 'middle');
            drawText(b.text, W / 2, b.y, pt, true, css(b.color, alpha), 'center', 'middle');
        }
    }

    function drawCenterText(title, sub) {
        ctx.fillStyle = css(rgb(0, 0, 0), 150);
        ctx.fillRect(0, 0, W, H);
        drawCentered(title, W / 2, H / 2 - 40, 48, true, 'white');
        drawCentered(sub, W / 2, H / 2 + 40, 16, false, css(LIGHT_GRAY));
    }

    function drawDifficultySelector() {
        drawText(touchMode ? 'Difficulty' : 'Difficulty  (← / → or 1-3)', W / 2, difficultyButton(0).y - 22, 12, false,
            css(LIGHT_GRAY), 'center', 'middle');

        for (let i = 0; i < DIFFICULTIES.length; i++) {
            const d = DIFFICULTIES[i];
            let r = difficultyButton(i);
            const selected = i === difficultyIndex;
            const hover = contains(r, cursor);
            if (hover) r = inflate(r, 4, 3); // small pop under the mouse

            roundRectPath(r, 8);
            ctx.fillStyle = selected ? css(hover ? lighten(d.color, 0.35) : d.color)
                : hover ? css(d.color, 170)
                    : css(d.color, 70);
            ctx.fill();
            if (selected || hover) {
                setPen(selected ? 'white' : css(WHITE, 160), 2);
                ctx.stroke();
            }
            drawText(d.name, r.x + r.w / 2, r.y + r.h / 2, 13, true, selected || hover ? 'white' : css(GRAY), 'center', 'middle');
        }

        const hint = !touchMode ? 'The mouse is captured while you play — press Esc to pause.'
            : window.innerHeight > window.innerWidth ? 'Drag anywhere to move the red ball. Turn your phone sideways for a bigger view.'
                : 'Drag anywhere to move the red ball — it moves with your finger, not under it.';
        drawText(hint, W / 2, H - 28, touchMode ? 13 : 10, false, css(rgb(200, 210, 230), touchMode ? 190 : 140), 'center', 'middle');
    }

    function drawPauseButton() {
        if (!touchMode || !playing() || paused) return;
        const r = pauseButton();
        roundRectPath(r, 12);
        ctx.fillStyle = css(rgb(28, 32, 50), 150);
        ctx.fill();
        setPen(css(WHITE, 90), 1.5);
        ctx.stroke();
        ctx.fillStyle = css(WHITE, 210);
        ctx.fillRect(r.x + 18, r.y + 16, 7, 24);
        ctx.fillRect(r.x + 31, r.y + 16, 7, 24);
    }

    function drawButton(r, text, color) {
        const hover = contains(r, cursor);
        roundRectPath(r, 8);
        ctx.fillStyle = css(hover ? lighten(color, 0.35) : color);
        ctx.fill();
        drawText(text, r.x + r.w / 2, r.y + r.h / 2, 13, true, 'white', 'center', 'middle');
    }

    function drawPauseMenu() {
        ctx.fillStyle = css(rgb(0, 0, 0), 160);
        ctx.fillRect(0, 0, W, H);

        const m = menuRect();
        roundRectPath(m, 14);
        ctx.fillStyle = css(rgb(28, 32, 50), 235);
        ctx.fill();
        setPen(css(rgb(140, 170, 255), 90), 1.5);
        ctx.stroke();

        drawText('PAUSED', m.x + m.w / 2, m.y + 42, 26, true, 'white', 'center', 'middle');

        // Volume sliders
        SLIDERS.forEach(([label, , prop], i) => {
            const s = sliderRect(i);
            const vol = sound[prop];
            // With a keyboard, the label of the slider the arrow keys adjust is highlighted.
            const focused = !touchMode && i === focusedSlider;
            drawText(label, s.x, s.y - 30, 12, focused, focused ? 'white' : css(LIGHT_GRAY));
            drawText(`${Math.round(vol * 100)}%`, s.x + s.w, s.y - 30, 12, false, 'white', 'right');
            roundRectPath(s, 4);
            ctx.fillStyle = css(rgb(60, 70, 90));
            ctx.fill();
            const filled = Math.floor(s.w * vol);
            if (filled > 0) {
                roundRectPath(rect(s.x, s.y, Math.max(filled, 8), s.h), 4);
                ctx.fillStyle = css(rgb(70, 140, 255));
                ctx.fill();
            }
            drawBall(s.x + filled, s.y + s.h / 2, 11, WHITE, rgb(150, 170, 210));
        });

        drawButton(resumeButton(), 'Resume', rgb(50, 110, 220));
        drawButton(quitButton(), 'Quit', rgb(200, 60, 60));

        const hint = touchMode ? '' : playing() ? 'Click Resume to recapture the mouse' : 'Esc to close';
        drawText(hint, m.x + m.w / 2, m.y + m.h + 16, 9, false, css(rgb(200, 210, 230), 140), 'center', 'middle');
    }

    function drawLockMessage() {
        if (lockMessageTime <= 0) return;
        const alpha = 255 * Math.min(1, lockMessageTime / 0.4);
        drawText(lockMessage, W / 2, H - 60, 12, true, css(rgb(255, 200, 120), alpha), 'center', 'middle');
    }

    // ---- Background ----

    let background = null;

    // Pre-rendered once per canvas size: dark blue gradient,
    // a soft glow in the middle and a vignette towards the corners.
    function renderBackground(scale) {
        const bg = document.createElement('canvas');
        bg.width = Math.round(W * scale);
        bg.height = Math.round(H * scale);
        const g = bg.getContext('2d');
        g.setTransform(scale, 0, 0, scale, 0, 0);

        const lin = g.createLinearGradient(0, 0, 0, H);
        lin.addColorStop(0, 'rgb(24,26,44)');
        lin.addColorStop(1, 'rgb(10,12,20)');
        g.fillStyle = lin;
        g.fillRect(0, 0, W, H);

        // An elliptical radial gradient: draw a circular one under a vertical scale.
        const ellipseGlow = (cx, cy, rx, ry, stops) => {
            g.save();
            g.translate(cx, cy);
            g.scale(1, ry / rx);
            const rg = g.createRadialGradient(0, 0, 0, 0, 0, rx);
            for (const [at, color] of stops) rg.addColorStop(at, color);
            g.fillStyle = rg;
            g.fillRect(-cx, -cy * rx / ry, W, H * rx / ry); // the whole canvas, in the scaled space
            g.restore();
        };

        // Central glow
        ellipseGlow(W * 0.5, H * 0.45, W * 0.7, H * 0.75, [[0, 'rgba(70,110,200,0.157)'], [1, 'rgba(70,110,200,0)']]);

        // A few faint specks of dust/stars
        const rng = mulberry32(42);
        for (let i = 0; i < 120; i++) {
            const r = rng() * 1.4 + 0.4;
            const a = 20 + Math.floor(rng() * 50);
            const x = Math.floor(rng() * W), y = Math.floor(rng() * H);
            g.fillStyle = `rgba(200,215,255,${a / 255})`;
            g.beginPath();
            g.arc(x + r / 2, y + r / 2, r / 2, 0, TAU);
            g.fill();
        }

        // Vignette
        ellipseGlow(W * 0.5, H * 0.5, W * 0.75, H * 0.75, [[0, 'rgba(0,0,0,0)'], [0.55, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.667)']]);

        return bg;
    }

    // ---- Canvas sizing ----

    let scale = 1;

    function resize() {
        const k = Math.min(window.innerWidth / W, window.innerHeight / H);
        const cssW = Math.max(1, Math.floor(W * k)), cssH = Math.max(1, Math.floor(H * k));
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        scale = canvas.width / W;
        background = renderBackground(scale);
    }
    window.addEventListener('resize', resize);
    resize();

    // ---- Main loop ----

    function draw() {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(background, 0, 0);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);

        drawPowerUps();
        for (const b of balls) drawSpecialBall(b);
        drawPops();

        const player = gameOver ? playerFall : mouse;
        if (!waitingToStart) drawBall(player.x, player.y, playerR, rgb(255, 90, 90), rgb(160, 20, 20));
        if (playing()) { drawPlayerEffects(player); drawIdleWarning(player); drawActiveEffects(); }

        const d = currentDifficulty();
        const hud = `Time: ${survived.toFixed(1)}s   Balls: ${balls.length}   Best (${d.name}): ${best[difficultyIndex].toFixed(1)}s`;
        drawText(hud, 12, 10, 14, true, 'white');

        drawBanners();

        const startHint = touchMode ? 'Tap to start' : 'Click or press Space to start';
        if (waitingToStart)
            drawCenterText('DODGE BALLS', `Keep the red ball away from the blue ones.\n${startHint}.`);
        else if (gameOver)
            drawCenterText('YOU LOSE', `You survived ${survived.toFixed(1)} seconds.\n${touchMode ? 'Tap' : 'Click or press Space'} to play again.`);

        drawPauseButton();

        if ((waitingToStart || gameOver) && !paused) drawDifficultySelector();
        if (paused) drawPauseMenu();
        drawLockMessage();
    }

    let lastTick = performance.now() / 1000;

    function frame(nowMs) {
        const now = nowMs / 1000;
        const dt = clamp(now - lastTick, 0, 0.05);
        lastTick = now;
        lockMessageTime = Math.max(0, lockMessageTime - dt);

        if (!paused) update(dt);
        draw();
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
})();
