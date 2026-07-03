import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FFMPEG } from './ffbin.js';
import { probe } from './probe.js';
import { planActions } from './planner.js';
import { srtToVtt, labelFor } from './subs.js';

// Run ffmpeg with the given args. Rejects on non-zero exit or abort signal.
function runFfmpeg(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { signal, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString().slice(-2000); });
    child.on('error', reject); // includes AbortError when signal fires
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`)),
    );
  });
}

// Codec choices per action (see planner). Video/audio flags for the MP4.
function codecArgs(action) {
  switch (action) {
    case 'transcode-audio': return ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k'];
    case 'transcode-video': return ['-c:v', 'h264_qsv', '-global_quality', '23', '-c:a', 'copy'];
    case 'transcode-av':    return ['-c:v', 'h264_qsv', '-global_quality', '23', '-c:a', 'aac', '-b:a', '192k'];
    default:                return ['-c:v', 'copy', '-c:a', 'copy']; // copy | remux
  }
}

// Produce a standardized MP4 + WebVTT subtitle files in a temp dir.
// Re-probes the file so ffmpeg decisions never rely on a stale plan.
export async function convert(item, { priority, signal, extraArgs = [] } = {}) {
  const pr = await probe(item.videoPath);
  const actions = planActions(pr, priority);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wtv-'));
  const videoOut = path.join(dir, 'video.mp4');

  // --- video + selected audio track -> MP4 ---
  const audioMap = actions.audioTrackIndex != null ? `0:${actions.audioTrackIndex}` : '0:a:0?';
  const args = [
    '-hide_banner', '-y',
    '-i', item.videoPath,
    '-map', '0:v:0', '-map', audioMap,
    '-sn', // subtitles handled separately
    ...codecArgs(actions.action),
    '-movflags', '+faststart',
    ...extraArgs,
    videoOut,
  ];
  await runFfmpeg(args, signal);

  // --- subtitles: sidecar .srt (preferred) + embedded text tracks ---
  const subs = [];
  const seen = new Set();
  for (const s of item.subs || []) {
    if (seen.has(s.lang)) continue;
    const out = path.join(dir, `sub-${s.lang}.vtt`);
    try { srtToVtt(s.path, out); subs.push({ lang: s.lang, label: labelFor(s.lang), path: out }); seen.add(s.lang); }
    catch { /* skip unreadable sidecar */ }
  }
  for (const es of actions.embeddedSubs) {
    if (seen.has(es.lang)) continue;
    const out = path.join(dir, `emb-${es.lang}.vtt`);
    try {
      await runFfmpeg(['-hide_banner', '-y', '-i', item.videoPath, '-map', `0:${es.index}`, out], signal);
      if (existsSync(out)) { subs.push({ lang: es.lang, label: labelFor(es.lang), path: out }); seen.add(es.lang); }
    } catch { /* some embedded tracks won't extract cleanly; skip */ }
  }

  return {
    probe: pr,
    action: actions.action,
    audioLang: actions.audioLang,
    videoPath: videoOut,
    subs,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
