// Decide, from a probe result, what ffmpeg work each file needs.

const BROWSER_VIDEO = new Set(['h264']); // what <video> plays reliably
const BROWSER_AUDIO = new Set(['aac']);
// Text subtitle codecs we can convert to WebVTT.
const TEXT_SUB = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
// Image-based subs need OCR — we can't turn them into VTT.
const IMAGE_SUB = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvbsub', 'vobsub']);

// Pick the default audio track by language priority, else the file's default,
// else the first track.
export function pickAudio(audios, priority) {
  if (!audios.length) return null;
  for (const lang of priority) {
    const hit = audios.find((a) => a.lang === lang);
    if (hit) return hit;
  }
  return audios.find((a) => a.default) || audios[0];
}

export function planActions(probe, priority) {
  const warnings = [];
  const audio = pickAudio(probe.audios, priority);

  const videoOk = probe.video && BROWSER_VIDEO.has(probe.video.codec);
  const audioOk = audio && BROWSER_AUDIO.has(audio.codec);

  if (!probe.video) warnings.push('no video stream detected');
  if (!audio) warnings.push('no audio stream detected');

  // Container: mp4 needs no remux if streams already compatible.
  const isMp4 = /mp4|mov|m4a|3gp/.test(probe.container || '');

  let action;
  if (!videoOk) action = audioOk ? 'transcode-video' : 'transcode-av';
  else if (!audioOk) action = 'transcode-audio';
  else action = isMp4 ? 'copy' : 'remux';

  // Embedded subtitle tracks we can extract.
  const embeddedSubs = [];
  for (const s of probe.subs) {
    if (TEXT_SUB.has(s.codec)) {
      embeddedSubs.push({ source: 'embedded', index: s.index, lang: s.lang || 'und', codec: s.codec });
    } else if (IMAGE_SUB.has(s.codec)) {
      warnings.push(`image subtitle (${s.codec}) skipped — needs OCR`);
    }
  }

  return {
    action, // copy | remux | transcode-audio | transcode-video | transcode-av
    audioTrackIndex: audio?.index ?? null,
    audioLang: audio?.lang ?? null,
    videoOk,
    audioOk,
    embeddedSubs,
    warnings,
  };
}
