'use strict';

const express = require('express');
const QRCode = require('qrcode');
const { toChatId } = require('./util');

function getSession(req, manager) {
    const sid = req.params.sessionId;
    const session = manager.get(sid);
    if (!session) {
        return {
            error: {
                status: 404,
                body: { status: false, error: 'session not found' },
            },
        };
    }
    return { session };
}

function requireReady(session) {
    if (!session.state.ready) {
        return {
            status: 503,
            body: {
                status: false,
                error: 'session not ready yet',
                ready: session.state.ready,
                authenticated: session.state.authenticated,
                hasQr: Boolean(session.state.qr),
            },
        };
    }
    return null;
}

function buildRouter({ manager }) {
    const router = express.Router();

    // ---- Sessions management ----
    router.get('/sessions', (req, res) => {
        res.json({ status: true, sessions: manager.list() });
    });

    router.post('/sessions', async (req, res) => {
        const { id } = req.body || {};
        if (!id || !/^[a-zA-Z0-9_-]{1,40}$/.test(id)) {
            return res.status(400).json({
                status: false,
                error: 'id must match /^[a-zA-Z0-9_-]{1,40}$/',
            });
        }
        const session = await manager.create(id);
        res.json({ status: true, session: session.state });
    });

    router.delete('/sessions/:sessionId', async (req, res) => {
        const logout = String(req.query.logout || '').toLowerCase() === 'true';
        const ok = await manager.remove(req.params.sessionId, { logout });
        if (!ok)
            return res
                .status(404)
                .json({ status: false, error: 'session not found' });
        res.json({ status: true });
    });

    // ---- Session detail / QR / health ----
    router.get('/sessions/:sessionId/health', (req, res) => {
        const { session, error } = getSession(req, manager);
        if (error) return res.status(error.status).json(error.body);
        res.json({
            status: true,
            ...session.state,
            queue: session.queue.stats(),
        });
    });

    router.get('/sessions/:sessionId/qr', async (req, res) => {
        const { session, error } = getSession(req, manager);
        if (error) return res.status(error.status).json(error.body);
        if (session.state.ready) {
            return res
                .status(409)
                .json({ status: false, error: 'already authenticated' });
        }
        if (!session.state.qr) {
            return res
                .status(404)
                .json({ status: false, error: 'no QR available yet' });
        }
        try {
            const png = await QRCode.toBuffer(session.state.qr, {
                width: 320,
                margin: 1,
            });
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'no-store');
            res.send(png);
        } catch (e) {
            res.status(500).json({ status: false, error: e.message });
        }
    });

    router.get('/sessions/:sessionId/qr.txt', (req, res) => {
        const { session, error } = getSession(req, manager);
        if (error) return res.status(error.status).json(error.body);
        if (!session.state.qr) {
            return res
                .status(404)
                .json({ status: false, error: 'no QR available' });
        }
        res.json({
            status: true,
            qr: session.state.qr,
            lastQrAt: session.state.lastQrAt,
        });
    });

    router.post('/sessions/:sessionId/logout', async (req, res) => {
        const { session, error } = getSession(req, manager);
        if (error) return res.status(error.status).json(error.body);
        try {
            await session.client.logout();
            session.state.ready = false;
            session.state.authenticated = false;
            res.json({ status: true });
        } catch (e) {
            res.status(500).json({ status: false, error: e.message });
        }
    });

    // ---- Aksi WhatsApp di sesi ----
    router.get('/sessions/:sessionId/check', async (req, res) => {
        const { session, error } = getSession(req, manager);
        if (error) return res.status(error.status).json(error.body);
        const notReady = requireReady(session);
        if (notReady) return res.status(notReady.status).json(notReady.body);
        const target = req.query.target;
        if (!target)
            return res
                .status(400)
                .json({ status: false, error: 'target is required' });
        try {
            const numberId = await session.client.getNumberId(String(target));
            res.json({
                status: true,
                registered: Boolean(numberId),
                chatId: numberId ? numberId._serialized : null,
            });
        } catch (e) {
            res.status(500).json({ status: false, error: e.message });
        }
    });

    router.get('/sessions/:sessionId/chats', async (req, res) => {
        const { session, error } = getSession(req, manager);
        if (error) return res.status(error.status).json(error.body);
        const notReady = requireReady(session);
        if (notReady) return res.status(notReady.status).json(notReady.body);
        try {
            const chats = await session.client.getChats();
            res.json({
                status: true,
                count: chats.length,
                chats: chats.slice(0, 50).map((c) => ({
                    id: c.id._serialized,
                    name: c.name,
                    isGroup: c.isGroup,
                    unread: c.unreadCount,
                    timestamp: c.timestamp,
                })),
            });
        } catch (e) {
            res.status(500).json({ status: false, error: e.message });
        }
    });

    // ---- Send via queue (default behavior) ----
    function enqueueSend(session, body, type) {
        const target = toChatId(body.target);
        if (!target) return { error: 'target is required' };
        const job = session.queue.enqueue({
            type,
            target,
            payload: body,
            scheduledAt: body.scheduleAt || null,
        });
        return { job };
    }

    router.post('/sessions/:sessionId/send/text', (req, res) => {
        const { session, error } = getSession(req, manager);
        if (error) return res.status(error.status).json(error.body);
        const body = req.body || {};
        if (!body.message)
            return res
                .status(400)
                .json({ status: false, error: 'message is required' });
        const r = enqueueSend(session, body, 'text');
        if (r.error)
            return res.status(400).json({ status: false, error: r.error });
        res.json({ status: true, job: r.job });
    });

    router.post('/sessions/:sessionId/send/media', (req, res) => {
        const { session, error } = getSession(req, manager);
        if (error) return res.status(error.status).json(error.body);
        const body = req.body || {};
        if (!body.fileUrl && !(body.base64 && body.mimetype)) {
            return res.status(400).json({
                status: false,
                error: 'fileUrl or (base64+mimetype) is required',
            });
        }
        const r = enqueueSend(session, body, 'media');
        if (r.error)
            return res.status(400).json({ status: false, error: r.error });
        res.json({ status: true, job: r.job });
    });

    router.post('/sessions/:sessionId/send/location', (req, res) => {
        const { session, error } = getSession(req, manager);
        if (error) return res.status(error.status).json(error.body);
        const body = req.body || {};
        if (body.latitude == null || body.longitude == null) {
            return res.status(400).json({
                status: false,
                error: 'latitude and longitude required',
            });
        }
        const r = enqueueSend(session, body, 'location');
        if (r.error)
            return res.status(400).json({ status: false, error: r.error });
        res.json({ status: true, job: r.job });
    });

    // ---- Queue inspection ----
    router.get('/sessions/:sessionId/queue', (req, res) => {
        const { session, error } = getSession(req, manager);
        if (error) return res.status(error.status).json(error.body);
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
        const status = req.query.status || null;
        res.json({
            status: true,
            stats: session.queue.stats(),
            jobs: session.queue.list({ status, limit }),
        });
    });

    router.get('/sessions/:sessionId/queue/:jobId', (req, res) => {
        const { session, error } = getSession(req, manager);
        if (error) return res.status(error.status).json(error.body);
        const job = session.queue.get(req.params.jobId);
        if (!job)
            return res
                .status(404)
                .json({ status: false, error: 'job not found' });
        res.json({ status: true, job });
    });

    router.delete('/sessions/:sessionId/queue/:jobId', (req, res) => {
        const { session, error } = getSession(req, manager);
        if (error) return res.status(error.status).json(error.body);
        const ok = session.queue.cancel(req.params.jobId);
        if (!ok)
            return res
                .status(409)
                .json({ status: false, error: 'job not pending or not found' });
        res.json({ status: true });
    });

    router.post('/sessions/:sessionId/queue/purge', (req, res) => {
        const { session, error } = getSession(req, manager);
        if (error) return res.status(error.status).json(error.body);
        const removed = session.queue.purgeFinished();
        res.json({ status: true, removed });
    });

    return router;
}

/**
 * Alias datar untuk default session, agar kompatibel dengan klien lama:
 *   /health, /send/text, /send/media, /send/location, /check, /chats, /session/qr, ...
 * Implementasinya: rewrite req.url ke /sessions/:default/...
 */
function buildDefaultAliasMiddleware({ getDefaultId }) {
    const map = [
        ['/health', '/health'],
        ['/check', '/check'],
        ['/chats', '/chats'],
        ['/session/qr', '/qr'],
        ['/session/qr.txt', '/qr.txt'],
        ['/session/logout', '/logout'],
        ['/send/text', '/send/text'],
        ['/send/media', '/send/media'],
        ['/send/location', '/send/location'],
        ['/queue', '/queue'],
    ];
    return (req, res, next) => {
        const path = req.path;
        for (const [from, to] of map) {
            if (path === from) {
                const id = getDefaultId();
                if (!id) return next();
                req.url = req.url.replace(from, `/sessions/${id}${to}`);
                return next();
            }
        }
        next();
    };
}

module.exports = { buildRouter, buildDefaultAliasMiddleware };
