import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, statSync } from 'node:fs';
import { authRouter, requireAuth, requireAdmin, issueMagicLink } from './auth.js';
import { pool } from './db/pool.js';
import { notify } from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { MEDIA_ROOT, PORT = '3000' } = process.env;

if (!MEDIA_ROOT) {
  console.warn('Warning: MEDIA_ROOT not set — video streaming will 500 until you set it in .env.');
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Resolve a catalog key to an absolute path, refusing anything that escapes
// MEDIA_ROOT (defense-in-depth; keys come from our own DB).
function mediaPath(key) {
  const root = path.resolve(MEDIA_ROOT || '.');
  const full = path.resolve(root, key);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

// Stream a local file with HTTP Range support (so the player can seek).
function streamFile(req, res, filePath, contentType, { download, filename } = {}) {
  let stat;
  try { stat = statSync(filePath); } catch { return res.status(404).json({ error: 'File not found.' }); }
  const total = stat.size;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  if (download) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;
    if (start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${total}`);
      return res.end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', end - start + 1);
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.status(200);
    res.setHeader('Content-Length', total);
    createReadStream(filePath).pipe(res);
  }
}

const app = express();
app.set('trust proxy', 1); // behind Cloudflare Tunnel / a proxy → needed for secure cookies
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

// Playback info: the stream URL + subtitle track URLs (all same-origin routes).
app.get('/api/media/:id/play', requireAuth, async (req, res) => {
  try {
    const { rows: [m] } = await pool.query('select id from media where id = $1', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Not found.' });
    const { rows: subs } = await pool.query(
      'select lang, label from subtitles where media_id = $1 order by lang', [m.id]);
    res.json({
      url: `/api/media/${m.id}/stream`,
      subtitles: subs.map((s) => ({ lang: s.lang, label: s.label, url: `/api/media/${m.id}/subs/${s.lang}` })),
    });
  } catch (err) {
    if (err.code === '22P02') return res.status(400).json({ error: 'Bad id.' });
    console.error('play failed:', err);
    res.status(500).json({ error: 'Could not start playback.' });
  }
});

// Stream the video from local disk.
app.get('/api/media/:id/stream', requireAuth, async (req, res) => {
  try {
    const { rows: [m] } = await pool.query('select s3_key from media where id = $1', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Not found.' });
    const fp = mediaPath(m.s3_key);
    if (!fp) return res.status(400).json({ error: 'Bad path.' });
    streamFile(req, res, fp, 'video/mp4');
  } catch (err) {
    if (err.code === '22P02') return res.status(400).json({ error: 'Bad id.' });
    console.error('stream failed:', err);
    res.status(500).json({ error: 'Could not stream.' });
  }
});

// Serve a subtitle track (WebVTT) from local disk.
app.get('/api/media/:id/subs/:lang', requireAuth, async (req, res) => {
  try {
    const { rows: [s] } = await pool.query(
      'select s3_key from subtitles where media_id = $1 and lang = $2', [req.params.id, req.params.lang]);
    if (!s) return res.status(404).json({ error: 'Not found.' });
    const fp = mediaPath(s.s3_key);
    if (!fp) return res.status(400).json({ error: 'Bad path.' });
    streamFile(req, res, fp, 'text/vtt; charset=utf-8');
  } catch (err) {
    if (err.code === '22P02') return res.status(400).json({ error: 'Bad id.' });
    console.error('subs failed:', err);
    res.status(500).json({ error: 'Could not load subtitles.' });
  }
});

// Download — streams as an attachment, logs an event, pings the admin.
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
    const fp = mediaPath(m.s3_key);
    if (!fp) return res.status(400).json({ error: 'Bad path.' });

    const label = m.season != null
      ? `${m.title} S${String(m.season).padStart(2, '0')}E${String(m.episode).padStart(2, '0')}`
      : m.title;
    const filename = label.replace(/[^\w .-]/g, '').trim() + '.mp4';

    pool.query('insert into events (user_id, type, media_id, detail) values ($1, $2, $3, $4)',
      [req.user.id, 'download', m.id, { title: label }]).catch((e) => console.error('event log failed', e));
    notify(`⬇️ <b>${esc(req.user.name)}</b> downloaded <b>${esc(label)}</b>`);

    streamFile(req, res, fp, 'video/mp4', { download: true, filename });
  } catch (err) {
    if (err.code === '22P02') return res.status(400).json({ error: 'Bad id.' });
    console.error('download failed:', err);
    res.status(500).json({ error: 'Could not download.' });
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
  console.log(`Serving local media from ${MEDIA_ROOT || '(MEDIA_ROOT not set!)'}`);
});
