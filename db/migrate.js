import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Run every db/NNN_*.sql in filename order. Each file is idempotent, so this
// is safe to re-run.
const files = readdirSync(__dirname)
  .filter((f) => /^\d+.*\.sql$/.test(f))
  .sort();

try {
  for (const file of files) {
    const sql = readFileSync(path.join(__dirname, file), 'utf8');
    await pool.query(sql);
    console.log(`✔ applied ${file}`);
  }
  console.log('Migrations complete.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}