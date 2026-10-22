import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Amiga } from '../src/amiga';
import { FloppyDisk } from '../src/drive/adf';
import { Joy } from '../src/io/ports';
import { colourCount, localKickstart, machineWith, root, runSeconds, screenshot } from './helpers/machine';

// Disk images are never committed. These run the free games (`npm run fetch:games` puts
// them in public/games/) and any of your own you put in disks/, on your Kickstart 1.3 in roms/.
const EXTENSION = /\.adf$/i;
// Games on the ACE engine hand the system back to Kickstart to load files, then take it over again
// with a CIA-B timer interrupt already pending; they hung on their logos when it was lost.
const aceGames = [
  { name: 'chaos-arena', memory: { chipKb: 512, slowKb: 512 }, menuSeconds: 75 },
  { name: 'germz', memory: { chipKb: 1024, slowKb: 0 }, menuSeconds: 110 },
] as const;
const aceDisks = new Set(aceGames.map((game) => `${game.name}.adf`));
const diskFiles = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((name) => EXTENSION.test(name)).map((name) => join(dir, name)) : [];
// The ACE games have their own test below, with the memory they need.
const disks = [...diskFiles(join(root, 'public', 'games')), ...diskFiles(join(root, 'disks'))].filter(
  (path) => !aceDisks.has(basename(path)),
);
const rom = localKickstart('kick13.rom');
const BOOT_SECONDS = Number(process.env.BOOT_SECONDS ?? 25);
const PLAY_SECONDS = Number(process.env.PLAY_SECONDS ?? 10);

describe.skipIf(disks.length === 0 || !rom)('games', () => {
  for (const path of disks) {
    const name = path.slice(path.lastIndexOf('/') + 1).replace(EXTENSION, '');
    it(`${name} boots, draws a picture and keeps running`, () => {
      const amiga = machineWith(rom!);
      amiga.insertDisk(0, FloppyDisk.fromAdf(new Uint8Array(readFileSync(path)), name));
      runSeconds(amiga, BOOT_SECONDS);
      screenshot(amiga, `${name} - title`);
      expect(colourCount(amiga), 'colours on the screen').toBeGreaterThan(1);
      // Press fire (both ports) and Return a few times, as a player would, then let it run.
      const frames = PLAY_SECONDS * 50;
      for (let frame = 0; frame < frames; frame++) {
        const pressing = frame % 50 < 5 && frame < 200;
        amiga.ports.joysticks[1].set('test', pressing ? Joy.Fire : 0);
        amiga.ports.mouseLeft = pressing && frame % 100 < 50;
        if (frame % 100 === 60 && frame < 200) amiga.keyboard.press(0x44);
        if (frame % 100 === 65 && frame < 200) amiga.keyboard.release(0x44);
        amiga.runFrame();
      }
      screenshot(amiga, `${name} - later`);
      expect(amiga.agnus.frames).toBeGreaterThanOrEqual((BOOT_SECONDS + PLAY_SECONDS) * 50 - 1);
    }, 300_000);
  }
});

describe.skipIf(!rom)('ACE games', () => {
  for (const game of aceGames) {
    const path = [join(root, 'disks', `${game.name}.adf`), join(root, 'public', 'games', `${game.name}.adf`)].find((candidate) =>
      existsSync(candidate),
    );
    it.skipIf(!path)(`${game.name} gets past its logos to the menu`, () => {
      const amiga = new Amiga();
      amiga.setKickstart(rom!);
      amiga.setMemory(game.memory);
      amiga.powerOn();
      amiga.insertDisk(0, FloppyDisk.fromAdf(new Uint8Array(readFileSync(path!)), game.name));
      runSeconds(amiga, game.menuSeconds);
      screenshot(amiga, `${game.name} - menu`);
      // The faded logo it hung on has two colours.
      expect(colourCount(amiga), 'colours on the screen').toBeGreaterThan(4);
    }, 300_000);
  }
});
