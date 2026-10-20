import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FloppyDisk } from '../src/drive/adf';
import { Joy } from '../src/io/ports';
import { colourCount, localKickstart, machineWith, root, runSeconds, screenshot } from './helpers/machine';

// Disk images are never committed. These run the free games (`npm run fetch:games` puts
// them in public/games/) and any of your own you put in disks/, on your Kickstart 1.3 in roms/.
const EXTENSION = /\.adf$/i;
const diskFiles = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((name) => EXTENSION.test(name)).map((name) => join(dir, name)) : [];
const disks = [...diskFiles(join(root, 'public', 'games')), ...diskFiles(join(root, 'disks'))];
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
