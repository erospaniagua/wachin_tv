// Parse messy release names into clean {title, year} / {season, episode}.

// Tags after which the real title has ended (quality, source, codec, group…).
const STOP_TAGS =
  /\b(1080p|2160p|720p|480p|352p|4k|uhd|bluray|brrip|bdrip|web[\s._-]?dl|webrip|hdtv|dvdrip|dvd|hdrip|remux|x264|x265|h[\s._-]?264|h[\s._-]?265|hevc|avc|xvid|divx|aac|ac3|eac3|dts|ddp?5[\s._-]?1|dd5[\s._-]?1|flac|10bit|8bit|hdr|dv|atmos|hdr|amzn|nf|atvp|max|proper|repack|complete|latino|castellano|sci[\s._-]?fi|multi[\s._-]?subs?|multi|dual|subs?|yify|yts|eztv|rarbg|bone|ethel|megusta|ntb|silence)\b/i;

// Junk prefixes some releases carry.
const JUNK_PREFIX = /^(www\.\S+\s*-\s*|\[[^\]]*\]\s*)+/i;

// Remove bracket/paren groups that don't contain a 4-digit year, plus glued
// Spanish-subtitle / site tags — these confuse title search.
function stripJunk(s) {
  return s
    .replace(/[[(](?![^)\]]*\b(?:19|20)\d{2}\b)[^)\]]*[)\]]/g, ' ') // (Lars Von Trier), [SubsEspañol]
    .replace(/subs?\s*espa[ñn]ol/gi, ' ') // glued "SubsEspañol"
    .replace(/\bespa[ñn]ol\b/gi, ' ')
    .replace(/rinconcinefilo\.?\w*/gi, ' ');
}

function normalizeSpaces(s) {
  return s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function extractYear(name) {
  // Prefer a year in parentheses/brackets, else the last standalone 19xx/20xx.
  const paren = name.match(/[([](19|20)\d{2}[)\]]/);
  if (paren) return +paren[0].slice(1, 5);
  const all = [...name.matchAll(/\b(19|20)\d{2}\b/g)];
  return all.length ? +all[all.length - 1][0] : null;
}

// Clean a movie name from a folder (preferred) or file name.
export function parseMovie(name) {
  let s = stripJunk(name.replace(JUNK_PREFIX, ''));
  const year = extractYear(s);

  // Cut at the first stop tag, or at a year — but not a year at the very start
  // of the string (e.g. "2001 A Space Odyssey" — that leading number IS title).
  const tagMatch = s.match(STOP_TAGS);
  let yearCut = null;
  for (const m of s.matchAll(/[([]?\b(?:19|20)\d{2}\b[)\]]?/g)) {
    if (m.index > 2) { yearCut = m.index; break; }
  }
  const cutPoints = [tagMatch?.index, yearCut].filter((n) => n != null);
  if (cutPoints.length) s = s.slice(0, Math.min(...cutPoints));

  const title = normalizeSpaces(s).replace(/[-–:]\s*$/, '').trim();
  return { title, year };
}

// Pull season/episode from an episode file name. Supports S01E02, 1x02, and
// anime absolute numbering (e.g. "Monster 01" → S1E1).
export function parseEpisode(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '');
  const m1 = base.match(/[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})/);
  if (m1) return { season: +m1[1], episode: +m1[2] };
  const m2 = base.match(/\b(\d{1,2})x(\d{1,3})\b/);
  if (m2) return { season: +m2[1], episode: +m2[2] };
  // Anime fallback → season 1. Strip bracket groups + resolution/year first so
  // we don't grab "720" or a year as the episode number.
  const cleaned = base
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b\d{3,4}p\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ');
  const nums = [...cleaned.matchAll(/(?:^|[\s._-])(\d{1,3})(?=[\s._-]|$)/g)];
  if (nums.length) return { season: 1, episode: +nums[nums.length - 1][1] };
  return null;
}

// Clean a series/show folder name into a searchable title.
export function parseShow(name) {
  let s = stripJunk(name.replace(JUNK_PREFIX, ''));
  // Cut at the first of: SxxExx / Sxx, "season", "complete", or a (year).
  const cut = s.match(/\b([Ss]\d{1,2}([Ee]\d{1,2})?|seasons?|complete)\b|[([](?:19|20)\d{2}[)\]]/);
  if (cut) s = s.slice(0, cut.index);
  const tagMatch = s.match(STOP_TAGS);
  if (tagMatch) s = s.slice(0, tagMatch.index);
  return { title: normalizeSpaces(s).replace(/[-–:]\s*$/, '').trim() };
}

const COMBINING = /[̀-ͯ]/g;

export function slugify(title, year) {
  const base = (title || 'untitled')
    .normalize('NFD')
    .replace(COMBINING, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return year ? `${base}-${year}` : base;
}
