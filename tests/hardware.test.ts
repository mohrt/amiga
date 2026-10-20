import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Amiga } from '../src/amiga';
import { FRAME_WIDTH } from '../src/denise/denise';
import { FloppyDisk } from '../src/drive/adf';
import { localKickstart, machineWith, root, runSeconds, screenshot } from './helpers/machine';

// vAmigaTS (`npm run fetch:hw-tests`): bootable test disks for the chipset, each with a
// screenshot of the result from vAmiga, which is checked against real Amigas. They run on your
// Kickstart 1.3 in roms/, as the suite's own scripts do. HW=<ids> runs only some.
const dir = join(root, 'tests', 'fixtures', 'vamigats');
interface HardwareTest {
  id: string;
  group: string;
  seconds: number;
  setup: string;
}
const index: HardwareTest[] = existsSync(join(dir, 'index.json')) ? JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) : [];
const only = process.env.HW?.split(',').filter(Boolean);
/** The A500 setups; the others have the ECS Denise or AGA. */
const tests = index.filter((test) => ['A500_OCS_1MB', 'A500_ECS_1MB'].includes(test.setup) && (!only || only.includes(test.id)));
const rom = localKickstart('kick13.rom');

/** vAmiga's screenshots are 716 pixels by 285 lines, 22 hires pixels left of the picture here and 2 lines above it. */
const REFERENCE_WIDTH = 716;
const REFERENCE_LINES = 285;
const OFFSET_X = 22;
const OFFSET_LINES = 2;
/** vAmiga's colour levels differ a little from ×17. */
const TOLERANCE = 20;
/** The share of pixels that must match. */
const REQUIRED = 0.97;

/** The share of the reference's pixels this picture matches (vAmiga's checkerboard, where nothing was drawn, is left out). */
export function matchReference(amiga: Amiga, reference: Uint8Array): number {
  const { framebuffer, outputLines } = amiga.denise;
  let same = 0;
  let total = 0;
  for (let y = 0; y < REFERENCE_LINES; y++) {
    const line = y - OFFSET_LINES;
    if (line < 0 || line >= outputLines) continue;
    for (let x = 0; x < REFERENCE_WIDTH; x++) {
      const ourX = x - OFFSET_X;
      if (ourX < 0 || ourX >= FRAME_WIDTH) continue;
      const i = (y * REFERENCE_WIDTH + x) * 3;
      const r = reference[i];
      const g = reference[i + 1];
      const b = reference[i + 2];
      if (r === g && g === b && (r === 0x44 || r === 0x22)) continue;
      const pixel = framebuffer[line * 2 * FRAME_WIDTH + ourX];
      total++;
      if (
        Math.abs((pixel & 0xff) - r) <= TOLERANCE &&
        Math.abs(((pixel >> 8) & 0xff) - g) <= TOLERANCE &&
        Math.abs(((pixel >> 16) & 0xff) - b) <= TOLERANCE
      ) {
        same++;
      }
    }
  }
  return total ? same / total : 0;
}

/**
 * Tests from the default download (`npm run fetch:hw-tests`) whose pictures don't match yet,
 * mostly by a few cycles of DMA, interrupt or display-window timing. They are expected to
 * fail, so one that starts matching shows up (and should come off this list).
 */
const KNOWN_DIFFERENCES = new Set([
  'Agnus_Blitter_bbusy_bbusy0',
  'Agnus_Blitter_bususage_bususage0l',
  'Agnus_Blitter_cputim_cputim7',
  'Agnus_Copper_CopDma_cycleE0',
  'Agnus_Copper_coptim_coptim2',
  'Agnus_Copper_copvbl_copvbl4b',
  'Agnus_Copper_mask_waitmask6',
  'Agnus_DDF_DDF_hwstop1',
  'Agnus_DDF_DDF_oldhwstop3',
  'Agnus_DDF_DDFTIM_ddftimcpu10',
  'Agnus_DIW_OLDDIW_diw10',
  'Agnus_DIW_OLDDIW_diw5',
  'Agnus_Registers_BPLPTR_drop53',
  'Agnus_Registers_DMACON_bploncpu1',
  'Agnus_Registers_DMACON_sprenacpu3',
  'Denise_DIW_DIWH_diwsub',
  'Denise_DIW_DIWH_diwtim0',
  'Denise_DIW_DIWH_diwtim2',
  'Denise_DIW_DIWH_diwtim3b',
  'Denise_DIW_DIWH_minmax',
  'Denise_Modes_agascroll_agascroll6',
  'Denise_Registers_BPLCON0_invprio2',
  'Denise_Registers_BPLCON1_overscan1b',
  'Denise_Registers_BPLCON1_simple4',
  'Denise_Registers_BPLCON2_dualpf6',
  'Denise_Sprites_collision_sprcoll7',
  'Denise_Sprites_manual_manual1',
  'Denise_Sprites_spritedma_interfere2',
  'Paula_Interrupts_inttim_double12',
  'Paula_Interrupts_inttim_double6',
  'Paula_Interrupts_inttim_timcpu1',
  'Paula_Interrupts_irqbpl_irqbpl6b',
]);

describe.skipIf(tests.length === 0 || !rom)('vAmigaTS', () => {
  for (const test of tests) {
    const run = KNOWN_DIFFERENCES.has(test.id) ? it.fails : it;
    run(`${test.id} looks as on vAmiga`, () => {
      const amiga = machineWith(rom!);
      amiga.insertDisk(0, FloppyDisk.fromAdf(new Uint8Array(readFileSync(join(dir, `${test.id}.adf`))), test.id));
      runSeconds(amiga, test.seconds);
      screenshot(amiga, `hw-${test.id}`);
      const match = matchReference(amiga, new Uint8Array(readFileSync(join(dir, `${test.id}.raw`))));
      expect(match, `share of pixels matching vAmiga's screenshot`).toBeGreaterThanOrEqual(REQUIRED);
    }, 120_000);
  }
});
