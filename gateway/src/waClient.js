'use strict';

const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('../..');

/**
 * Membuat dan menginisialisasi WhatsApp client (whatsapp-web.js).
 * Mengembalikan handle berisi client + state runtime (qr, ready, dll).
 */
function createWaClient({ clientId = 'default', headless = true } = {}) {
    const state = {
        ready: false,
        authenticated: false,
        qr: null, // string QR terbaru (untuk dirender ke PNG/terminal)
        lastQrAt: null,
        info: null, // info user setelah ready
        startedAt: new Date(),
        lastDisconnectReason: null,
    };

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId,
            dataPath: path.resolve(__dirname, '..', '.wwebjs_auth'),
        }),
        puppeteer: {
            headless,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
            ],
        },
    });

    client.on('qr', (qr) => {
        state.qr = qr;
        state.lastQrAt = new Date();
        state.authenticated = false;
        state.ready = false;
        console.log('[wa] QR received. Scan via GET /session/qr');
    });

    client.on('authenticated', () => {
        state.authenticated = true;
        state.qr = null;
        console.log('[wa] authenticated');
    });

    client.on('auth_failure', (msg) => {
        state.authenticated = false;
        state.ready = false;
        console.error('[wa] auth failure:', msg);
    });

    client.on('ready', () => {
        state.ready = true;
        state.authenticated = true;
        state.qr = null;
        state.info = client.info
            ? {
                  pushname: client.info.pushname,
                  wid: client.info.wid?._serialized,
                  platform: client.info.platform,
              }
            : null;
        console.log('[wa] ready as', state.info?.wid);
    });

    client.on('disconnected', (reason) => {
        state.ready = false;
        state.authenticated = false;
        state.lastDisconnectReason = reason;
        console.warn('[wa] disconnected:', reason);
    });

    client.on('change_state', (s) => {
        console.log('[wa] state:', s);
    });

    client.initialize().catch((err) => {
        console.error('[wa] initialize failed:', err);
    });

    return { client, state, MessageMedia };
}

module.exports = { createWaClient };
