'use strict';

const path = require('path');
const { Client, LocalAuth } = require('../..');
const store = require('./store');
const { Queue } = require('./queue');

class Session {
    constructor({ id, headless, queueOpts, onMessage }) {
        this.id = id;
        this.headless = headless;
        this.onMessage = onMessage; // callback(sessionId, msg)
        this.state = {
            id,
            ready: false,
            authenticated: false,
            qr: null,
            lastQrAt: null,
            startedAt: new Date().toISOString(),
            info: null,
            lastDisconnectReason: null,
        };

        this.client = new Client({
            authStrategy: new LocalAuth({
                clientId: id,
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

        this.queue = new Queue({
            sessionId: id,
            getClient: () => this.client,
            getReady: () => this.state.ready,
            minDelay: queueOpts.minDelay,
            maxDelay: queueOpts.maxDelay,
        });

        this.bindEvents();
    }

    bindEvents() {
        const s = this.state;
        this.client.on('qr', (qr) => {
            s.qr = qr;
            s.lastQrAt = new Date().toISOString();
            s.authenticated = false;
            s.ready = false;
            console.log(`[${this.id}] QR received`);
        });
        this.client.on('authenticated', () => {
            s.authenticated = true;
            s.qr = null;
            console.log(`[${this.id}] authenticated`);
        });
        this.client.on('auth_failure', (msg) => {
            s.authenticated = false;
            s.ready = false;
            console.warn(`[${this.id}] auth_failure:`, msg);
        });
        this.client.on('ready', () => {
            s.ready = true;
            s.authenticated = true;
            s.qr = null;
            s.info = this.client.info
                ? {
                      pushname: this.client.info.pushname,
                      wid: this.client.info.wid?._serialized,
                      platform: this.client.info.platform,
                  }
                : null;
            console.log(`[${this.id}] ready as`, s.info?.wid);
            this.queue.start();
        });
        this.client.on('disconnected', (reason) => {
            s.ready = false;
            s.authenticated = false;
            s.lastDisconnectReason = String(reason);
            console.warn(`[${this.id}] disconnected:`, reason);
        });
        this.client.on('change_state', (st) => {
            console.log(`[${this.id}] state:`, st);
        });
        this.client.on('message', (msg) => {
            try {
                this.onMessage?.(this.id, msg);
            } catch (e) {
                console.warn(`[${this.id}] onMessage error:`, e.message);
            }
        });
    }

    async init() {
        try {
            await this.client.initialize();
        } catch (e) {
            console.error(`[${this.id}] initialize error:`, e.message);
        }
    }

    async destroy({ logout = false } = {}) {
        await this.queue.stop();
        try {
            if (logout) await this.client.logout();
        } catch (e) {
            console.warn(`[${this.id}] logout error:`, e.message);
        }
        try {
            await this.client.destroy();
        } catch (e) {
            console.warn(`[${this.id}] destroy error:`, e.message);
        }
    }
}

class SessionManager {
    constructor({ headless, queueOpts, onMessage }) {
        this.headless = headless;
        this.queueOpts = queueOpts;
        this.onMessage = onMessage;
        this.sessions = new Map();
    }

    list() {
        return [...this.sessions.values()].map((s) => ({
            ...s.state,
            queue: s.queue.stats(),
        }));
    }

    get(id) {
        return this.sessions.get(id) || null;
    }

    async create(id) {
        if (this.sessions.has(id)) return this.sessions.get(id);
        const session = new Session({
            id,
            headless: this.headless,
            queueOpts: this.queueOpts,
            onMessage: this.onMessage,
        });
        this.sessions.set(id, session);
        await session.init();
        this.persist();
        return session;
    }

    async remove(id, { logout = false } = {}) {
        const s = this.sessions.get(id);
        if (!s) return false;
        await s.destroy({ logout });
        this.sessions.delete(id);
        store.dropQueue(id);
        this.persist();
        return true;
    }

    persist() {
        store.saveSessions([...this.sessions.keys()]);
    }

    async restoreFromDisk(defaultId) {
        const ids = store.loadSessions();
        if (!ids.includes(defaultId)) ids.push(defaultId);
        for (const id of ids) {
            // create akan async-init; jangan tunggu paralel agar tidak overload Chromium
            // tapi cukup launch saja, tidak perlu await ready

            await this.create(id);
        }
    }

    async destroyAll() {
        for (const s of this.sessions.values()) {
            await s.destroy();
        }
        this.sessions.clear();
    }
}

module.exports = { SessionManager };
