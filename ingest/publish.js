import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';

// Copy a produced file into the local media library at its catalog key
// (e.g. "series/monster/s01e01/video.mp4"). Returns the absolute path.
export function publishFile(srcPath, relKey) {
  const root = process.env.MEDIA_ROOT;
  if (!root) throw new Error('MEDIA_ROOT not set (local media folder).');
  const dest = path.join(root, relKey);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(srcPath, dest);
  return dest;
}
