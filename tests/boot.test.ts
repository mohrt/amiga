import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Amiga } from '../src/amiga';
import { FloppyDisk } from '../src/drive/adf';
import { readZip } from '../src/drive/zip';
import { modelById } from '../src/models';
import { arosRoms, colourCount, localKickstart, machineWith, root, runSeconds, screenshot } from './helpers/machine';

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

/** The other models, each with a Kickstart that suits it and its memory. */
const MODEL_BOOTS = [
  ['a1000', 'kick13.rom', { chipKb: 256, slowKb: 0, fastKb: 0 }],
  ['a2000', 'kick13.rom', { chipKb: 1024, slowKb: 0, fastKb: 2048 }],
  ['a500plus', 'kick204.rom', { chipKb: 1024, slowKb: 0, fastKb: 0 }],
  ['a600', 'kick31.rom', { chipKb: 2048, slowKb: 0, fastKb: 0 }],
  ['a1200', 'kick31-a1200.rom', { chipKb: 2048, slowKb: 0, fastKb: 4096 }],
  ['a1200', 'kick30-a1200.rom', { chipKb: 2048, slowKb: 0, fastKb: 0 }],
] as const;

describe('booting the other models', () => {
  for (const [id, file, memory] of MODEL_BOOTS) {
    const rom = localKickstart(file);
    const model = modelById(id);
    it.skipIf(!rom)(`the ${model.name} reaches the insert-disk screen with ${file}`, () => {
      const amiga = new Amiga();
      amiga.setModel(model);
      amiga.setMemory(memory);
      amiga.setKickstart(rom!);
      amiga.powerOn();
      runSeconds(amiga, 8);
      screenshot(amiga, `${model.name} - insert disk`);
      expect(colourCount(amiga), 'colours on screen').toBeGreaterThan(2);
      expect(amiga.overlay).toBe(false);
    }, 120_000);
  }
});

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

// Your own Workbench 3.1 set (its zipped disks) goes in disks/wb31/.
const WORKBENCH_ZIP = join(root, 'disks', 'wb31', 'Workbench v3.1 rev 40.42 (1996)(ESCOM)(M10)(Disk 2 of 6)(Workbench).zip');
/** Workbench's backdrop grey, $AAA. */
const WORKBENCH_GREY = 0xffaaaaaa;
/** ExecBase->LibList, GfxBase->ChipRevBits0 and its AGA bits. */
const EXEC_LIB_LIST = 0x17a;
const KICKSTART_BASE = 0xf80000;
const GFX_CHIP_REV_BITS = 0xec;
const GFXF_AA_ALICE = 0x04;
const GFXF_AA_LISA = 0x08;

describe('Workbench on the A1200', () => {
  const rom = localKickstart('kick31-a1200.rom');
  it.skipIf(!rom || !existsSync(WORKBENCH_ZIP))('starts Workbench 3.1 from its disk, with fast RAM', async () => {
    const [entry] = readZip(new Uint8Array(readFileSync(WORKBENCH_ZIP)));
    const amiga = new Amiga();
    amiga.setModel(modelById('a1200'));
    amiga.setMemory({ chipKb: 2048, slowKb: 0, fastKb: 4096 });
    amiga.setKickstart(rom!);
    amiga.powerOn();
    amiga.insertDisk(0, FloppyDisk.fromAdf(await entry.read(), 'Workbench3.1'));
    runSeconds(amiga, 60);
    screenshot(amiga, 'Amiga 1200 - Workbench 3.1');
    const { framebuffer, outputLines } = amiga.denise;
    const pixels = framebuffer.subarray(0, outputLines * 2 * 720);
    expect(pixels.filter((pixel) => pixel === WORKBENCH_GREY).length / pixels.length, 'share of the screen in Workbench grey').toBeGreaterThan(0.5);
    expect(amiga.zorro?.base).toBe(0x200000);
    // graphics.library found Alice and Lisa (ChipRevBits0's AA bits), so it offers the AGA screen modes.
    const peek16 = (address: number) => {
      if (address >= KICKSTART_BASE) return (amiga.rom[address - KICKSTART_BASE] << 8) | amiga.rom[address - KICKSTART_BASE + 1];
      return amiga.zorro?.holds(address) ? amiga.zorro.read16(address) : amiga.chip.read16(address);
    };
    const peek32 = (address: number) => ((peek16(address) << 16) | peek16(address + 2)) >>> 0;
    const name = (address: number) => {
      let text = '';
      for (let i = 0; i < 32; i++) {
        const byte = (peek16((address + i) & ~1) >> ((address + i) & 1 ? 0 : 8)) & 0xff;
        if (!byte) break;
        text += String.fromCharCode(byte);
      }
      return text;
    };
    const execBase = peek32(4);
    let gfxBase = 0;
    for (let node = peek32(execBase + EXEC_LIB_LIST); peek32(node) !== 0; node = peek32(node)) {
      if (name(peek32(node + 10)) === 'graphics.library') gfxBase = node;
    }
    const chipRevBits = peek16(gfxBase + GFX_CHIP_REV_BITS) >> 8;
    expect(chipRevBits & (GFXF_AA_ALICE | GFXF_AA_LISA)).toBe(GFXF_AA_ALICE | GFXF_AA_LISA);
  }, 300_000);
});
