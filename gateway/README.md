# wwebjs-gateway

Self-hosted REST API gateway untuk WhatsApp menggunakan
[whatsapp-web.js](../). Pemakaian mirip layanan seperti Fonnte, tapi server
Anda sendiri yang menjalankan sesinya.

Fitur:

- **Login** untuk dashboard & API docs (cookie session HMAC, opsional).
- Multi-akun (sessions). Tiap session = satu akun WhatsApp.
- Antrian per session dengan throttle random anti-ban.
- Scheduled send (`scheduleAt`).
- Webhook pesan masuk.
- OpenAPI/Swagger UI di `/docs`.
- Dashboard sederhana di `/dashboard`.
- Persistensi sesi & antrian otomatis (auto-resume saat restart).

> Tidak afiliasi WhatsApp. Risiko nomor diblokir tetap ada, terutama untuk
> volume tinggi atau spam. Gunakan throttle dan jangan kirim ke nomor yang
> tidak pernah berinteraksi dengan akun Anda.

## Setup

```sh
cd gateway
npm install
copy .env.example .env    # cp di bash
# edit .env minimal: API_KEY
npm start
```

Buka:

- Dashboard: `http://localhost:3000/dashboard`
- API docs: `http://localhost:3000/docs`

Di dashboard, isi API key (disimpan di localStorage). Klik session `default`
dan akan muncul QR untuk discan dari WhatsApp HP (Settings → Linked devices).

## Konsep

- Semua endpoint `/send/*` masuk ke **antrian per session**, lalu worker
  mengirim satu per satu dengan delay acak `QUEUE_MIN_DELAY_MS` ..
  `QUEUE_MAX_DELAY_MS`. Default 1500–3500 ms.
- Antrian disimpan di `gateway/.queue/<sessionId>.json`. Saat restart,
  pekerjaan `pending` otomatis dilanjutkan.
- Sesi WhatsApp disimpan di `gateway/.wwebjs_auth/session-<id>/`.
- Daftar session aktif disimpan di `gateway/.sessions.json`. Saat restart,
  semua session yang pernah dibuat di-restore.

## Auth

Dua jalur auth:

1. **Login dashboard / docs** (cookie session). Aktif kalau `DASHBOARD_USER`
   dan `DASHBOARD_PASSWORD` di-set. Kunjungi `/login` di browser. Setelah
   login, dashboard dan API memakai cookie itu — tidak perlu menempel API
   key di browser.
2. **REST API** lewat header `Authorization: Bearer <API_KEY>` atau query
   `?key=<API_KEY>`. Tetap bekerja meski login dashboard aktif (untuk
   integrasi dari aplikasi lain).

Saat `DASHBOARD_USER` kosong, login dimatikan dan dashboard/docs publik
(akses lokal saja!). REST API tetap butuh API key.

`SESSION_SECRET` harus di-set ke string acak panjang saat login aktif —
ini yang menandatangani cookie session.

## Endpoints utama

Semua di-prefix `/sessions/<id>` kecuali alias datar untuk session default.

### Sessions

- `GET /sessions` — list semua session
- `POST /sessions` — body `{ id }` (a-z0-9\_-, max 40)
- `DELETE /sessions/:id?logout=true|false` — hapus session
- `GET /sessions/:id/health` — status + statistik queue
- `GET /sessions/:id/qr` — render PNG QR
- `GET /sessions/:id/qr.txt` — string QR mentah
- `POST /sessions/:id/logout`

### Pesan

- `POST /sessions/:id/send/text` — `{ target, message, scheduleAt? }`
- `POST /sessions/:id/send/media` — `{ target, fileUrl|base64+mimetype, caption?, asDocument?, asVoice?, asSticker?, scheduleAt? }`
- `POST /sessions/:id/send/location` — `{ target, latitude, longitude, name?, address?, scheduleAt? }`
- `GET  /sessions/:id/check?target=...` — cek nomor terdaftar
- `GET  /sessions/:id/chats` — 50 chat terbaru

### Queue

- `GET /sessions/:id/queue?status=pending&limit=100`
- `GET /sessions/:id/queue/:jobId`
- `DELETE /sessions/:id/queue/:jobId` — cancel pending job
- `POST /sessions/:id/queue/purge` — buang sent + failed

### Alias session default

Untuk klien lama, endpoint berikut otomatis diarahkan ke session
`DEFAULT_SESSION_ID`:
`/health`, `/check`, `/chats`, `/session/qr`, `/session/qr.txt`,
`/session/logout`, `/send/text`, `/send/media`, `/send/location`, `/queue`.

## Webhook pesan masuk

Set `WEBHOOK_URL` di `.env`. Setiap pesan masuk akan di-`POST` JSON ke URL
itu, dengan optional header `X-Webhook-Secret`. Payload contoh:

```json
{
    "sessionId": "default",
    "id": "true_628...@c.us_3EB0...",
    "from": "628...@c.us",
    "to": "628...@c.us",
    "fromMe": false,
    "isGroup": false,
    "chatName": "Halo",
    "body": "ping",
    "type": "chat",
    "timestamp": 1737000000,
    "hasMedia": false
}
```

## Contoh request

```sh
# kirim teks ke session default
curl -X POST http://localhost:3000/send/text ^
  -H "Authorization: Bearer <API_KEY>" ^
  -H "Content-Type: application/json" ^
  -d "{\"target\":\"628123456789\",\"message\":\"hai\"}"

# kirim ke session khusus
curl -X POST http://localhost:3000/sessions/account-a/send/text ^
  -H "Authorization: Bearer <API_KEY>" ^
  -H "Content-Type: application/json" ^
  -d "{\"target\":\"628xxx\",\"message\":\"halo\"}"

# scheduled (UTC ISO)
curl -X POST http://localhost:3000/send/text ^
  -H "Authorization: Bearer <API_KEY>" ^
  -H "Content-Type: application/json" ^
  -d "{\"target\":\"628xxx\",\"message\":\"besok pagi\",\"scheduleAt\":\"2026-05-25T01:00:00Z\"}"
```

## Multi-akun

Buat session baru via dashboard atau:

```sh
curl -X POST http://localhost:3000/sessions ^
  -H "Authorization: Bearer <API_KEY>" ^
  -H "Content-Type: application/json" ^
  -d "{\"id\":\"account-a\"}"
```

Lalu scan QR di `/sessions/account-a/qr`. Tiap session punya antrian
sendiri dan dapat dikirim secara paralel.

## Catatan operasional

- Untuk produksi, jalankan dengan PM2/Docker dan cadangkan folder
  `.wwebjs_auth/` (kredensial sesi) + `.queue/`.
- Throttle default cocok untuk volume sedang. Naikkan saat broadcast besar.
- Untuk sinkronisasi sesi antar host, ganti `LocalAuth` ke `RemoteAuth`
  (MongoDB/S3) di `src/sessionManager.js`.
