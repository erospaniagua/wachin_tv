# wachin.tv — roadmap

Everything runs on **Railway**: one Express app + one Postgres. Videos live in a
private **S3 bucket**; the app never makes them public — it hands the browser
short-lived presigned URLs and checks auth before signing them.

## Phase 1 — hosting (done)

- List videos in the bucket (`/api/videos`)
- Stream inline with seeking (`/api/stream`, presigned GET + HTTP Range)
- Download to disk (`/api/download`, presigned GET with attachment disposition)
- Deployable to Railway (`railway.json`, `PORT` from env)

There is already an auth seam: every `/api` route goes through a `requireAuth`
middleware that is currently a no-op. Phase 2 swaps in the real check — no route
rewrites needed.

## Phase 2 — auth (friends & family) — DONE

Built as a small **custom magic-link system** instead of Better Auth. The
requirement is narrow (admin-provisioned users, no self-signup, magic link
only), so hand-rolled auth is more transparent and has no extra framework to
learn — while staying fully secure (hashed tokens, single-use links, hashed
session cookies). Better Auth would have added an opinionated schema + CLI for
features we don't need here.

- Tables in Railway Postgres: `users`, `magic_tokens`, `sessions`
- **Admin-provisioned only** — `npm run user:add -- --email <e> --name "<n>"`.
  No self-signup exists, so the user table _is_ the allowlist.
- **Magic-link login** via Mailtrap SMTP: enter email → one-time link → session.
- Tokens and session cookies are stored **hashed** (SHA-256); links are
  single-use and short-lived (`MAGIC_LINK_TTL_MINUTES`).
- `requireAuth` now gates every `/api` route; unauthenticated → 401, and the
  frontend redirects to `/login.html`.
- Email enumeration is prevented: request-link responds identically for known
  and unknown addresses.

Remaining to go live: set Mailtrap `SMTP_USER`/`SMTP_PASS` in `.env`, set
`APP_URL` to the deployed domain, and create real users.

## Phase 3 — ingest, catalog, player, notifications

Catalog tables are live: `titles`, `episodes`, `media`, `subtitles`, `events`,
`requests` (see `db/002_catalog.sql`).

### Locked design decisions

- **Playback:** standardize everything to **MP4 (H.264 / AAC)** during ingest.
  No on-the-fly transcoding. HLS is a possible future upgrade for true
  multi-audio.
- **Audio/subs:** one default audio track (by language priority) + other
  languages offered as **WebVTT subtitle** tracks.
- **Notifications:** **Telegram bot** pings the admin on downloads and (later)
  requests.
- **Metadata:** **TMDB** enrichment — clean titles, years, posters, episode
  names.
- **Scale:** ~20 users → presigned S3 direct streaming is enough; no CDN yet.

### Standardized S3 layout

```
movies/<slug>/video.mp4 · poster.jpg · subs/<lang>.vtt · meta.json
series/<slug>/s01e01/video.mp4 · subs/<lang>.vtt · meta.json
```

### Ingest pipeline (`npm run ingest -- <folder>`) — local, needs ffmpeg

Probe each file with `ffprobe`, then per the decision table:

| Source | Codecs | Action |
| --- | --- | --- |
| MP4 | H.264 + AAC | upload as-is (faststart remux) |
| MP4 + `.srt` | H.264 + AAC | MP4 direct; `.srt` → `.vtt` (charset → UTF-8) |
| MKV | H.264 + AAC | remux to MP4 (`-c copy`) |
| MKV | HEVC/H.265/VP9 | transcode video → H.264 |
| any | AC3/DTS/EAC3/FLAC | transcode audio → AAC (chosen default track) |
| MKV embedded subs | SRT/ASS | extract → `.vtt` |
| MKV embedded subs | PGS/VobSub (image) | skip (needs OCR) — logged |

Then: match against TMDB, generate `meta.json`, upload to S3, insert catalog
rows. Everything is logged so nothing drops silently.

### Player

- Richer HTML5 player: subtitle track selector, resume position (watch state).
- Catalog browse UI (posters) replacing the raw bucket listing.

### Notifications (Telegram)

- `events` table logs `download` / `request` rows.
- `/api/download` and (later) `/api/requests` insert an event and send a
  Telegram message; `notified_at` guards against double-send.
- Immediate vs daily-digest toggle to keep download pings from getting noisy.

## Transcoding strategy (decided)

- **Backlog (existing drive): transcode locally.** Files are already on disk;
  local **Intel QSV** (`h264_qsv`, ~2–4x realtime) only uploads finished MP4s.
  Cloud would require uploading ~1 TB of originals first + per-minute cost.
- **`transcode-audio` is cheap** (video copied). Only `transcode-video` /
  `transcode-av` (AVIs + HEVC) are the slow, multi-day part.
- **Ingest order:** `copy` → `transcode-audio` first (library online in hours),
  then the heavy video transcodes trickle in over following days.
- **On-demand (Phase 4 agent): AWS Elemental MediaConvert.** The agent runs
  server-side with no GPU, so normalize new torrent downloads via a serverless
  MediaConvert job (S3 in → MP4 + WebVTT out → S3 event → catalog + Telegram).
  Low volume = low cost, zero transcoding infra. (Image subs still need OCR.)

## Phase 4 — torrent agent + collaborative catalog

- Background worker that searches torrents for new movies.
- Users file "add to catalog" **requests** (`requests` table); admin gets a
  Telegram ping and approves.
- Approved items are fetched, normalized via **MediaConvert** (see above), and
  appear in the library automatically.

## Deploying Phase 1 to Railway

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
3. Add these service variables (Settings → Variables):
   - S3: `AWS_REGION`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
     (optional: `S3_PREFIX`, `URL_TTL_SECONDS`)
   - DB: `DATABASE_URL` → reference the Postgres service with
     `${{Postgres.DATABASE_URL}}` (uses the internal, non-proxy host).
   - Auth: `APP_URL` = your Railway public domain (e.g. `https://wachin-tv.up.railway.app`)
   - Email: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`
   - **Do not set `PORT`** — Railway injects it and the app reads it.
4. Deploy. Railway builds with Nixpacks and runs `npm start`.
5. Run the migration once against the DB (locally with `DATABASE_PUBLIC_URL`,
   or via `railway run npm run migrate`), then create users with
   `npm run user:add`.
