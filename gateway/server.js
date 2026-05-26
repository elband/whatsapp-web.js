'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');

const { SessionManager } = require('./src/sessionManager');
const { buildRouter, buildDefaultAliasMiddleware } = require('./src/routes');
const { buildWebhookForwarder } = require('./src/webhook');
const { buildAuth } = require('./src/auth');

const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.API_KEY;
const HEADLESS =
    String(process.env.HEADLESS || 'true').toLowerCase() !== 'false';
const DEFAULT_SESSION_ID = process.env.DEFAULT_SESSION_ID || 'default';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const QUEUE_MIN = parseInt(process.env.QUEUE_MIN_DELAY_MS || '1500', 10);
const QUEUE_MAX = parseInt(process.env.QUEUE_MAX_DELAY_MS || '3500', 10);

const DASHBOARD_USER = process.env.DASHBOARD_USER || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_TTL_HOURS = parseFloat(process.env.SESSION_TTL_HOURS || '12');

if (!API_KEY) {
    console.error(
        'FATAL: API_KEY is not set. Copy .env.example to .env and set a key.',
    );
    process.exit(1);
}

const loginEnabled = Boolean(DASHBOARD_USER && DASHBOARD_PASSWORD);
if (loginEnabled && !SESSION_SECRET) {
    console.error(
        'FATAL: DASHBOARD_USER/PASSWORD set but SESSION_SECRET is empty. Set a long random string.',
    );
    process.exit(1);
}

const auth = buildAuth({
    apiKey: API_KEY,
    dashboardUser: DASHBOARD_USER,
    dashboardPassword: DASHBOARD_PASSWORD,
    sessionSecret: SESSION_SECRET || 'no-login',
    sessionTtlMs: Math.max(1, SESSION_TTL_HOURS) * 3600 * 1000,
});

const onMessage = buildWebhookForwarder({
    url: WEBHOOK_URL,
    secret: WEBHOOK_SECRET,
});

const manager = new SessionManager({
    headless: HEADLESS,
    queueOpts: { minDelay: QUEUE_MIN, maxDelay: QUEUE_MAX },
    onMessage,
});

const app = express();
app.set('defaultSessionId', DEFAULT_SESSION_ID);
app.use(express.json({ limit: '25mb' }));
app.use(cookieParser());

// Public root
app.get('/', (req, res) => {
    res.json({
        name: 'wwebjs-gateway',
        version: '0.3.0',
        defaultSession: DEFAULT_SESSION_ID,
        loginEnabled: auth.loginEnabled,
        endpoints: {
            login: auth.loginEnabled ? '/login' : null,
            docs: '/docs',
            dashboard: '/dashboard',
        },
    });
});

// ---- Login flow ----
app.get('/login', (req, res) => {
    if (!auth.loginEnabled) return res.redirect('/dashboard');
    if (auth.readSession(req)) {
        const next = req.query.next && String(req.query.next);
        return res.redirect(next || '/dashboard');
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
    if (!auth.loginEnabled) {
        return res.status(404).json({ status: false, error: 'login disabled' });
    }
    const { username, password } = req.body || {};
    if (!auth.tryLogin(username, password)) {
        return res
            .status(401)
            .json({ status: false, error: 'invalid credentials' });
    }
    auth.issueCookie(res, username);
    res.json({ status: true });
});

app.post('/logout', (req, res) => {
    auth.clearCookie(res);
    res.json({ status: true });
});

app.get('/whoami', (req, res) => {
    const sess = auth.readSession(req);
    res.json({
        loginEnabled: auth.loginEnabled,
        user: sess?.u || null,
    });
});

// ---- Dashboard (gated by login if enabled) ----
app.get('/dashboard', auth.requirePage, (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html')),
);
app.use(
    '/dashboard',
    auth.requirePage,
    express.static(path.join(__dirname, 'public')),
);

// ---- Swagger UI (gated by login if enabled) ----
const openapiDoc = YAML.load(path.join(__dirname, 'openapi.yaml'));
app.use(
    '/docs',
    auth.requirePage,
    swaggerUi.serve,
    swaggerUi.setup(openapiDoc),
);

// ---- API gate (API key OR cookie session) ----
app.use(auth.requireApi);

// Default-session aliases (must come before /sessions router)
app.use(
    buildDefaultAliasMiddleware({
        getDefaultId: () => DEFAULT_SESSION_ID,
    }),
);

app.use(buildRouter({ manager }));

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error('[server] error:', err);
    res.status(500).json({ status: false, error: err.message });
});

let server;
async function boot() {
    console.log('[boot] restoring sessions from disk');
    await manager.restoreFromDisk(DEFAULT_SESSION_ID);
    server = app.listen(PORT, () => {
        console.log(`[server] listening on http://localhost:${PORT}`);
        console.log(`[server] dashboard: http://localhost:${PORT}/dashboard`);
        console.log(`[server] api docs:  http://localhost:${PORT}/docs`);
        if (auth.loginEnabled) {
            console.log(
                `[server] login enabled. user="${DASHBOARD_USER}" → /login`,
            );
        } else {
            console.log(
                '[server] login disabled. set DASHBOARD_USER + DASHBOARD_PASSWORD + SESSION_SECRET to enable',
            );
        }
    });
}

async function shutdown(sig) {
    console.log(`\n[server] received ${sig}, shutting down...`);
    if (server) server.close(() => console.log('[server] http closed'));
    try {
        await manager.destroyAll();
        console.log('[wa] all sessions destroyed');
    } catch (e) {
        console.warn('[wa] destroy error:', e.message);
    }
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

boot().catch((e) => {
    console.error('[boot] failed:', e);
    process.exit(1);
});
