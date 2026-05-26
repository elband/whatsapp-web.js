'use strict';

const crypto = require('crypto');

/**
 * Cookie session sederhana berbasis HMAC.
 * Format token: base64url(payloadJson) + "." + base64url(hmac).
 * Tidak pakai library tambahan supaya dependency tetap ringan.
 */

function b64url(buf) {
    return Buffer.from(buf)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function fromB64url(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64');
}

function sign(payload, secret) {
    const body = b64url(JSON.stringify(payload));
    const mac = b64url(
        crypto.createHmac('sha256', secret).update(body).digest(),
    );
    return `${body}.${mac}`;
}

function verify(token, secret) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body, mac] = parts;
    const expected = b64url(
        crypto.createHmac('sha256', secret).update(body).digest(),
    );
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
    let data;
    try {
        data = JSON.parse(fromB64url(body).toString('utf8'));
    } catch {
        return null;
    }
    if (data.exp && Date.now() > data.exp) return null;
    return data;
}

function constantTimeEquals(a, b) {
    a = String(a || '');
    b = String(b || '');
    if (a.length !== b.length) {
        // tetap lakukan compare untuk meratakan timing
        const fakeA = a.padEnd(Math.max(a.length, b.length, 8), ' ');
        const fakeB = b.padEnd(Math.max(a.length, b.length, 8), ' ');
        crypto.timingSafeEqual(Buffer.from(fakeA), Buffer.from(fakeB));
        return false;
    }
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const COOKIE_NAME = 'wwebjs_sess';

function buildAuth(opts) {
    const {
        apiKey,
        dashboardUser,
        dashboardPassword,
        sessionSecret,
        sessionTtlMs,
    } = opts;

    const loginEnabled = Boolean(dashboardUser && dashboardPassword);

    function issueCookie(res, username) {
        const exp = Date.now() + sessionTtlMs;
        const token = sign({ u: username, exp }, sessionSecret);
        res.cookie(COOKIE_NAME, token, {
            httpOnly: true,
            sameSite: 'lax',
            secure: false, // set true di balik HTTPS reverse proxy
            maxAge: sessionTtlMs,
            path: '/',
        });
    }

    function clearCookie(res) {
        res.clearCookie(COOKIE_NAME, { path: '/' });
    }

    function readSession(req) {
        const tok = req.cookies?.[COOKIE_NAME];
        return verify(tok, sessionSecret);
    }

    function isApiKeyOk(req) {
        const header = req.headers.authorization || '';
        const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
        const provided = bearer || req.query.key;
        if (!provided) return false;
        return constantTimeEquals(provided, apiKey);
    }

    /** Middleware untuk REST API: terima API key ATAU cookie session. */
    function requireApi(req, res, next) {
        if (isApiKeyOk(req)) return next();
        if (loginEnabled && readSession(req)) return next();
        return res.status(401).json({ status: false, error: 'unauthorized' });
    }

    /** Middleware untuk halaman dashboard/docs: butuh cookie session. */
    function requirePage(req, res, next) {
        if (!loginEnabled) return next();
        if (readSession(req)) return next();
        const target = encodeURIComponent(req.originalUrl || '/');
        return res.redirect(`/login?next=${target}`);
    }

    function tryLogin(username, password) {
        if (!loginEnabled) return false;
        const userOk = constantTimeEquals(username, dashboardUser);
        const passOk = constantTimeEquals(password, dashboardPassword);
        return userOk && passOk;
    }

    return {
        loginEnabled,
        issueCookie,
        clearCookie,
        readSession,
        requireApi,
        requirePage,
        tryLogin,
        COOKIE_NAME,
    };
}

module.exports = { buildAuth };
