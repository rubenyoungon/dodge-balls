'use strict';

// Translations. The language follows the browser's preferred languages: Dutch if Dutch comes
// before English in that list, English otherwise. {name} placeholders are filled in by t().

const STRINGS = {
    en: {
        easy: 'Easy', normal: 'Normal', hard: 'Hard',
        musicVolume: 'Music volume', effectsVolume: 'Effects volume',
        lockFailed: 'Couldn’t capture the mouse — click again',

        // Banners
        newBall: 'NEW BALL!', slowMo: 'SLOW-MO!', tiny: 'TINY!', bloated: 'CURSED! BLOATED!', sluggish: 'CURSED! SLUGGISH!',
        invulnerable: 'INVULNERABLE!', autopilot: 'AUTOPILOT!', frozen: 'FROZEN!', boom: 'BOOM!', blast: 'BLAST!',
        merge: 'MERGE!', split: 'SPLIT!', split3: 'SPLIT x3!', grow: 'GROW!', shrink: 'SHRINK!', giant: 'GIANT!',
        speedUp: 'SPEED UP!', hunted: 'HUNTED!', incoming: 'INCOMING!', incomingN: 'INCOMING x{n}!', incomingIdle2: 'INCOMING! x2',
        wobble: 'WOBBLE!', moveIt: 'MOVE IT!', gravityWell: 'GRAVITY WELL!',

        // Timers for active power-ups
        barSlowMo: 'Slow-mo', barTiny: 'Tiny', barShield: 'Shield', barBloated: 'Cursed: big', barSluggish: 'Cursed: slow',
        barAutopilot: 'Autopilot',

        // Menus
        difficulty: 'Difficulty', difficultyKeys: 'Difficulty  (← / → or 1-3)',
        hintMouse: 'The mouse is captured while you play — press Esc to pause.',
        hintPortrait: 'Drag anywhere to move the red ball. Turn your phone sideways for a bigger view.',
        hintTouch: 'Drag anywhere to move the red ball — it moves with your finger, not under it.',
        paused: 'PAUSED', resume: 'Resume', quit: 'Quit',
        resumeHint: 'Click Resume to recapture the mouse', escToClose: 'Esc to close',
        hud: 'Time: {time}s   Balls: {balls}   Best ({difficulty}): {best}s',
        title: 'DODGE BALLS', tagline: 'You control the red ball. Dodge all the other balls.',
        startTap: 'Tap to start.', startClick: 'Click or press Space to start.',
        youLose: 'YOU LOSE', survived: 'You survived {time} seconds.',
        againTap: 'Tap to play again.', againClick: 'Click or press Space to play again.',
        lastUpdated: 'Last updated: {date}',
    },
    nl: {
        easy: 'Makkelijk', normal: 'Gemiddeld', hard: 'Moeilijk',
        musicVolume: 'Muziekvolume', effectsVolume: 'Effectenvolume',
        lockFailed: 'Kon de muis niet vastzetten — klik nog een keer',

        newBall: 'NIEUWE BAL!', slowMo: 'SLOW-MO!', tiny: 'MINI!', bloated: 'VERVLOEKT! OPGEBLAZEN!', sluggish: 'VERVLOEKT! TRAAG!',
        invulnerable: 'ONKWETSBAAR!', autopilot: 'AUTOPILOOT!', frozen: 'BEVROREN!', boom: 'BOEM!', blast: 'SCHOKGOLF!',
        merge: 'SAMENSMELTEN!', split: 'SPLITSING!', split3: 'SPLITSING x3!', grow: 'GROEIEN!', shrink: 'KRIMPEN!', giant: 'REUS!',
        speedUp: 'VERSNELLING!', hunted: 'OPGEJAAGD!', incoming: 'PAS OP!', incomingN: 'PAS OP! x{n}', incomingIdle2: 'PAS OP! x2',
        wobble: 'WIEBELEN!', moveIt: 'BEWEEG!', gravityWell: 'ZWAARTEKRACHT!',

        barSlowMo: 'Slow-mo', barTiny: 'Mini', barShield: 'Schild', barBloated: 'Vervloekt: groot', barSluggish: 'Vervloekt: traag',
        barAutopilot: 'Autopiloot',

        difficulty: 'Moeilijkheidsgraad', difficultyKeys: 'Moeilijkheidsgraad  (← / → of 1-3)',
        hintMouse: 'De muis wordt vastgezet tijdens het spelen — druk op Esc om te pauzeren.',
        hintPortrait: 'Sleep ergens om de rode bal te bewegen. Draai je telefoon voor een groter beeld.',
        hintTouch: 'Sleep ergens om de rode bal te bewegen — hij beweegt mee met je vinger, niet eronder.',
        paused: 'GEPAUZEERD', resume: 'Doorgaan', quit: 'Stoppen',
        resumeHint: 'Klik op Doorgaan om de muis weer vast te zetten', escToClose: 'Esc om te sluiten',
        hud: 'Tijd: {time}s   Ballen: {balls}   Record ({difficulty}): {best}s',
        title: 'DODGE BALLS', tagline: 'Jij bestuurt de rode bal. Ontwijk alle andere ballen.',
        startTap: 'Tik om te beginnen.', startClick: 'Klik of druk op spatie om te beginnen.',
        youLose: 'JE HEBT VERLOREN', survived: 'Je hebt het {time} seconden volgehouden.',
        againTap: 'Tik om opnieuw te spelen.', againClick: 'Klik of druk op spatie om opnieuw te spelen.',
        lastUpdated: 'Laatst bijgewerkt: {date}',
    },
};

const I18N = (() => {
    const preferred = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'])
        .map(l => String(l).toLowerCase().split('-')[0]);
    const lang = preferred.find(l => l in STRINGS) || 'en';
    const locale = lang === 'nl' ? 'nl-NL' : 'en-GB';
    document.documentElement.lang = lang;

    /** The text for key in the current language (falling back to English), with {name} placeholders filled in. */
    function t(key, vars = {}) {
        const text = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
        return text.replace(/\{(\w+)\}/g, (m, name) => name in vars ? String(vars[name]) : m);
    }

    /** A date and local time written out in the current language, e.g. "11 November 2026 at 14:32" or "11 november 2026 om 14:32". */
    const date = d => d.toLocaleString(locale, {
        day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });

    return { lang, t, date };
})();
