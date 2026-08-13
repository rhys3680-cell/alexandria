import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Makes sure the Electron binary is actually on disk after an install.
 *
 * pnpm strips a package's install scripts when its build is not allowed, and it
 * does that at extraction time — so a store entry created before `allowBuilds`
 * listed electron keeps `scripts: null` forever. Re-enabling the build does not
 * help, because `pnpm rebuild` then has nothing to run, and the failure only
 * surfaces later as a bare "Error: Electron uninstall" from electron-vite.
 *
 * Running electron's own installer is idempotent and cheap: it reuses the
 * download cache when the archive is already there.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDir = path.join(root, 'node_modules', 'electron');

if (!fs.existsSync(electronDir)) {
  // Electron is a devDependency of the desktop app only; a consumer install
  // without it is fine.
  process.exit(0);
}

function installed() {
  const pointer = path.join(electronDir, 'path.txt');
  if (!fs.existsSync(pointer)) return false;
  const relative = fs.readFileSync(pointer, 'utf8').trim();
  return relative.length > 0 && fs.existsSync(path.join(electronDir, 'dist', relative));
}

if (installed()) process.exit(0);

console.log('electron 바이너리가 없어 설치합니다...');
try {
  execFileSync(process.execPath, [path.join(electronDir, 'install.js')], {
    cwd: electronDir,
    stdio: 'inherit',
  });
} catch (error) {
  console.error(`electron 설치에 실패했습니다: ${error.message}`);
  console.error(`직접 실행해 보세요: node ${path.join('node_modules', 'electron', 'install.js')}`);
  process.exit(1);
}

if (!installed()) {
  console.error('설치 스크립트는 끝났지만 바이너리를 찾지 못했습니다.');
  process.exit(1);
}
console.log('electron 준비 완료');
