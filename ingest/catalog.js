import { pool } from '../db/pool.js';
import { slugify } from './parse.js';
import { posterUrl, episodeName } from './tmdb.js';

// Upsert a movie/series title and return its id.
async function upsertTitle({ kind, slug, name, year, tmdb_id, overview, poster_path }) {
  const { rows } = await pool.query(
    `insert into titles (kind, slug, name, year, tmdb_id, overview, poster_key)
       values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (slug) do update set
       name = excluded.name, year = coalesce(excluded.year, titles.year),
       tmdb_id = coalesce(excluded.tmdb_id, titles.tmdb_id),
       overview = coalesce(excluded.overview, titles.overview),
       poster_key = coalesce(excluded.poster_key, titles.poster_key)
     returning id`,
    [kind, slug, name, year, tmdb_id ?? null, overview ?? null, posterUrl(poster_path)],
  );
  return rows[0].id;
}

// Commit one processed item to the catalog. Idempotent (safe to re-run).
export async function commitCatalog(item, { probe, action, audioLang }, videoKey, subs) {
  const t = item.tmdb || {};
  let titleId = null;
  let episodeId = null;

  if (item.kind === 'movie') {
    const name = t.name || item.title || 'Untitled';
    const year = t.year || item.year || null;
    titleId = await upsertTitle({
      kind: 'movie', slug: slugify(name, year), name, year,
      tmdb_id: t.id, overview: t.overview, poster_path: t.poster_path,
    });
  } else {
    const show = t.name || item.show || 'Untitled';
    const seriesId = await upsertTitle({
      kind: 'series', slug: slugify(show), name: show, year: t.year,
      tmdb_id: t.id, overview: t.overview, poster_path: t.poster_path,
    });
    const epName = t.id ? await episodeName(t.id, item.season, item.episode) : null;
    const { rows } = await pool.query(
      `insert into episodes (series_id, season, episode, name)
         values ($1,$2,$3,$4)
       on conflict (series_id, season, episode) do update set name = coalesce(excluded.name, episodes.name)
       returning id`,
      [seriesId, item.season, item.episode, epName],
    );
    episodeId = rows[0].id;
  }

  const { rows } = await pool.query(
    `insert into media (title_id, episode_id, s3_key, duration_sec, width, height, audio_lang, source_format, size_bytes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (s3_key) do update set
       duration_sec = excluded.duration_sec, width = excluded.width, height = excluded.height,
       audio_lang = excluded.audio_lang, source_format = excluded.source_format, size_bytes = excluded.size_bytes
     returning id`,
    [
      titleId, episodeId, videoKey,
      probe.durationSec, probe.video?.width ?? null, probe.video?.height ?? null,
      audioLang ?? null, action, probe.sizeBytes ?? null,
    ],
  );
  const mediaId = rows[0].id;

  for (const s of subs) {
    await pool.query(
      `insert into subtitles (media_id, lang, label, s3_key)
         values ($1,$2,$3,$4)
       on conflict (media_id, lang) do update set s3_key = excluded.s3_key, label = excluded.label`,
      [mediaId, s.lang, s.label, s.key],
    );
  }
  return mediaId;
}
