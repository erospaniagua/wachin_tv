// One-time migration: download already-transcoded media + subtitles from S3
// into the local MEDIA_ROOT, so nothing needs re-transcoding after the pivot
// to self-hosting. Safe to re-run (skips files already present).
//
//   npm run pull            # everything
//   npm run pull -- --limit 1   # just the first (for a quick test)
import 'dotenv/config';
import { mkdirSync, existsSync, createWriteStream, statSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { pool } from '../db/pool.js';

const root = process.env.MEDIA_ROOT;
if (!root) { console.error('MEDIA_ROOT not set.'); process.exit(1); }

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg >= 0 ? +process.argv[limitArg + 1] : Infinity;

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
});

const media = await pool.query('select s3_key from media');
const subs = await pool.query('select s3_key from subtitles');
const keys = [...media.rows, ...subs.rows].map((r) => r.s3_key);

let pulled = 0, skipped = 0;
for (const key of keys) {
  if (pulled >= LIMIT) break;
  const dest = path.join(root, key);
  if (existsSync(dest) && statSync(dest).size > 0) { skipped++; continue; }
  mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    await pipeline(obj.Body, createWriteStream(dest));
    pulled++;
    console.log(`pulled ${key}`);
  } catch (err) {
    console.error(`FAILED ${key}: ${err.message}`);
  }
}
console.log(`\nDone. Pulled ${pulled}, already-present ${skipped}, of ${keys.length} files.`);
await pool.end();
