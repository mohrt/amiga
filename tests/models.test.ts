import { describe, expect, it } from 'vitest';
import { Amiga } from '../src/amiga';
import { RealTimeClock } from '../src/io/clock';
import { HardDiskImage } from '../src/ide/image';
import { ZorroRam } from '../src/memory/zorro';
import { MODELS, memoryOption, modelById } from '../src/models';
import { localKickstart, runSeconds } from './helpers/machine';

const rom = localKickstart('kick13.rom');

describe('models', () => {
  it('offers each model its own memory, and falls back to the A500 for one that is unknown', () => {
    expect(modelById('a2000').name).toBe('Amiga 2000');
    expect(modelById('nonsense').id).toBe('a500');
    expect(modelById('a1200').memory[0].config).toEqual({ chipKb: 2048, slowKb: 0, fastKb: 0 });
    const a500plus = modelById('a500plus');
    expect(memoryOption(a500plus, { chipKb: 512, slowKb: 512, fastKb: 0 }).key).toBe('1024');
    // The first setup is the default: for the A500, chip RAM with the trapdoor's slow RAM.
    expect(modelById('a500').memory[0].config).toEqual({ chipKb: 512, slowKb: 512, fastKb: 0 });
    for (const model of MODELS) expect(model.memory.length).toBeGreaterThan(0);
  });

  it('gives the ECS models Super Agnus and Super Denise IDs', () => {
    const amiga = new Amiga();
    expect(amiga.readCustom(0x07c)).toBe(0xffff);
    amiga.setModel(modelById('a500plus'));
    expect(amiga.readCustom(0x004) & 0x7f00).toBe(0x2000);
    expect(amiga.readCustom(0x07c) & 0xff).toBe(0xfc);
  });

  it('gives the A1200 Alice and Lisa IDs and the AA Gayle', () => {
    const amiga = new Amiga();
    amiga.setModel(modelById('a1200'));
    amiga.attachHardDisk(HardDiskImage.blank(10));
    expect(amiga.readCustom(0x004) & 0x7f00).toBe(0x2300);
    expect(amiga.readCustom(0x07c) & 0xff).toBe(0xf8);
    const id = Array.from({ length: 8 }, () => amiga.gayle!.read8(0xde1000) >> 7).reduce((value, bit) => (value << 1) | bit, 0);
    expect(id).toBe(0xd1);
  });

  it('gives the A4000 Ramsey, Gary, and its fast RAM on the main board just below $8000000', () => {
    const amiga = new Amiga();
    amiga.setModel(modelById('a4000'));
    amiga.setMemory({ chipKb: 2048, slowKb: 0, fastKb: 4096 });
    amiga.powerOn();
    expect(amiga.zorro).toBeNull();
    expect(amiga.bus.read8(0xde0043), 'Ramsey revision').toBe(0x0f);
    // Gary's cold-boot bit reads set once after power on.
    expect(amiga.bus.read8(0xde0002) & 0x80).toBe(0x80);
    expect(amiga.bus.read8(0xde0002) & 0x80).toBe(0);
    amiga.bus.write16(0x7c00000, 0x1234);
    amiga.bus.write16(0x7fffffe, 0x5678);
    expect(amiga.bus.read16(0x7c00000)).toBe(0x1234);
    expect(amiga.bus.read16(0x7fffffe)).toBe(0x5678);
    expect(amiga.bus.read16(0x7bffffe), 'below the RAM').toBe(0);
    // With no drive on the IDE port, its status floats high.
    expect(amiga.bus.read8(0xdd203e)).toBe(0xff);
  });

  it.skipIf(!rom)('has Kickstart configure the Zorro II fast RAM at $200000', () => {
    const amiga = new Amiga();
    amiga.setModel(modelById('a2000'));
    amiga.setMemory({ chipKb: 1024, slowKb: 0, fastKb: 2048 });
    amiga.setKickstart(rom!);
    amiga.powerOn();
    runSeconds(amiga, 3);
    expect(amiga.zorro?.base).toBe(0x200000);
  });
});

describe('Zorro II fast RAM', () => {
  it('describes itself in the autoconfig space, then appears where it is put', () => {
    const board = new ZorroRam(4096);
    const nibble = (offset: number) => board.readConfig(0xe80000 + offset) >> 4;
    // er_Type (not inverted): Zorro II, memory added to the free list, 4 MB.
    expect((nibble(0) << 4) | nibble(2)).toBe(0xe7);
    // The rest is inverted: product 1.
    expect(((nibble(4) << 4) | nibble(6)) ^ 0xff).toBe(0x01);
    board.writeConfig(0xe8004a, 0x00);
    board.writeConfig(0xe80048, 0x20);
    expect(board.base).toBe(0x200000);
    expect(board.configures(0xe80000)).toBe(false);
    board.write16(0x200100, 0x1234);
    expect(board.read16(0x200100)).toBe(0x1234);
  });
});

describe('battery-backed clock', () => {
  it('reads the time as digits, and keeps a time it is set to', () => {
    let now = Date.UTC(2026, 9, 22, 15, 42, 7);
    const clock = new RealTimeClock(() => now);
    const reg = (n: number) => clock.read(0xdc0000 + n * 4 + 3);
    expect([reg(5), reg(4), reg(3), reg(2), reg(1), reg(0)]).toEqual([1, 5, 4, 2, 0, 7]);
    expect([reg(11), reg(10), reg(9), reg(8), reg(7), reg(6)]).toEqual([2, 6, 1, 0, 2, 2]);
    // Set the hours to 09.
    clock.write(0xdc0000 + 5 * 4 + 3, 0);
    clock.write(0xdc0000 + 4 * 4 + 3, 9);
    now += 60_000;
    expect([reg(5), reg(4), reg(3), reg(2)]).toEqual([0, 9, 4, 3]);
  });
});
