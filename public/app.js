const browseEl = document.getElementById('browse');
const detailEl = document.getElementById('detail');
const detailHead = document.getElementById('detail-head');
const detailBody = document.getElementById('detail-body');
const playerWrap = document.getElementById('player-wrap');
const player = document.getElementById('player');
const nowPlaying = document.getElementById('now-playing');
const downloadBtn = document.getElementById('download-btn');

let currentMediaId = null; // media loaded in the player

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- session gate ---
async function requireSession() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error('unauthenticated');
    const { user } = await res.json();
    document.getElementById('whoami').textContent = user.name;
    if (user.role === 'admin') document.getElementById('admin-link').hidden = false;
    return true;
  } catch {
    window.location.replace('/login.html');
    return false;
  }
}

// --- views ---
function showBrowse() {
  detailEl.hidden = true;
  playerWrap.hidden = true;
  player.pause();
  player.removeAttribute('src');
  browseEl.hidden = false;
}

async function loadCatalog() {
  browseEl.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { titles } = await (await fetch('/api/titles')).json();
    if (!titles.length) {
      browseEl.innerHTML = '<p class="muted">Nothing here yet — the library is still ingesting.</p>';
      return;
    }
    browseEl.innerHTML = '';
    for (const t of titles) {
      const card = document.createElement('button');
      card.className = 'card';
      const poster = t.poster_key
        ? `<img class="poster" loading="lazy" src="${esc(t.poster_key)}" alt="">`
        : `<div class="poster placeholder">${esc(t.name)}</div>`;
      const badge = t.kind === 'series' ? `<span class="badge">${t.episodes} ep</span>` : '';
      card.innerHTML = `${poster}${badge}
        <span class="card-title">${esc(t.name)}</span>
        <span class="card-year">${t.year || ''}</span>`;
      card.addEventListener('click', () => openTitle(t.slug));
      browseEl.appendChild(card);
    }
  } catch (err) {
    console.error(err);
    browseEl.innerHTML = '<p class="muted">Could not load the catalog.</p>';
  }
}

async function openTitle(slug) {
  browseEl.hidden = true;
  detailEl.hidden = false;
  detailHead.innerHTML = '<p class="muted">Loading…</p>';
  detailBody.innerHTML = '';
  window.scrollTo(0, 0);

  try {
    const data = await (await fetch(`/api/titles/${encodeURIComponent(slug)}`)).json();
    const t = data.title;
    const poster = t.poster_key ? `<img class="detail-poster" src="${esc(t.poster_key)}" alt="">` : '';
    detailHead.innerHTML = `${poster}
      <div class="detail-meta">
        <h2>${esc(t.name)} ${t.year ? `<span class="muted">(${t.year})</span>` : ''}</h2>
        <p class="overview">${esc(t.overview || '')}</p>
      </div>`;

    if (t.kind === 'movie') {
      if (!data.media) { detailBody.innerHTML = '<p class="muted">No playable file.</p>'; return; }
      const btn = document.createElement('button');
      btn.className = 'play-btn';
      btn.textContent = '▶ Play';
      btn.addEventListener('click', () => playMedia(data.media.id, t.name));
      detailBody.appendChild(btn);
    } else {
      renderEpisodes(data.episodes, t.name);
    }
  } catch (err) {
    console.error(err);
    detailHead.innerHTML = '<p class="muted">Could not load this title.</p>';
  }
}

function renderEpisodes(episodes, showName) {
  const bySeason = {};
  for (const e of episodes) (bySeason[e.season] ||= []).push(e);
  detailBody.innerHTML = '';
  for (const season of Object.keys(bySeason).sort((a, b) => a - b)) {
    const h = document.createElement('h3');
    h.className = 'season-head';
    h.textContent = `Season ${season}`;
    detailBody.appendChild(h);
    const list = document.createElement('div');
    list.className = 'ep-list';
    for (const e of bySeason[season]) {
      const row = document.createElement('button');
      row.className = 'ep-row';
      row.innerHTML = `<span class="ep-num">E${String(e.episode).padStart(2, '0')}</span>
        <span class="ep-name">${esc(e.name || 'Episode ' + e.episode)}</span>`;
      row.addEventListener('click', () => playMedia(e.media_id, `${showName} · S${season}E${e.episode}`));
      list.appendChild(row);
    }
    detailBody.appendChild(list);
  }
}

async function playMedia(mediaId, label) {
  currentMediaId = mediaId;
  playerWrap.hidden = false;
  nowPlaying.textContent = `Loading “${label}”…`;
  // clear old subtitle tracks
  [...player.querySelectorAll('track')].forEach((t) => t.remove());
  window.scrollTo({ top: 0, behavior: 'smooth' });

  try {
    const { url, subtitles } = await (await fetch(`/api/media/${mediaId}/play`)).json();
    player.src = url;
    for (const s of subtitles || []) {
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = s.label || s.lang;
      track.srclang = s.lang;
      track.src = s.url;
      player.appendChild(track);
    }
    if (subtitles?.length) player.textTracks[0].mode = 'showing';
    await player.play().catch(() => {});
    nowPlaying.textContent = `Now playing: ${label}`;
  } catch (err) {
    console.error(err);
    nowPlaying.textContent = `Could not play “${label}”.`;
  }
}

async function download() {
  if (!currentMediaId) return;
  downloadBtn.disabled = true;
  try {
    const { url } = await (await fetch(`/api/media/${currentMediaId}/download`)).json();
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    console.error(err);
  } finally {
    downloadBtn.disabled = false;
  }
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.replace('/login.html');
}

document.getElementById('brand').addEventListener('click', showBrowse);
document.getElementById('back-btn').addEventListener('click', showBrowse);
document.getElementById('logout-btn').addEventListener('click', logout);
downloadBtn.addEventListener('click', download);

requireSession().then((ok) => { if (ok) loadCatalog(); });
