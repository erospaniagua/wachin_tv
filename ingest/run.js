import 'dotenv/config';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { pool } from '../db/pool.js';
import { convert } from './convert.js';
import { uploadFile } from './s3.js';
import { commitCatalog } from './catalog.js';

// --- args ---
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const planPath = val('plan', path.join(process.cwd(), 'ingest-plan.json'));
const DRY = flag('dry-run');
const LIMIT = val('limit') ? +val('limit') : Infinity;
const CLIP = val('clip') ? ['-t', String(+val('clip'))] : []; // test aid: cap output duration
const priority = (process.env.AUDIO_PRIORITY || 'en,es').split(',').map((s) => s.trim());
const STOP_FILE = path.join(process.cwd(), 'STOP');

// Cheap actions first, so an early stop still leaves the most titles online.
const ACTION_ORDER = { copy: 0, remux: 0, 'transcode-audio': 1, 'transcode-video': 2, 'transcode-av': 3 };

// --- graceful stop control ---
let stop = false;
let ctrl = null; // AbortController for the in-flight ffmpeg
function onSignal() {
  if (stop) { console.log('\n⏹  Aborting current file now…'); ctrl?.abort(); }
  else { stop = true; console.log('\n⏸  Stop requested — finishing current file, then exiting. (Ctrl+C again to abort now.)'); }
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

function stopRequested() {
  if (existsSync(STOP_FILE)) { console.log('\n⏸  STOP file detected — finishing current file, then exiting.'); return true; }
  return stop;
}

async function counts() {
  const { rows } = await pool.query(
    "select status, count(*)::int c from ingest_jobs group by status",
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.c]));
}

async function main() {
  const plan = JSON.parse(readFileSync(planPath, 'utf8')).filter((p) => p.videoPath && !p.error);

  // Register/refresh jobs (never downgrade a 'done' row).
  for (const it of plan) {
    await pool.query(
      `insert into ingest_jobs (source_path, kind, action, target_key) values ($1,$2,$3,$4)
       on conflict (source_path) do update set action = excluded.action, target_key = excluded.target_key
       where ingest_jobs.status <> 'done'`,
      [it.videoPath, it.kind, it.action, it.targetKey],
    );
  }
  // Interrupted files from a previous run go back in the queue.
  await pool.query("update ingest_jobs set status='pending' where status='processing'");
  // A leftover STOP file from last time shouldn't kill this run immediately.
  if (existsSync(STOP_FILE)) { unlinkSync(STOP_FILE); console.log('Removed leftover STOP file.'); }

  const queue = plan.sort((a, b) => (ACTION_ORDER[a.action] ?? 9) - (ACTION_ORDER[b.action] ?? 9));
  console.log(`Plan: ${queue.length} items. Starting… (Ctrl+C or create a STOP file to stop gracefully)\n`);

  let processed = 0;
  for (const it of queue) {
    if (processed >= LIMIT) break;
    if (stopRequested()) break;

    const { rows } = await pool.query('select status from ingest_jobs where source_path=$1', [it.videoPath]);
    if (rows[0]?.status === 'done') continue;

    const label = it.kind === 'movie' ? it.folder : `${it.showFolder} S${it.season}E${it.episode}`;
    console.log(`▶ [${it.action}] ${label}`);
    await pool.query("update ingest_jobs set status='processing', attempts=attempts+1, updated_at=now() where source_path=$1", [it.videoPath]);
    ctrl = new AbortController();

    try {
      if (DRY) {
        console.log('   (dry-run) would transcode → upload → catalog');
      } else {
        const out = await convert(it, { priority, signal: ctrl.signal, extraArgs: CLIP });
        process.stdout.write('   uploading…');
        await uploadFile(out.videoPath, it.targetKey, 'video/mp4');
        const subMeta = [];
        for (const s of out.subs) {
          const key = it.targetKey.replace(/video\.mp4$/, `subs/${s.lang}.vtt`);
          await uploadFile(s.path, key, 'text/vtt');
          subMeta.push({ lang: s.lang, label: s.label, key });
        }
        const mediaId = await commitCatalog(it, out, it.targetKey, subMeta);
        out.cleanup();
        await pool.query("update ingest_jobs set status='done', media_id=$2, error=null, updated_at=now() where source_path=$1", [it.videoPath, mediaId]);
        console.log(` done (${out.subs.length} subs)`);
      }
      processed++;
    } catch (err) {
      if (err.name === 'AbortError') {
        await pool.query("update ingest_jobs set status='pending', updated_at=now() where source_path=$1", [it.videoPath]);
        console.log('   aborted — will resume next run.');
        break;
      }
      await pool.query("update ingest_jobs set status='failed', error=$2, updated_at=now() where source_path=$1", [it.videoPath, String(err.message).slice(0, 500)]);
      console.log(`   FAILED: ${err.message}`);
    } finally {
      ctrl = null;
    }
  }

  console.log('\n=== INGEST STATUS ===');
  console.log(await counts());
  await pool.end();
}

main().catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
