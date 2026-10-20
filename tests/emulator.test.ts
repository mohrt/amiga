import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FloppyDisk } from '../src/drive/adf';
import { Emulator } from '../src/emulator';
import { Joy } from '../src/io/ports';
import type { Screen } from '../src/render/screen';
import { localKickstart, root } from './helpers/machine';

const rom = localKickstart('kick13.rom');
const game = join(root, 'public', 'games', 'space-invaders.adf');

describe('fast loading', () => {
  it.skipIf(!rom || !existsSync(game))('stops once the game has loaded, though it leaves the drive motor on', () => {
    const emulator = new Emulator({ capture: () => {} } as unknown as Screen);
    const { amiga } = emulator;
    amiga.setKickstart(rom!);
    amiga.powerOn();
    amiga.insertDisk(0, FloppyDisk.fromAdf(new Uint8Array(readFileSync(game)), 'space-invaders.adf'));
    let loadedAtSomePoint = false;
    for (let frame = 0; frame < 40 * 50; frame++) {
      amiga.runFrame();
      loadedAtSomePoint ||= emulator.loading;
    }
    expect(loadedAtSomePoint).toBe(true);
    expect(amiga.drives[0].motor).toBe(true);
    expect(emulator.loading).toBe(false);
    // Fire starts a game, which makes sound.
    amiga.paula.audio.takeSamples();
    for (let frame = 0; frame < 250; frame++) {
      amiga.ports.joysticks[1].set('test', frame % 25 < 5 ? Joy.Fire : 0);
      amiga.runFrame();
    }
    expect(amiga.paula.audio.takeSamples().some((sample) => Math.abs(sample) > 0.001)).toBe(true);
  }, 120_000);
});
