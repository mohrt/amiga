// Downloads tests from Dirk Hoffmann's vAmiga test suite (vAmigaTS, GPL v3) into
// tests/fixtures/vamigats/: bootable disks that exercise the chipset, each with a screenshot of
// the result from vAmiga, a cycle-exact emulator checked against real Amigas. Not committed.
// By default a few tests from each chipset group; `npm run fetch:hw-tests -- 30` takes up to 30
// per group, `-- all` every chipset test, and `-- aga` every one with an A1200 (AGA) screenshot.
// Each run adds to the tests fetched before.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = 'bdbc379862f5a1de6f5e9c8c298597c0079a4942';
const RAW = `https://raw.githubusercontent.com/dirkwhoffmann/vAmigaTS/${COMMIT}`;
const TREE = `https://api.github.com/repos/dirkwhoffmann/vAmigaTS/git/trees/${COMMIT}?recursive=1`;
/**
 * The chipset's groups; the CPU groups test timing this emulator doesn't model. CIA/CIA's tests
 * only have TIFF screenshots of a different cutout, so none of them are taken yet.
 */
const GROUPS = [
  'Agnus/Blitter',
  'Agnus/Copper',
  'Agnus/DDF',
  'Agnus/DIW',
  'Agnus/Registers',
  'CIA/CIA',
  'Denise/DIW',
  'Denise/Modes',
  'Denise/Registers',
  'Denise/Sprites',
  'Paula/Interrupts',
];

const argument = process.argv[2] ?? '6';
/** `aga` takes every test with an A1200 (AGA) screenshot, and nothing else. */
const agaOnly = argument === 'aga';
const perGroup = argument === 'all' || agaOnly ? Infinity : Number(argument);
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'vamigats');
await mkdir(outDir, { recursive: true });

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

const tree = JSON.parse((await download(TREE)).toString('utf8')).tree;
const paths = tree.map((entry) => entry.path);
const folderOf = (path) => path.slice(0, path.lastIndexOf('/'));
/** The file in a test's folder with this extension (the names don't always match the folder's). */
const fileIn = (folder, extension) => paths.find((path) => folderOf(path) === folder && path.endsWith(`.${extension}`));
/**
 * A test folder's scripts. Many folders have one per chipset (`_ocs`, `_ecs`, `_aga`, `_plus`),
 * each with its own screenshot of the same name: the OCS one (or the only one) is the A500's,
 * and an `_aga` one is the A1200's.
 */
function scriptsFor(folder) {
  const scripts = paths.filter((path) => folderOf(path) === folder && path.endsWith('.retrosh')).sort();
  const a500 = scripts.find((path) => path.endsWith('_ocs.retrosh')) ?? scripts.find((path) => !/_(aga|plus)\.retrosh$/.test(path));
  const a1200 = scripts.find((path) => path.endsWith('_aga.retrosh'));
  return { a500, a1200 };
}
const tests = [];
for (const group of GROUPS) {
  let folders = [...new Set(paths.filter((path) => path.startsWith(`${group}/`) && path.endsWith('.retrosh')).map(folderOf))].sort();
  if (agaOnly) folders = folders.filter((folder) => scriptsFor(folder).a1200);
  // Spread the picks over the group's subfolders.
  const step = Math.max(1, Math.floor(folders.length / Math.min(perGroup, folders.length)));
  for (let i = 0; i < folders.length && tests.filter((test) => test.group === group && !test.aga).length < perGroup; i += step) {
    const folder = folders[i];
    const name = folder.split('/').pop();
    const adf = fileIn(folder, 'adf');
    const { a500, a1200 } = scriptsFor(folder);
    for (const script of agaOnly ? [a1200] : [a500, a1200]) {
      if (!script) continue;
      const sameName = script.replace(/\.retrosh$/, '.raw');
      const raw = paths.includes(sameName) ? sameName : script === a500 ? fileIn(folder, 'raw') : null;
      if (adf && raw) tests.push({ group, folder, name, script, adf, raw, aga: script === a1200 });
    }
  }
}

/** The setups the tests run on: the A500's, and the A1200's. */
const SETUPS = ['A500_OCS_1MB', 'A500_ECS_1MB', 'A1200_2MB'];

const index = [];
for (const test of tests) {
  const id = `${test.folder.replaceAll('/', '_')}${test.aga ? '_aga' : ''}`;
  const script = (await download(`${RAW}/${test.script}`)).toString('utf8');
  const seconds = Number(/wait\s+(\d+)\s+seconds/.exec(script)?.[1] ?? 7);
  const setup = /regression setup\s+(\S+)/.exec(script)?.[1] ?? 'A500_OCS_1MB';
  if (!SETUPS.includes(setup)) continue;
  for (const extension of ['adf', 'raw']) {
    // The AGA test runs the A500 test's disk.
    const target = join(outDir, extension === 'adf' ? `${id.replace(/_aga$/, '')}.adf` : `${id}.raw`);
    if (!existsSync(target)) await writeFile(target, await download(`${RAW}/${test[extension]}`));
  }
  index.push({ id, group: test.group, name: test.name, seconds, setup });
  console.log(`Saved ${id}`);
}
// Tests fetched before (another sample, or the AGA ones) stay in the index.
const indexPath = join(outDir, 'index.json');
const earlier = existsSync(indexPath) ? JSON.parse(await readFile(indexPath, 'utf8')) : [];
const merged = [...earlier.filter((test) => !index.some((fresh) => fresh.id === test.id)), ...index];
await writeFile(indexPath, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`${index.length} tests fetched, ${merged.length} in tests/fixtures/vamigats/index.json`);
