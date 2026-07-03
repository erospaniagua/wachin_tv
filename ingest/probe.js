import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FFPROBE } from './ffbin.js';

const run = promisify(execFile);

// Normalize assorted language codes to ISO 639-1 (2-letter) where we can.
const LANG_MAP = {
  eng: 'en', en: 'en', spa: 'es', esp: 'es', es: 'es', lat: 'es',
  fre: 'fr', fra: 'fr', fr: 'fr', ger: 'de', deu: 'de', de: 'de',
  ita: 'it', it: 'it', por: 'pt', pt: 'pt', jpn: 'ja', ja: 'ja',
};
export const normLang = (l) => (l ? LANG_MAP[l.toLowerCase()] || l.toLowerCase() : null);

// Run ffprobe and return a compact, structured view of the streams.
export async function probe(file) {
  const { stdout } = await run(
    FFPROBE,
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    { maxBuffer: 1024 * 1024 * 16 },
  );
  const data = JSON.parse(stdout);
  const streams = data.streams || [];

  const video = streams.find((s) => s.codec_type === 'video' && s.codec_name !== 'mjpeg');
  const audios = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name,
      channels: s.channels || null,
      lang: normLang(s.tags?.language),
      title: s.tags?.title || null,
      default: s.disposition?.default === 1,
    }));
  const subs = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name,
      lang: normLang(s.tags?.language),
      title: s.tags?.title || null,
    }));

  return {
    container: data.format?.format_name || null,
    durationSec: data.format?.duration ? Math.round(+data.format.duration) : null,
    sizeBytes: data.format?.size ? +data.format.size : null,
    video: video
      ? { codec: video.codec_name, width: video.width, height: video.height }
      : null,
    audios,
    subs,
  };
}
