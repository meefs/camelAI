#!/usr/bin/env node
/**
 * Generates all favicon variants from the source SVG.
 *
 * Usage: node scripts/generate-favicons.mjs
 *
 * Outputs to public/:
 *   - favicon-16x16.png
 *   - favicon-32x32.png
 *   - apple-touch-icon.png (180x180)
 *   - android-chrome-192x192.png
 *   - android-chrome-512x512.png
 *   - favicon.ico (multi-resolution: 16, 32, 48)
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

// Read the source SVG (Figma export with texture)
const svgPath = join(publicDir, 'favicon.svg');
const svgContent = readFileSync(svgPath, 'utf-8');

const sizes = [
  { name: 'favicon-16x16.png', size: 16 },
  { name: 'favicon-32x32.png', size: 32 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'android-chrome-192x192.png', size: 192 },
  { name: 'android-chrome-512x512.png', size: 512 },
];

// Sizes for ICO file
const icoSizes = [16, 32, 48];

async function renderSvgToPng(svg, size) {
  // Render SVG at higher resolution then resize for better quality
  // The SVG viewBox is 260x260
  const renderSize = Math.max(512, size * 4);
  const resvg = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: renderSize,
    },
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  // Resize to target size with sharp
  const resized = await sharp(pngBuffer)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer();

  return resized;
}

async function main() {
  console.log('Generating favicons from', svgPath);

  // Generate all PNG sizes
  for (const { name, size } of sizes) {
    console.log(`  Generating ${name} (${size}x${size})...`);
    const pngBuffer = await renderSvgToPng(svgContent, size);
    writeFileSync(join(publicDir, name), pngBuffer);
  }

  // Generate ICO file (multi-resolution)
  console.log('  Generating favicon.ico (16, 32, 48)...');
  const icoBuffers = await Promise.all(
    icoSizes.map((size) => renderSvgToPng(svgContent, size))
  );
  const icoBuffer = await pngToIco(icoBuffers);
  writeFileSync(join(publicDir, 'favicon.ico'), icoBuffer);

  console.log('Done! Generated files:');
  console.log('  - favicon.svg (source from Figma)');
  for (const { name } of sizes) {
    console.log(`  - ${name}`);
  }
  console.log('  - favicon.ico');
}

main().catch(console.error);
