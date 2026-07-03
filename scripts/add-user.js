// Admin tool: create a user (no self-signup). Usage:
//   npm run user:add -- --email jane@example.com --name "Jane Doe"
//   npm run user:add -- --email you@example.com --name "You" --admin
//
// DATABASE_URL must be set (locally, use Railway's DATABASE_PUBLIC_URL).
import { pool } from '../db/pool.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--admin') out.admin = true;
    else if (a === '--email') out.email = argv[++i];
    else if (a === '--name') out.name = argv[++i];
  }
  return out;
}

const { email, name, admin } = parseArgs(process.argv.slice(2));

if (!email || !name) {
  console.error('Usage: npm run user:add -- --email <email> --name "<name>" [--admin]');
  process.exit(1);
}

const normalizedEmail = email.trim().toLowerCase();
const role = admin ? 'admin' : 'user';

try {
  const { rows } = await pool.query(
    `insert into users (email, name, role)
     values ($1, $2, $3)
     on conflict (email) do update set name = excluded.name, role = excluded.role
     returning id, email, name, role, created_at`,
    [normalizedEmail, name.trim(), role],
  );
  const u = rows[0];
  console.log(`✔ User ready: ${u.name} <${u.email}> [${u.role}]`);
  console.log(`  They can now sign in via the magic-link page.`);
} catch (err) {
  console.error('Failed to create user:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
