# Dodge Balls

A browser game: steer the red ball with your mouse and keep it away from the blue ones for as long as you can. Plain HTML, canvas and JavaScript, with no build step and no dependencies. All sound and music are synthesized in code with the Web Audio API.

## Running it

Open `index.html` in a browser.

You can also serve the folder with any static file server, for example:

```bash
python -m http.server 8123
```

Then go to <http://localhost:8123>.

## How to play

- Click (or press Space, Enter or R) to start. The mouse is captured while you play, and moving it moves the red ball.
- Touching a blue ball ends the run. Your best time is saved for each difficulty.
- A new ball joins every so often. A **NEW BALL!** banner announces it, and for 2 seconds the ball flashes white and sends out small golden rings so you can see where it appeared.
- **Don't camp.** If you stand still too long (5 s on Easy, 3 s on Normal, 2 s on Hard), the two nearest balls rush at you. A closing orange ring and a **MOVE IT!** banner warn you first, then **INCOMING!** shows when the balls come at you.
- Press **Esc** to pause. The pause menu has music and sound-effect volume sliders (drag them, or pick one with ↑/↓ and adjust with ←/→) and lets you quit to the menu.
- Every power-up and event has its own sound: a chime for good power-ups, a sour slide for curses, a boom for the bomb, a thump and whoosh for the blast, a warning chime when a ball hunts you, a whoosh when a ball launches at you, and so on. A soft blip tells you when a timed power-up runs out. These follow the sound-effect volume slider.

### Difficulty

Choose a difficulty on the menu with the arrow keys, A/D, 1–3, or a click.

| | Starting balls | Ball speed | New ball every | Event every |
|---|---|---|---|---|
| Easy | 6 | 0.7× | 40 s | ~12 s |
| Normal | 8 | 1.0× | 30 s | ~9 s |
| Hard | 12 | 1.35× | 20 s | ~6 s |

### Events

Every few seconds something happens to one or more balls:

| Event | What happens |
|---|---|
| **Incoming!** | Balls wind up, then dash in a straight line at where you are. |
| **Wobble!** | Balls spiral or snake around. |
| **Giant!** | A ball swells to several times its size for about 10 seconds. A dashed outline shows the size it will grow to. |
| **Grow! / Shrink!** | Balls permanently get bigger or smaller. A dashed outline shows their new size first. |
| **Hunted!** | A ball slowly homes in on you for a few seconds. |
| **Speed up!** | Balls heat up and move much faster for a while. |
| **Merge!** | Two balls are pulled together into one bigger ball. |
| **Split!** | A ball cracks and splits into two smaller ones. After 90 seconds, some splits (**Split x3!**) break a ball into three. |

### Power-ups

Power-ups appear now and then and disappear after 8 seconds. Touch one to grab it. Watch out for the cursed ones with a spinning dashed ring: about 1 in 5 power-ups is cursed. The two curses cancel each other, so the last one you grabbed wins.

| Power-up | Effect |
|---|---|
| Hourglass (cyan) | Slow-mo: the balls slow down for 5 s. |
| Arrows in (yellow) | Tiny: you shrink for 6 s. |
| Shield (white) | Invulnerable for 3 s. |
| Arrows out (pink, spinning dashed ring) | Cursed: you get bigger for 5 s. |
| Snail (purple, spinning dashed ring) | Cursed: you move at half speed for 3.4 s. |
| Steering wheel (green) | Autopilot: the red ball dodges by itself for 5 s. You can still be hit. |
| Bomb (orange, sparks) | Rare (about 1 in 25 power-ups). Destroys the ball nearest to you. |
| Shock waves (teal) | Blast: blows every ball within reach away from you. The closer a ball is, the harder it's thrown; it then slows back to its old speed. |
| Snowflake (ice blue) | Freeze: the ball nearest to you stops in place for 4 s, and other balls bounce off it. It's still deadly to touch. |

## Files

- `index.html`: the page and canvas.
- `game.js`: game loop, physics, events, power-ups and drawing.
- `audio.js`: synthesized collision sounds, power-up and event sounds, the lose sound, and the music.

Settings (difficulty, music and effects volume, best times) are kept in the browser's `localStorage`.
