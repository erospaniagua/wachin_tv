import crypto from 'node:crypto';
import express from 'express';
import { pool } from './db/pool.js';
import { sendMagicLink } from './mailer.js';

const {
  APP_URL = 'http://localhost:3000',
  SESSION_TTL_DAYS = '30',
  MAGIC_LINK_TTL_MINUTES = '15',
} = process.env;

const SESSION_COOKIE = 'wtv_session';
const sessionTtlMs = Math.max(1, parseInt(SESSION_TTL_DAYS, 10) || 30) * 86400_000;
const linkTtlMs = Math.max(1, parseInt(MAGIC_LINK_TTL_MINUTES, 10) || 15) * 60_000;
const secureCookie = APP_URL.startsWith('https://');

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('hex');

// --- session helpers -------------------------------------------------------

async function createSession(userId) {
  const raw = randomToken();
  const expiresAt = new Date(Date.now() + sessionTtlMs);
  await pool.query(
    'insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)',
    [sha256(raw), userId, expiresAt],
  );
  return { raw, expiresAt };
}

function setSessionCookie(res, raw, expiresAt) {
  res.cookie(SESSION_COOKIE, raw, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: 'lax',
    expires: expiresAt,
    path: '/',
  });
}

// Middleware: require a valid session; attaches req.user. Used on every /api route.
export async function requireAuth(req, res, next) {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return res.status(401).json({ error: 'Not signed in.' });

  try {
    const { rows } = await pool.query(
      `select u.id, u.email, u.name, u.role
         from sessions s
         join users u on u.id = s.user_id
        where s.token_hash = $1 and s.expires_at > now()`,
      [sha256(raw)],
    );
    if (!rows.length) {
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      return res.status(401).json({ error: 'Session expired.' });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    console.error('Auth check failed:', err);
    res.status(500).json({ error: 'Auth error.' });
  }
}

// Require an admin session (chain after requireAuth).
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  next();
}

// Create + email a magic link to a known user. Returns false if no such user.
export async function issueMagicLink(email) {
  const { rows } = await pool.query('select id, name from users where lower(email) = $1', [email]);
  if (!rows.length) return false;
  const user = rows[0];
  const raw = randomToken();
  await pool.query(
    'insert into magic_tokens (user_id, token_hash, expires_at) values ($1, $2, $3)',
    [user.id, sha256(raw), new Date(Date.now() + linkTtlMs)],
  );
  await sendMagicLink(email, user.name, `${APP_URL}/api/auth/verify?token=${raw}`);
  return true;
}

// --- routes ----------------------------------------------------------------

export const authRouter = express.Router();

// Request a magic link. Always responds the same way whether or not the email
// exists, so it can't be used to enumerate who has an account.
authRouter.post('/request-link', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const generic = { ok: true, message: 'If that email is registered, a sign-in link is on its way.' };
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  try {
    await issueMagicLink(email); // ignore result → don't reveal whether it exists
    res.json(generic);
  } catch (err) {
    console.error('request-link failed:', err);
    res.status(500).json({ error: 'Could not send link.' });
  }
});

// Verify a magic link, consume the token, start a session, redirect to the app.
authRouter.get('/verify', async (req, res) => {
  const raw = req.query.token;
  if (!raw || typeof raw !== 'string') return res.status(400).send('Invalid link.');

  try {
    // Consume the token atomically: only succeeds if unused and unexpired.
    const { rows } = await pool.query(
      `update magic_tokens
          set used_at = now()
        where token_hash = $1 and used_at is null and expires_at > now()
        returning user_id`,
      [sha256(raw)],
    );
    if (!rows.length) {
      return res.status(400).send('This sign-in link is invalid or has expired. Request a new one.');
    }

    const { raw: sessionRaw, expiresAt } = await createSession(rows[0].user_id);
    setSessionCookie(res, sessionRaw, expiresAt);
    res.redirect('/');
  } catch (err) {
    console.error('verify failed:', err);
    res.status(500).send('Something went wrong signing you in.');
  }
});

// Who am I? Used by the frontend to gate the UI.
authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Sign out: delete the session and clear the cookie.
authRouter.post('/logout', async (req, res) => {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (raw) {
    try {
      await pool.query('delete from sessions where token_hash = $1', [sha256(raw)]);
    } catch (err) {
      console.error('logout cleanup failed:', err);
    }
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});
