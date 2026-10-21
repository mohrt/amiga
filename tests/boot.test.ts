import { describe, expect, it } from 'vitest';
import { arosRoms, colourCount, localKickstart, machineWith, runSeconds, screenshot } from './helpers/machine';

// The free AROS ROMs are committed in tests/fixtures/aros/.
describe('booting AROS', () => {
  const aros = arosRoms();
  it.skipIf(!aros)('reaches its boot screen', () => {
    const amiga = machineWith(aros!.main, aros!.extended);
    runSeconds(amiga, 12);
    screenshot(amiga, 'AROS');
    expect(amiga.overlay).toBe(false);
    expect(colourCount(amiga), 'colours on screen').toBeGreaterThan(2);
  }, 120_000);
});

// Kickstarts are copyrighted and never committed: put your own in roms/ to run these.
const KICKSTARTS = [
  ['kick13.rom', 'Kickstart 1.3'],
  ['kick12.rom', 'Kickstart 1.2'],
  ['kick204.rom', 'Kickstart 2.04'],
  ['kick31.rom', 'Kickstart 3.1'],
] as const;

describe('booting a Kickstart from roms/', () => {
  for (const [file, name] of KICKSTARTS) {
    const rom = localKickstart(file);
    it.skipIf(!rom)(`${name} reaches the insert-disk screen`, () => {
      const amiga = machineWith(rom!);
      runSeconds(amiga, 8);
      screenshot(amiga, `${name} - insert disk`);
      expect(colourCount(amiga), 'colours on screen').toBeGreaterThan(2);
      // Exec has taken over memory and the display is running from a Copper list.
      expect(amiga.overlay).toBe(false);
      expect(amiga.agnus.dmacon & 0x0200).not.toBe(0);
    }, 120_000);
  }
});
