import 'dotenv/config';
import { readdirSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { assertFfmpeg } from './ffbin.js';
import { probe } from './probe.js';
import { parseMovie, parseEpisode, parseShow, slugify } from './parse.js';
import { planActions } from './planner.js';
import { searchMovie, searchTv, getMovie, getTv } from './tmdb.js';

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.webm']);
const priority = (process.env.AUDIO_PRIORITY || 'en,es').split(',').map((s) => s.trim());

// --- args ---
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const val = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const LIMIT = val('limit') ? +val('limit') : Infinity;
const doMovies = flag('movies') || (!flag('movies') && !flag('series'));
const doSeries = flag('series') || (!flag('movies') && !flag('series'));

// --- fs helpers ---
function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}
const isVideo = (f) => VIDEO_EXT.has(path.extname(f).toLowerCase());
const size = (f) => {
  try { return statSync(f).size; } catch { return 0; }
};

// Find a sidecar .srt for a video, and guess its language from the name.
function sidecarSubs(videoPath, allFiles) {
  const base = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  const dir = path.dirname(videoPath);
  return allFiles
    .filter((f) => path.extname(f).toLowerCase() === '.srt' && path.dirname(f) === dir)
    .filter((f) => {
      const sb = path.basename(f).toLowerCase();
      return sb.startsWith(base) || allFiles.filter(isVideo).length === 1;
    })
    .map((f) => {
      const m = path.basename(f).match(/\.(en|es|eng|spa|esp|fr|fre)\.srt$/i);
      const lang = m ? m[1].toLowerCase().replace('eng', 'en').replace(/spa|esp/, 'es').replace('fre', 'fr') : 'und';
      return { source: 'sidecar', path: f, lang };
    });
}

// --- build item lists ---
function movieItems(root) {
  const items = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const files = walkFiles(dir);
    const videos = files.filter(isVideo).sort((a, b) => size(b) - size(a));
    if (!videos.length) continue;
    const primary = videos[0]; // largest = feature, skip samples/extras
    const { title, year } = parseMovie(entry.name);
    items.push({
      kind: 'movie',
      folder: entry.name,
      videoPath: primary,
      title,
      year,
      subs: sidecarSubs(primary, files),
    });
  }
  return items;
}

function seriesItems(root) {
  const items = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const showDir = path.join(root, entry.name);
    const { title: show } = parseShow(entry.name);
    const files = walkFiles(showDir);
    for (const v of files.filter(isVideo)) {
      const se = parseEpisode(path.basename(v));
      if (!se) continue; // not an episode-named file
      items.push({
        kind: 'episode',
        show,
        showFolder: entry.name,
        videoPath: v,
        season: se.season,
        episode: se.episode,
        subs: sidecarSubs(v, files),
      });
    }
  }
  return items;
}

// --- run ---
async function main() {
  assertFfmpeg();
  const items = [];
  if (doMovies && process.env.MOVIES_DIR) items.push(...movieItems(process.env.MOVIES_DIR));
  if (doSeries && process.env.SERIES_DIR) items.push(...seriesItems(process.env.SERIES_DIR));

  // Load manual overrides (fix TMDB matches / skip items) if present.
  const ovPath = val('overrides', path.join(process.cwd(), 'overrides.json'));
  const overrides = existsSync(ovPath)
    ? JSON.parse(readFileSync(ovPath, 'utf8'))
    : { movies: {}, series: {} };
  overrides.movies ||= {};
  overrides.series ||= {};

  const filter = val('filter');
  const filtered = filter
    ? items.filter((i) => `${i.folder || ''} ${i.showFolder || ''} ${i.videoPath}`.toLowerCase().includes(filter.toLowerCase()))
    : items;
  // Drop items explicitly marked skip in overrides.
  const kept = filtered.filter((i) => {
    const ov = (i.kind === 'movie' ? overrides.movies : overrides.series)[i.kind === 'movie' ? i.folder : i.showFolder];
    return !ov?.skip;
  });
  const selected = kept.slice(0, LIMIT);
  console.log(`Scanning ${selected.length} of ${items.length} items (priority: ${priority.join('>')}, overrides: ${Object.keys(overrides.movies).length + Object.keys(overrides.series).length})\n`);

  const plan = [];
  let done = 0;
  for (const item of selected) {
    done++;
    const label = item.kind === 'movie' ? item.folder : `${item.showFolder} S${item.season}E${item.episode}`;
    try {
      const pr = await probe(item.videoPath);
      const actions = planActions(pr, priority);

      // Apply an override (keyed by folder / show folder) if present.
      const ovKey = item.kind === 'movie' ? item.folder : item.showFolder;
      const ov = (item.kind === 'movie' ? overrides.movies : overrides.series)?.[ovKey];

      let match;
      if (item.kind === 'movie') {
        if (ov?.tmdb_id) match = await getMovie(ov.tmdb_id);
        else match = await searchMovie(ov?.title || item.title, ov?.year ?? item.year);
      } else {
        if (ov?.tmdb_id) match = await getTv(ov.tmdb_id);
        else match = await searchTv(ov?.title || item.show);
      }

      const name = match?.name || item.title || item.show;
      const year = match?.year || item.year || null;
      const slug =
        item.kind === 'movie'
          ? slugify(name, year)
          : `${slugify(name)}/s${String(item.season).padStart(2, '0')}e${String(item.episode).padStart(2, '0')}`;
      const targetKey = `${item.kind === 'movie' ? 'movies' : 'series'}/${slug}/video.mp4`;

      const row = {
        ...item,
        probe: { container: pr.container, video: pr.video, audioLangs: pr.audios.map((a) => a.lang) },
        action: actions.action,
        audioLang: actions.audioLang,
        subCount: item.subs.length + actions.embeddedSubs.length,
        tmdb: match ? { id: match.tmdb_id, name: match.name, year: match.year, poster_path: match.poster_path, overview: match.overview } : null,
        targetKey,
        warnings: actions.warnings,
      };
      plan.push(row);
      const flagM = (match ? '✓' : '✗TMDB') + (ov ? '·ov' : '');
      process.stdout.write(`[${done}/${selected.length}] ${flagM} ${actions.action.padEnd(16)} ${label} -> ${name}${year ? ` (${year})` : ''}\n`);
    } catch (err) {
      plan.push({ ...item, error: err.message });
      process.stdout.write(`[${done}/${selected.length}] ERROR ${label}: ${err.message}\n`);
    }
  }

  // Summary
  const by = (key) => plan.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {});
  const unmatched = plan.filter((r) => !r.tmdb && !r.error);
  console.log('\n=== SUMMARY ===');
  console.log('By action:', by('action'));
  console.log(`TMDB matched: ${plan.filter((r) => r.tmdb).length}/${plan.length}`);
  if (unmatched.length) {
    console.log(`Unmatched (${unmatched.length}):`);
    for (const r of unmatched.slice(0, 30)) console.log('   -', r.folder || `${r.showFolder} S${r.season}E${r.episode}`);
  }
  const warned = plan.filter((r) => r.warnings?.length);
  if (warned.length) console.log(`With warnings: ${warned.length}`);

  const outPath = val('out', path.join(process.cwd(), 'ingest-plan.json'));
  writeFileSync(outPath, JSON.stringify(plan, null, 2));
  console.log(`\nPlan written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
