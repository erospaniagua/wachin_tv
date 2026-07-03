import 'dotenv/config';
import pg from 'pg';

const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  console.error(
    'Missing DATABASE_URL. Set it in .env (use Railway\'s DATABASE_PUBLIC_URL locally).',
  );
  process.exit(1);
}

// Railway's Postgres speaks TLS with a cert that fails default verification, so
// allow it without rejecting unauthorized certs. Override with PGSSL=disable
// (no TLS) or PGSSL=require (force TLS) if a deploy needs it.
const pgssl = process.env.PGSSL;
let ssl;
if (pgssl === 'disable') ssl = undefined;
else if (pgssl === 'require' || /proxy\.rlwy\.net|railway/.test(DATABASE_URL)) {
  ssl = { rejectUnauthorized: false };
}

export const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl });
