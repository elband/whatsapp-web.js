'use strict';

const { Location, MessageMedia } = require('../..');
const { randInt, genId } = require('./util');
const store = require('./store');

/**
 * Job shape:
 * {
 *   id, type: 'text' | 'media' | 'location',
 *   target, payload, status: 'pending' | 'sending' | 'sent' | 'failed',
 *   scheduledAt: ISO | null,
 *   createdAt: ISO,
 *   sentAt: ISO | null,
 *   error: string | null,
 *   result: { id, to } | null,
 *   tries: number,
 * }
 */

class Queue {
    constructor({ sessionId, getClient, getReady, minDelay, maxDelay }) {
        this.sessionId = sessionId;
        this.getClient = getClient;
        this.getReady = getReady;
        this.minDelay = minDelay;
        this.maxDelay = maxDelay;
        this.jobs = store.loadQueue(sessionId);
        this.running = false;
        this.stopped = false;
        this.tickHandle = null;
    }

    persist() {
        store.saveQueue(this.sessionId, this.jobs);
    }

    list({ status, limit = 100 } = {}) {
        let items = this.jobs;
        if (status) items = items.filter((j) => j.status === status);
        return items.slice(-limit).reverse();
    }

    get(id) {
        return this.jobs.find((j) => j.id === id) || null;
    }

    enqueue(spec) {
        const job = {
            id: genId('job'),
            type: spec.type,
            target: spec.target,
            payload: spec.payload || {},
            status: 'pending',
            scheduledAt: spec.scheduledAt || null,
            createdAt: new Date().toISOString(),
            sentAt: null,
            error: null,
            result: null,
            tries: 0,
        };
        this.jobs.push(job);
        this.persist();
        this.kick();
        return job;
    }

    cancel(id) {
        const job = this.get(id);
        if (!job) return false;
        if (job.status !== 'pending') return false;
        job.status = 'failed';
        job.error = 'cancelled';
        this.persist();
        return true;
    }

    async start() {
        if (this.running) return;
        this.running = true;
        this.stopped = false;
        // Jadwalkan pick berikutnya secara longgar
        this.kick();
    }

    async stop() {
        this.stopped = true;
        this.running = false;
        if (this.tickHandle) clearTimeout(this.tickHandle);
    }

    kick() {
        if (this.stopped) return;
        if (this.tickHandle) clearTimeout(this.tickHandle);
        this.tickHandle = setTimeout(() => this.tick(), 250);
    }

    async tick() {
        if (this.stopped) return;
        if (!this.getReady()) {
            // Klien belum siap, coba lagi nanti
            this.tickHandle = setTimeout(() => this.tick(), 2000);
            return;
        }
        const now = Date.now();
        const job = this.jobs.find(
            (j) =>
                j.status === 'pending' &&
                (!j.scheduledAt || new Date(j.scheduledAt).getTime() <= now),
        );
        if (!job) {
            // Tidak ada yang bisa diproses sekarang. Cek lagi 1 detik.
            this.tickHandle = setTimeout(() => this.tick(), 1000);
            return;
        }
        await this.process(job);
        // Throttle anti-ban
        const delay = randInt(this.minDelay, this.maxDelay);
        this.tickHandle = setTimeout(() => this.tick(), delay);
    }

    async process(job) {
        job.status = 'sending';
        job.tries += 1;
        this.persist();

        try {
            const client = this.getClient();
            const sent = await this.send(client, job);
            job.status = 'sent';
            job.result = { id: sent.id?._serialized, to: job.target };
            job.sentAt = new Date().toISOString();
            this.persist();
        } catch (e) {
            job.status = 'failed';
            job.error = e.message || String(e);
            this.persist();
        }
    }

    async send(client, job) {
        const { target, type, payload } = job;
        if (type === 'text') {
            return client.sendMessage(target, String(payload.message || ''));
        }
        if (type === 'media') {
            let media;
            if (payload.fileUrl) {
                media = await MessageMedia.fromUrl(payload.fileUrl, {
                    unsafeMime: true,
                    filename: payload.filename || undefined,
                });
            } else if (payload.base64 && payload.mimetype) {
                media = new MessageMedia(
                    payload.mimetype,
                    payload.base64,
                    payload.filename || null,
                );
            } else {
                throw new Error(
                    'media payload requires fileUrl or base64+mimetype',
                );
            }
            const opts = {};
            if (payload.caption) opts.caption = String(payload.caption);
            if (payload.asDocument) opts.sendMediaAsDocument = true;
            if (payload.asVoice) opts.sendAudioAsVoice = true;
            if (payload.asSticker) opts.sendMediaAsSticker = true;
            return client.sendMessage(target, media, opts);
        }
        if (type === 'location') {
            const { latitude, longitude, name, address } = payload;
            const loc = new Location(Number(latitude), Number(longitude), {
                name,
                address,
            });
            return client.sendMessage(target, loc);
        }
        throw new Error(`unknown job type: ${type}`);
    }

    stats() {
        const counts = { pending: 0, sending: 0, sent: 0, failed: 0 };
        for (const j of this.jobs)
            counts[j.status] = (counts[j.status] || 0) + 1;
        return { total: this.jobs.length, ...counts };
    }

    purgeFinished() {
        const before = this.jobs.length;
        this.jobs = this.jobs.filter(
            (j) => j.status === 'pending' || j.status === 'sending',
        );
        this.persist();
        return before - this.jobs.length;
    }
}

module.exports = { Queue };
