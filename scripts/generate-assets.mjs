// Render SVG sources in /resources to PNG, then generate platform variants via @capacitor/assets.
// Run: npm run assets

import sharp from 'sharp';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const resources = resolve(root, 'resources');
const faviconOut = resolve(root, 'src/assets/icon/favicon.png');

// SVG sources → required PNG names + sizes for @capacitor/assets
const targets = [
  { svg: 'icon-only.svg',       png: 'icon-only.png',       size: 1024 },
  { svg: 'icon-foreground.svg', png: 'icon-foreground.png', size: 1024 },
  { svg: 'icon-background.svg', png: 'icon-background.png', size: 1024 },
  { svg: 'splash.svg',          png: 'splash.png',          size: 2732 },
];

for (const t of targets) {
  const svgPath = resolve(resources, t.svg);
  const pngPath = resolve(resources, t.png);
  if (!existsSync(svgPath)) {
    console.error(`✗ missing source: ${svgPath}`);
    process.exit(1);
  }
  const svg = readFileSync(svgPath);
  await sharp(svg, { density: 384 })
    .resize(t.size, t.size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(pngPath);
  console.log(`✓ resources/${t.png} (${t.size}×${t.size})`);
}

// Also (re)generate the web favicon from icon-only at 256px
mkdirSync(dirname(faviconOut), { recursive: true });
await sharp(readFileSync(resolve(resources, 'icon-only.svg')), { density: 384 })
  .resize(256, 256)
  .png()
  .toFile(faviconOut);
console.log(`✓ src/assets/icon/favicon.png (256×256)`);

// Then hand off to @capacitor/assets. It generates only for platforms that exist
// (ios/, android/), and PWA assets are written under src/assets/.
const args = ['@capacitor/assets', 'generate', '--assetPath', 'resources'];
if (existsSync(resolve(root, 'ios')))     args.push('--ios');
if (existsSync(resolve(root, 'android'))) args.push('--android');
args.push('--pwa');

console.log(`\n→ npx ${args.join(' ')}\n`);
const result = spawnSync('npx', args, { stdio: 'inherit', shell: true, cwd: root });
process.exit(result.status ?? 0);
