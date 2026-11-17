// Generates PWA icons from the SONU mark. Run: npm run icons
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

mkdirSync('public/icons', { recursive: true });
const glyph = (size, pad) => {
  const s = size - pad * 2;
  return `<g transform="translate(${pad} ${pad}) scale(${s / 64})"><path d="M42 21.5c-2.4-3-6-4.5-10.2-4.5-6 0-10 3.2-10 8 0 11 21 6.6 21 15.5 0 4.4-4.2 7.5-10.6 7.5-4.6 0-8.6-1.7-11.2-5" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/><circle cx="46" cy="17" r="3.5" fill="#ffc857"/></g>`;
};
const svg = (size, radius, pad) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="#3b4cca"/>${glyph(size, pad)}</svg>`;

const jobs = [
  ['public/icons/icon-192.png', 192, 192 * 0.25, 192 * 0.1],
  ['public/icons/icon-512.png', 512, 512 * 0.25, 512 * 0.1],
  // maskable: full-bleed square, glyph inside the 80% safe zone
  ['public/icons/maskable-512.png', 512, 0, 512 * 0.2],
];
for (const [file, size, radius, pad] of jobs) {
  await sharp(Buffer.from(svg(size, radius, pad))).png().toFile(file);
  console.log('wrote', file);
}
