'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Persistensi simpel berbasis JSON (cukup untuk single-host).
 * Menyimpan daftar sesi dan antrian pending agar auto-resume saat restart.
 */
const ROOT = path.resolve(__dirname, '..');
const SESSIONS_FILE = path.join(ROOT, '.sessions.json');
const QUEUE_DIR = path.join(ROOT, '.queue');

function ensureQueueDir() {
    if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

function loadSessions() {
    try {
        const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function saveSessions(list) {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list, null, 2));
}

function queueFile(sessionId) {
    ensureQueueDir();
    return path.join(QUEUE_DIR, `${sessionId}.json`);
}

function loadQueue(sessionId) {
    try {
        const raw = fs.readFileSync(queueFile(sessionId), 'utf8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function saveQueue(sessionId, jobs) {
    ensureQueueDir();
    fs.writeFileSync(queueFile(sessionId), JSON.stringify(jobs, null, 2));
}

function dropQueue(sessionId) {
    try {
        fs.unlinkSync(queueFile(sessionId));
    } catch {
        /* ignore */
    }
}

module.exports = {
    loadSessions,
    saveSessions,
    loadQueue,
    saveQueue,
    dropQueue,
};
