import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { authRouter, requireAuth, requireAdmin, issueMagicLink } from './auth.js';
import { pool } from './db/pool.js';
import { notify } from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  AWS_REGION = 'us-east-1',
  S3_BUCKET,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  URL_TTL_SECONDS = '3600',
  PORT = '3000',
} = process.env;

if (!S3_BUCKET) {
  console.error('Missing S3_BUCKET. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const credentials =
  AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
    ? { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY }
    : undefined;

const s3 = new S3Client({ region: AWS_REGION, credentials });
const ttl = Math.max(60, parseInt(URL_TTL_SECONDS, 10) || 3600);

const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Presign a GET for a trusted key that came from our own catalog DB.
function signKey(key, { download = false, filename } = {}) {
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ...(download && {
      ResponseContentDisposition: `attachment; filename="${filename || path.basename(key)}"`,
    }),
  });
  return getSignedUrl(s3, command, { expiresIn: ttl });
}

const app = express();
app.set('trust proxy', 1); // Railway terminates TLS at a proxy; needed for secure cookies
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Magic-link auth: /api/auth/request-link, /verify, /me, /logout.
app.use('/api/auth', authRouter);

// Everything below requires a valid session (admin-provisioned users only).

// Catalog: every movie + series that has at least one playable media file.
app.get('/api/titles', requireAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      select t.slug, t.kind, t.name, t.year, t.poster_key,
        (select count(*)::int from episodes e
           join media m on m.episode_id = e.id
          where e.series_id = t.id) as episodes
      from titles t
      where exists (select 1 from media m where m.title_id = t.id)
         or exists (select 1 from episodes e join media m on m.episode_id = e.id where e.series_id = t.id)
      order by t.name`);
    res.json({ titles: rows });
  } catch (err) {
    console.error('titles list failed:', err);
    res.status(500).json({ error: 'Could not load catalog.' });
  }
});

// Title detail: a movie's media, or a series' episode list.
app.get('/api/titles/:slug', requireAuth, async (req, res) => {
  try {
    const { rows: [t] } = await pool.query('select * from titles where slug = $1', [req.params.slug]);
    if (!t) return res.status(404).json({ error: 'Not found.' });

    if (t.kind === 'movie') {
      const { rows: [m] } = await pool.query(
        'select id, duration_sec, width, height from media where title_id = $1 order by created_at limit 1',
        [t.id],
      );
      return res.json({ title: t, media: m || null });
    }

    const { rows: episodes } = await pool.query(`
      select e.season, e.episode, e.name, m.id as media_id, m.duration_sec
      from episodes e join media m on m.episode_id = e.id
      where e.series_id = $1 order by e.season, e.episode`, [t.id]);
    res.json({ title: t, episodes });
  } catch (err) {
    console.error('title detail failed:', err);
    res.status(500).json({ error: 'Could not load title.' });
  }
});

// Playback URL for a media item + its subtitle tracks (all presigned).
app.get('/api/media/:id/play', requireAuth, async (req, res) => {
  try {
    const { rows: [m] } = await pool.query('select id, s3_key from media where id = $1', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Not found.' });
    const url = await signKey(m.s3_key);
    const { rows: subs } = await pool.query(
      'select lang, label, s3_key from subtitles where media_id = $1 order by lang', [m.id]);
    const subtitles = await Promise.all(
      subs.map(async (s) => ({ lang: s.lang, label: s.label, url: await signKey(s.s3_key) })));
    res.json({ url, subtitles });
  } catch (err) {
    if (err.code === '22P02') return res.status(400).json({ error: 'Bad id.' }); // invalid uuid
    console.error('play failed:', err);
    res.status(500).json({ error: 'Could not start playback.' });
  }
});

// Download URL — logs an event and pings the admin on Telegram.
app.get('/api/media/:id/download', requireAuth, async (req, res) => {
  try {
    const { rows: [m] } = await pool.query(`
      select m.id, m.s3_key, coalesce(mt.name, st.name) as title, e.season, e.episode
      from media m
      left join titles mt on mt.id = m.title_id
      left join episodes e on e.id = m.episode_id
      left join titles st on st.id = e.series_id
      where m.id = $1`, [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Not found.' });

    const label = m.season != null
      ? `${m.title} S${String(m.season).padStart(2, '0')}E${String(m.episode).padStart(2, '0')}`
      : m.title;
    const filename = label.replace(/[^\w .-]/g, '').trim() + '.mp4';
    const url = await signKey(m.s3_key, { download: true, filename });

    pool.query('insert into events (user_id, type, media_id, detail) values ($1, $2, $3, $4)',
      [req.user.id, 'download', m.id, { title: label }]).catch((e) => console.error('event log failed', e));
    notify(`⬇️ <b>${esc(req.user.name)}</b> downloaded <b>${esc(label)}</b>`);

    res.json({ url });
  } catch (err) {
    if (err.code === '22P02') return res.status(400).json({ error: 'Bad id.' });
    console.error('download failed:', err);
    res.status(500).json({ error: 'Could not create download URL.' });
  }
});

// --- admin: user management (admins only) ---
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

app.get('/api/admin/users', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query('select id, email, name, role, created_at from users order by created_at');
    res.json({ users: rows });
  } catch (err) {
    console.error('list users failed:', err);
    res.status(500).json({ error: 'Could not load users.' });
  }
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim();
  const role = req.body?.role === 'admin' ? 'admin' : 'user';
  const invite = req.body?.invite === true;

  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required.' });

  try {
    const { rows } = await pool.query(
      `insert into users (email, name, role) values ($1, $2, $3)
       on conflict (email) do update set name = excluded.name, role = excluded.role
       returning id, email, name, role, created_at`,
      [email, name, role],
    );
    let invited = false;
    if (invite) invited = await issueMagicLink(email).catch(() => false);
    res.json({ user: rows[0], invited });
  } catch (err) {
    console.error('create user failed:', err);
    res.status(500).json({ error: 'Could not create user.' });
  }
});

app.post('/api/admin/users/:id/invite', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows: [u] } = await pool.query('select email from users where id = $1', [req.params.id]);
    if (!u) return res.status(404).json({ error: 'Not found.' });
    await issueMagicLink(u.email);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '22P02') return res.status(400).json({ error: 'Bad id.' });
    console.error('invite failed:', err);
    res.status(500).json({ error: 'Could not send invite.' });
  }
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't remove yourself." });
  try {
    const r = await pool.query('delete from users where id = $1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found.' });
    res.json({ deleted: r.rowCount });
  } catch (err) {
    if (err.code === '22P02') return res.status(400).json({ error: 'Bad id.' });
    console.error('delete user failed:', err);
    res.status(500).json({ error: 'Could not remove user.' });
  }
});

app.listen(parseInt(PORT, 10), () => {
  console.log(`wachin.tv running at http://localhost:${PORT}`);
  console.log(`Catalog-backed streaming from bucket "${S3_BUCKET}" (region ${AWS_REGION})`);
});
