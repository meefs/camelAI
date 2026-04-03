import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, '..');
const repoRoot = resolve(desktopDirectory, '..');
const svgIconPath = resolve(repoRoot, 'public/favicon.svg');
const buildDirectory = resolve(desktopDirectory, 'build');
const pngIconPath = resolve(buildDirectory, 'icon.png');
const icoIconPath = resolve(buildDirectory, 'icon.ico');
const icnsIconPath = resolve(buildDirectory, 'icon.icns');

const iconsetEntries = [
  { name: 'icon_16x16.png', size: 16 },
  { name: 'icon_16x16@2x.png', size: 32 },
  { name: 'icon_32x32.png', size: 32 },
  { name: 'icon_32x32@2x.png', size: 64 },
  { name: 'icon_128x128.png', size: 128 },
  { name: 'icon_128x128@2x.png', size: 256 },
  { name: 'icon_256x256.png', size: 256 },
  { name: 'icon_256x256@2x.png', size: 512 },
  { name: 'icon_512x512.png', size: 512 },
  { name: 'icon_512x512@2x.png', size: 1024 },
];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 1}.`);
  }
}

async function main() {
  if (!existsSync(svgIconPath)) {
    throw new Error(`Missing icon source at ${svgIconPath}`);
  }

  mkdirSync(buildDirectory, { recursive: true });

  const svgBuffer = readFileSync(svgIconPath);
  const masterPng = await sharp(svgBuffer)
    .resize(1024, 1024, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  writeFileSync(pngIconPath, masterPng);

  const tempDirectory = mkdtempSync(resolve(tmpdir(), 'camelai-iconset-'));
  const iconsetDirectory = resolve(tempDirectory, 'icon.iconset');
  mkdirSync(iconsetDirectory, { recursive: true });

  try {
    for (const entry of iconsetEntries) {
      await sharp(masterPng).resize(entry.size, entry.size).png().toFile(resolve(iconsetDirectory, entry.name));
    }

    run('iconutil', ['-c', 'icns', iconsetDirectory, '-o', icnsIconPath]);
    const icoBuffer = await pngToIco([masterPng]);
    writeFileSync(icoIconPath, icoBuffer);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

await main();
