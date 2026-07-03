import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Resolve ffmpeg/ffprobe once. Order: FFMPEG_DIR env → WinGet install → PATH.
function resolveDir() {
  const fromEnv = process.env.FFMPEG_DIR;
  if (fromEnv && existsSync(path.join(fromEnv, 'ffprobe.exe'))) return fromEnv;

  const winget = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft/WinGet/Packages',
  );
  if (existsSync(winget)) {
    for (const pkg of readdirSync(winget)) {
      if (!/ffmpeg/i.test(pkg)) continue;
      const base = path.join(winget, pkg);
      // .../ffmpeg-<ver>-full_build/bin/ffprobe.exe
      for (const sub of readdirSync(base)) {
        const bin = path.join(base, sub, 'bin');
        if (existsSync(path.join(bin, 'ffprobe.exe'))) return bin;
      }
    }
  }
  return null; // fall back to PATH
}

const dir = resolveDir();

export const FFPROBE = dir ? path.join(dir, 'ffprobe.exe') : 'ffprobe';
export const FFMPEG = dir ? path.join(dir, 'ffmpeg.exe') : 'ffmpeg';

// Sanity export so callers can surface a clear error.
export function assertFfmpeg() {
  if (FFPROBE !== 'ffprobe' && !existsSync(FFPROBE)) {
    throw new Error(`ffprobe not found at ${FFPROBE}. Set FFMPEG_DIR in .env.`);
  }
}

export { statSync };
