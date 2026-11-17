const APP_FILES = new Set([
    '/',
    '/index.html',
    '/favicon.svg',
    '/i18n.js',
    '/audio.js',
    '/game.js',
]);

export async function onRequest({ request, next }) {
    const { pathname } = new URL(request.url);

    if (!APP_FILES.has(pathname)) {
        return new Response('Not Found', { status: 404 });
    }

    return next();
}
