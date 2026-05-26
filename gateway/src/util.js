'use strict';

function toChatId(target) {
    if (!target) return null;
    const t = String(target).trim();
    if (t.includes('@')) return t;
    const digits = t.replace(/[^\d]/g, '');
    if (!digits) return null;
    return `${digits}@c.us`;
}

function randInt(min, max) {
    min = Math.floor(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function genId(prefix = 'job') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
}

module.exports = { toChatId, randInt, sleep, genId };
