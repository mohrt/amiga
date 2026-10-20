import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Amiga } from '../../src/amiga';
import { identifyKickstart } from '../../src/roms/system-roms';
import { framePng } from './png';

export const root = join(import.meta.dirname, '..', '..');
/** Your own Kickstarts, for the tests only (never committed). */
export const localRoms = join(root, 'roms');
/** The free AROS ROMs, from `npm run fetch:roms`. */
export const arosDir = join(root, 'tests', 'fixtures', 'aros');

export function localKickstart(name: string): Uint8Array | null {
  const path = join(localRoms, name);
  if (!existsSync(path)) return null;
  return identifyKickstart(name, new Uint8Array(readFileSync(path))).data;
}

export function arosRoms(): { main: Uint8Array; extended: Uint8Array } | null {
  const main = join(arosDir, 'aros-rom.bin');
  const extended = join(arosDir, 'aros-ext.bin');
  if (!existsSync(main) || !existsSync(extended)) return null;
  return { main: new Uint8Array(readFileSync(main)), extended: new Uint8Array(readFileSync(extended)) };
}

/** An A500 with this Kickstart (and an extended ROM for AROS), switched on. */
export function machineWith(rom: Uint8Array, extended: Uint8Array | null = null): Amiga {
  const amiga = new Amiga();
  amiga.setKickstart(rom);
  amiga.extendedRom = extended;
  amiga.powerOn();
  return amiga;
}

/** A ROM whose reset vectors point at a STOP loop, so the CPU stays put while a test drives the chips. */
export function stopRom(): Uint8Array {
  const rom = new Uint8Array(0x40000);
  // SSP $40000, PC $FC0008: stop #$2700; bra.s back to it.
  rom.set([0x00, 0x04, 0x00, 0x00, 0x00, 0xfc, 0x00, 0x08, 0x4e, 0x72, 0x27, 0x00, 0x60, 0xfa]);
  return rom;
}

/** An A500 with the overlay off and the CPU stopped, for testing the chips. */
export function idleMachine(): Amiga {
  const amiga = machineWith(stopRom());
  amiga.overlay = false;
  return amiga;
}

export function runSeconds(amiga: Amiga, seconds: number): void {
  const frames = Math.round(seconds * (amiga.standard === 'pal' ? 50 : 60));
  for (let i = 0; i < frames; i++) amiga.runFrame();
}

/** Set SHOTS=<dir> to keep screenshots. */
export function screenshot(amiga: Amiga, name: string): void {
  const dir = process.env.SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.png`), framePng(amiga));
}

/** How many different colours the picture has (a blank screen has one). */
export function colourCount(amiga: Amiga): number {
  const { framebuffer, outputLines } = amiga.denise;
  return new Set(framebuffer.subarray(0, outputLines * 2 * 720)).size;
}
