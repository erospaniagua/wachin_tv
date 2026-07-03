// Minimal TMDB client using the v4 read-access token (Bearer auth).
const TOKEN = process.env.TMDB_API_KEY;
const BASE = 'https://api.themoviedb.org/3';
const cache = new Map();

async function tmdb(pathname, params = {}) {
  if (!TOKEN) throw new Error('TMDB_API_KEY is not set.');
  const url = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }
  const key = url.toString();
  if (cache.has(key)) return cache.get(key);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`TMDB ${res.status} for ${pathname}`);
  const json = await res.json();
  cache.set(key, json);
  return json;
}

export async function searchMovie(title, year) {
  if (!title) return null;
  const { results = [] } = await tmdb('/search/movie', {
    query: title,
    year: year || undefined,
  });
  const m = results[0];
  if (!m) return null;
  return {
    tmdb_id: m.id,
    name: m.title,
    year: m.release_date ? +m.release_date.slice(0, 4) : null,
    overview: m.overview || null,
    poster_path: m.poster_path || null,
  };
}

export async function searchTv(title) {
  if (!title) return null;
  const { results = [] } = await tmdb('/search/tv', { query: title });
  const t = results[0];
  if (!t) return null;
  return {
    tmdb_id: t.id,
    name: t.name,
    year: t.first_air_date ? +t.first_air_date.slice(0, 4) : null,
    overview: t.overview || null,
    poster_path: t.poster_path || null,
  };
}

// Fetch exact match by id (used by overrides that force a specific title).
export async function getMovie(id) {
  const m = await tmdb(`/movie/${id}`);
  return {
    tmdb_id: m.id, name: m.title,
    year: m.release_date ? +m.release_date.slice(0, 4) : null,
    overview: m.overview || null, poster_path: m.poster_path || null,
  };
}

export async function getTv(id) {
  const t = await tmdb(`/tv/${id}`);
  return {
    tmdb_id: t.id, name: t.name,
    year: t.first_air_date ? +t.first_air_date.slice(0, 4) : null,
    overview: t.overview || null, poster_path: t.poster_path || null,
  };
}

export async function episodeName(tvId, season, episode) {
  try {
    const ep = await tmdb(`/tv/${tvId}/season/${season}/episode/${episode}`);
    return ep?.name || null;
  } catch {
    return null;
  }
}

export const posterUrl = (p) => (p ? `https://image.tmdb.org/t/p/w500${p}` : null);
