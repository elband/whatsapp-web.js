'use strict';

/**
 * Membangun handler global yang dipakai oleh SessionManager.onMessage
 * untuk forward pesan masuk ke WEBHOOK_URL.
 */
function buildWebhookForwarder({ url, secret }) {
    if (!url) {
        return async () => {};
    }
    return async (sessionId, msg) => {
        try {
            const chat = await msg.getChat().catch(() => null);
            const payload = {
                sessionId,
                id: msg.id?._serialized,
                from: msg.from,
                to: msg.to,
                author: msg.author || null,
                fromMe: msg.fromMe,
                isGroup: chat?.isGroup ?? false,
                chatName: chat?.name || null,
                body: msg.body,
                type: msg.type,
                timestamp: msg.timestamp,
                hasMedia: msg.hasMedia,
                mediaMimetype: msg._data?.mimetype || null,
                mediaFilename: msg._data?.filename || null,
            };
            const headers = { 'Content-Type': 'application/json' };
            if (secret) headers['X-Webhook-Secret'] = secret;
            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
            });
            if (!res.ok) console.warn('[webhook] non-2xx:', res.status);
        } catch (e) {
            console.warn('[webhook] forward error:', e.message);
        }
    };
}

module.exports = { buildWebhookForwarder };
