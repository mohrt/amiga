import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Amiga } from '../src/amiga';
import { FRAME_WIDTH } from '../src/denise/denise';
import { FloppyDisk } from '../src/drive/adf';
import { a1200With, localKickstart, machineWith, root, runSeconds, screenshot } from './helpers/machine';
import { rgbPng } from './helpers/png';

// vAmigaTS (`npm run fetch:hw-tests`): bootable test disks for the chipset, each with a
// screenshot of the result from vAmiga, which is checked against real Amigas. They run on your
// Kickstart 1.3 in roms/, as the suite's own scripts do. HW=<ids> runs only some.
// HW_REPORT=1 prints each test's match and where it differs; with SHOTS=<dir> it also saves
// hw-<id>-compare.png: this emulator's picture, vAmiga's, and the differing pixels in red.
const dir = join(root, 'tests', 'fixtures', 'vamigats');
interface HardwareTest {
  id: string;
  group: string;
  seconds: number;
  setup: string;
}
const index: HardwareTest[] = existsSync(join(dir, 'index.json')) ? JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) : [];
const only = process.env.HW?.split(',').filter(Boolean);
/** The A500 setups, and vAmiga's A1200 (a 68EC020 and AGA, with 2 MB of chip RAM and Kickstart 1.3 too). */
const tests = index.filter((test) => ['A500_OCS_1MB', 'A500_ECS_1MB', 'A1200_2MB'].includes(test.setup) && (!only || only.includes(test.id)));
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
/**
 * Some of the screenshots were taken with vAmiga's gamma correction on (from 2.8 to 2.2), which
 * also tops out at $EC: the comparison tries the plain levels and these and keeps the better.
 */
const GAMMA_LEVELS = Uint8Array.from({ length: 256 }, (_, v) => Math.round(0xec * (v / 255) ** (2.8 / 2.2)));
const PLAIN_LEVELS = Uint8Array.from({ length: 256 }, (_, v) => v);

interface Comparison {
  /** The share of the reference's pixels this picture matches. */
  match: number;
  /** Per reference pixel: 0 not compared (vAmiga's checkerboard, or outside this picture), 1 same, 2 different. */
  verdicts: Uint8Array;
}

/** Compares the picture with vAmiga's, in whichever of its palettes fits better. */
function compareWithReference(amiga: Amiga, reference: Uint8Array): Comparison {
  const plain = compareInLevels(amiga, reference, PLAIN_LEVELS);
  const gamma = compareInLevels(amiga, reference, GAMMA_LEVELS);
  return gamma.match > plain.match ? gamma : plain;
}

/** Compares the picture, its colour levels mapped through `levels`, with vAmiga's (its checkerboard, where nothing was drawn, is left out). */
function compareInLevels(amiga: Amiga, reference: Uint8Array, levels: Uint8Array): Comparison {
  const { framebuffer, outputLines } = amiga.denise;
  const verdicts = new Uint8Array(REFERENCE_WIDTH * REFERENCE_LINES);
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
      const matches =
        Math.abs(levels[pixel & 0xff] - r) <= TOLERANCE &&
        Math.abs(levels[(pixel >> 8) & 0xff] - g) <= TOLERANCE &&
        Math.abs(levels[(pixel >> 16) & 0xff] - b) <= TOLERANCE;
      if (matches) same++;
      verdicts[y * REFERENCE_WIDTH + x] = matches ? 1 : 2;
    }
  }
  return { match: total ? same / total : 0, verdicts };
}

/** Where the differing pixels are: the reference lines and columns they span, and how many lines have any. */
function describeDifferences({ verdicts }: Comparison): string {
  let top = -1;
  let bottom = -1;
  let left = REFERENCE_WIDTH;
  let right = -1;
  let lines = 0;
  for (let y = 0; y < REFERENCE_LINES; y++) {
    let any = false;
    for (let x = 0; x < REFERENCE_WIDTH; x++) {
      if (verdicts[y * REFERENCE_WIDTH + x] !== 2) continue;
      any = true;
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
    if (!any) continue;
    lines++;
    if (top < 0) top = y;
    bottom = y;
  }
  return top < 0 ? 'no differences' : `lines ${top}-${bottom} (${lines} with differences), columns ${left}-${right}`;
}

/** This emulator's picture over vAmiga's over the differing pixels (red), at the reference's size. */
function comparisonPng(amiga: Amiga, reference: Uint8Array, { verdicts }: Comparison): Uint8Array {
  const { framebuffer, outputLines } = amiga.denise;
  const size = REFERENCE_WIDTH * REFERENCE_LINES;
  const rgb = new Uint8Array(size * 3 * 3);
  for (let y = 0; y < REFERENCE_LINES; y++) {
    const line = y - OFFSET_LINES;
    for (let x = 0; x < REFERENCE_WIDTH; x++) {
      const i = y * REFERENCE_WIDTH + x;
      const ourX = x - OFFSET_X;
      if (line >= 0 && line < outputLines && ourX >= 0 && ourX < FRAME_WIDTH) {
        const pixel = framebuffer[line * 2 * FRAME_WIDTH + ourX];
        rgb.set([pixel & 0xff, (pixel >> 8) & 0xff, (pixel >> 16) & 0xff], i * 3);
      }
      rgb.set(reference.subarray(i * 3, i * 3 + 3), (size + i) * 3);
      const verdict = verdicts[i];
      rgb.set(verdict === 2 ? [0xff, 0, 0] : verdict === 1 ? [0x30, 0x30, 0x30] : [0, 0, 0], (2 * size + i) * 3);
    }
  }
  return rgbPng(REFERENCE_WIDTH, REFERENCE_LINES * 3, rgb);
}

/**
 * Tests from the default download (`npm run fetch:hw-tests`) whose pictures don't match yet, with
 * the reason. They are expected to fail, so one that starts matching shows up (and should come off
 * this list).
 */
const CPU_ACCESS_ORDER =
  "the 68000 core doesn't yet place every instruction's bus accesses where the real CPU does (only branches, returns and interrupts follow its order), so CPU-timed code ends a cycle or two off";
const POINTER_DROP = 'BPLxPT written while its plane is being fetched: the old and new pointer meet differently';
const SPRITE_DMA = 'sprite DMA and drawing when sprites are re-armed, blocked or switched in the middle of a line';
const FMODE2_REFERENCE =
  "vAmiga's picture for FMODE 2 disagrees with the photo of a real A1200 in vAmigaTS, which this emulator's picture matches";
const CPU020_TIMING = "the 68EC020 runs on 68000 instruction timings (scaled to its clock), without its cache or its own cycle counts";
const KNOWN_DIFFERENCES = new Map([
  ['Agnus_Copper_copvbl_copvbl4', CPU_ACCESS_ORDER],
  ['Agnus_Copper_copvbl_copvbl2c', CPU_ACCESS_ORDER],
  ['Paula_Interrupts_irqbpl_irqbpl5b', CPU_ACCESS_ORDER],
  ['Paula_Interrupts_inttim_inttim1', CPU_ACCESS_ORDER],
  ['Paula_Interrupts_inttim_inttim3', CPU_ACCESS_ORDER],
  ['Paula_Interrupts_inttim_double1', CPU_ACCESS_ORDER],
  ['Paula_Interrupts_inttim_double8', CPU_ACCESS_ORDER],
  ['Paula_Interrupts_inttim_double13', CPU_ACCESS_ORDER],
  ['Agnus_Registers_DMACON_sprenacpu3', CPU_ACCESS_ORDER],
  ['Agnus_Registers_BPLPTR_dropcpu43', CPU_ACCESS_ORDER],
  ['Agnus_Registers_BPLPTR_dropcpu64', CPU_ACCESS_ORDER],
  ['Agnus_Blitter_bltint_bltint7', CPU_ACCESS_ORDER],
  ['Agnus_Blitter_bususage_bususage12', CPU_ACCESS_ORDER],
  ['Agnus_Blitter_race_race14', CPU_ACCESS_ORDER],
  ['Agnus_Registers_VPOS_probe5', CPU_ACCESS_ORDER],
  ['Agnus_Registers_BPLPTR_drop31', POINTER_DROP],
  ['Agnus_Registers_BPLPTR_drop43', POINTER_DROP],
  ['Agnus_Registers_BPLPTR_drop54', POINTER_DROP],
  ['Agnus_Registers_BPLPTR_drop64', POINTER_DROP],
  ['Agnus_Registers_DMACON_sprenacop1', SPRITE_DMA],
  ['Agnus_Registers_DMACON_sprdiscop2', SPRITE_DMA],
  ['Denise_Sprites_blocked_blocked4', SPRITE_DMA],
  ['Denise_Sprites_collision_sprcoll8', SPRITE_DMA],
  ['Denise_Sprites_spritedma_interfere1', SPRITE_DMA],
  ['Denise_Sprites_spritedma_interfere3', SPRITE_DMA],
  ['Denise_Sprites_manual_vblen1', SPRITE_DMA],
  ['Agnus_Copper_oldJump_jump3a', 'a COPJMP from the CPU while the Copper is in the middle of an instruction'],
  ['Agnus_Copper_Wait_waitblt3', 'the Copper waking from a blitter wait as the blit ends'],
  ['Agnus_DIW_DIWV_diwvmras', 'bitplane data written by hand outside the vertical window'],
  ['Agnus_Registers_FMODE_fmode10_aga', FMODE2_REFERENCE],
  ['Agnus_Registers_FMODE_fmode10c_aga', FMODE2_REFERENCE],
  ['Agnus_Registers_FMODE_fmode10d_aga', FMODE2_REFERENCE],
  ['Agnus_Registers_FMODE_fmode10e_aga', FMODE2_REFERENCE],
  ['Agnus_Blitter_cputim_invisible5f_aga', CPU020_TIMING],
  ['Agnus_Blitter_cputim_invisible11_aga', CPU020_TIMING],
  ['Agnus_Blitter_cputim_invisible13_aga', CPU020_TIMING],
  ['Agnus_Blitter_cputim_invisible15_aga', CPU020_TIMING],
]);

describe.skipIf(tests.length === 0 || !rom)('vAmigaTS', () => {
  for (const test of tests) {
    const run = KNOWN_DIFFERENCES.has(test.id) ? it.fails : it;
    run(`${test.id} looks as on vAmiga`, () => {
      const amiga = test.setup === 'A1200_2MB' ? a1200With(rom!) : machineWith(rom!);
      // vAmiga's A500_ECS_1MB is an A500 with Super Agnus and the original Denise.
      if (test.setup === 'A500_ECS_1MB') amiga.agnus.setChipset(true);
      // An A1200 test runs the A500 test's disk.
      const disk = test.id.replace(/_aga$/, '');
      amiga.insertDisk(0, FloppyDisk.fromAdf(new Uint8Array(readFileSync(join(dir, `${disk}.adf`))), disk));
      runSeconds(amiga, test.seconds);
      screenshot(amiga, `hw-${test.id}`);
      const reference = new Uint8Array(readFileSync(join(dir, `${test.id}.raw`)));
      const comparison = compareWithReference(amiga, reference);
      if (process.env.HW_REPORT) {
        console.log(`${test.id}: ${(comparison.match * 100).toFixed(2)}% match, ${describeDifferences(comparison)}`);
        const shots = process.env.SHOTS;
        if (shots) {
          mkdirSync(shots, { recursive: true });
          writeFileSync(join(shots, `hw-${test.id}-compare.png`), comparisonPng(amiga, reference, comparison));
        }
      }
      expect(comparison.match, `share of pixels matching vAmiga's screenshot`).toBeGreaterThanOrEqual(REQUIRED);
    }, 120_000);
  }
});
