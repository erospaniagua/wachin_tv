import { readFileSync, writeFileSync } from 'node:fs';

// Convert a sidecar .srt to WebVTT. Handles UTF-8 or Latin-1 source encoding.
export function srtToVtt(srtPath, outPath) {
  const buf = readFileSync(srtPath);
  let text = buf.toString('utf8');
  if (text.includes('�')) text = buf.toString('latin1'); // bad UTF-8 → try Latin-1
  const body = text
    .replace(/^﻿/, '') // strip BOM
    .replace(/\r+/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2'); // SRT comma → VTT dot
  writeFileSync(outPath, 'WEBVTT\n\n' + body, 'utf8');
}

const LABELS = { en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano', pt: 'Português', ja: '日本語', und: 'Unknown' };
export const labelFor = (lang) => LABELS[lang] || lang.toUpperCase();
