// Downloads the free AROS replacement ROMs (AROS Public License, https://aros.sourceforge.io/license.html)
// into tests/fixtures/aros/, for the tests only: the site never offers a system ROM. They come from
// the Internet Archive's copy of the AROS m68k build, checked against these checksums.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://emularity-bios.ux-b.archive.org';
const FILES = [
  { from: 'aros-amiga-m68k-rom.bin', to: 'aros-rom.bin', sha256: 'd2a6971f476be577ccc0530bbcca8805d8b88bf0d2c51e61086c40a5ab626df6' },
  { from: 'aros-amiga-m68k-ext.bin', to: 'aros-ext.bin', sha256: 'aadeec434309e8e76702d33c894758f58a63a2b588ee6f6d5329858f6e98d988' },
];

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'aros');
await mkdir(outDir, { recursive: true });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

for (const file of FILES) {
  const target = join(outDir, file.to);
  if (existsSync(target) && sha256(await readFile(target)) === file.sha256) continue;
  const response = await fetch(`${SOURCE}/${file.from}`);
  if (!response.ok) {
    console.error(`Download of ${file.from} failed: ${response.status} ${response.statusText}`);
    process.exit(1);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== file.sha256) {
    console.error(`${file.from} has changed (checksum mismatch); not using it.`);
    process.exit(1);
  }
  await writeFile(target, bytes);
  console.log(`Saved tests/fixtures/aros/${file.to}`);
}
