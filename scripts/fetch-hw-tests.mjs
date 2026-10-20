// Downloads tests from Dirk Hoffmann's vAmiga test suite (vAmigaTS, GPL v3) into
// tests/fixtures/vamigats/: bootable disks that exercise the chipset, each with a screenshot of
// the result from vAmiga, a cycle-exact emulator checked against real Amigas. Not committed.
// By default a few tests from each chipset group; `npm run fetch:hw-tests -- 30` takes up to 30
// per group, and `-- all` every chipset test.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = 'bdbc379862f5a1de6f5e9c8c298597c0079a4942';
const RAW = `https://raw.githubusercontent.com/dirkwhoffmann/vAmigaTS/${COMMIT}`;
const TREE = `https://api.github.com/repos/dirkwhoffmann/vAmigaTS/git/trees/${COMMIT}?recursive=1`;
/** The chipset's groups; the CPU groups test timing this emulator doesn't model. */
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
const perGroup = argument === 'all' ? Infinity : Number(argument);
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'vamigats');
await mkdir(outDir, { recursive: true });

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

const tree = JSON.parse((await download(TREE)).toString('utf8')).tree;
const paths = tree.map((entry) => entry.path);
const scripts = paths.filter((path) => path.endsWith('.retrosh'));
/** The file in a test's folder with this extension (the names don't always match the folder's). */
const fileIn = (folder, extension) => paths.find((path) => path.startsWith(`${folder}/`) && path.endsWith(`.${extension}`) && !path.slice(folder.length + 1).includes('/'));
const tests = [];
for (const group of GROUPS) {
  const inGroup = scripts.filter((path) => path.startsWith(`${group}/`)).sort();
  // Spread the picks over the group's subfolders.
  const step = Math.max(1, Math.floor(inGroup.length / Math.min(perGroup, inGroup.length)));
  for (let i = 0; i < inGroup.length && tests.filter((test) => test.group === group).length < perGroup; i += step) {
    const script = inGroup[i];
    const folder = script.slice(0, script.lastIndexOf('/'));
    const name = folder.split('/').pop();
    const adf = fileIn(folder, 'adf');
    const raw = fileIn(folder, 'raw');
    if (adf && raw) tests.push({ group, folder, name, script, adf, raw });
  }
}

/** The A500 setups; the others have the ECS Denise or AGA. */
const A500_SETUPS = ['A500_OCS_1MB', 'A500_ECS_1MB'];

const index = [];
for (const test of tests) {
  const id = `${test.folder.replaceAll('/', '_')}`;
  const script = (await download(`${RAW}/${test.script}`)).toString('utf8');
  const seconds = Number(/wait\s+(\d+)\s+seconds/.exec(script)?.[1] ?? 7);
  const setup = /regression setup\s+(\S+)/.exec(script)?.[1] ?? 'A500_OCS_1MB';
  if (!A500_SETUPS.includes(setup)) continue;
  for (const extension of ['adf', 'raw']) {
    const target = join(outDir, `${id}.${extension}`);
    if (!existsSync(target)) await writeFile(target, await download(`${RAW}/${test[extension]}`));
  }
  index.push({ id, group: test.group, name: test.name, seconds, setup });
  console.log(`Saved ${id}`);
}
await writeFile(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`${index.length} tests in tests/fixtures/vamigats/index.json`);
