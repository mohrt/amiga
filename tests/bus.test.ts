import { describe, expect, it } from 'vitest';
import { Amiga } from '../src/amiga';

/** A ROM whose reset vectors point at a STOP loop, so the CPU stays put while the tests poke memory. */
function stopRom(): Uint8Array {
  const rom = new Uint8Array(0x40000);
  rom.set([0x11, 0x11, 0x4e, 0xf9, 0x00, 0xfc, 0x00, 0x08]);
  // $FC0008: stop #$2700; bra.s -6
  rom.set([0x4e, 0x72, 0x27, 0x00, 0x60, 0xfa], 8);
  rom.set([0x00, 0x04, 0x00, 0x00, 0x00, 0xfc, 0x00, 0x08], 0);
  return rom;
}

function machine(): Amiga {
  const amiga = new Amiga();
  amiga.setKickstart(stopRom());
  amiga.powerOn();
  return amiga;
}

describe('A500 memory map', () => {
  it('shows the ROM at $000000 until CIA-A turns the overlay off', () => {
    const amiga = machine();
    const { bus } = amiga;
    expect(amiga.cpu.pc).toBe(0xfc0008);
    expect(bus.read16(0)).toBe(0x0004);
    bus.write16(0, 0x1234);
    // Writes go to chip RAM underneath.
    expect(amiga.chip.read16(0)).toBe(0x1234);
    bus.write8(0xbfe201, 0x03);
    bus.write8(0xbfe001, 0x00);
    expect(amiga.overlay).toBe(false);
    expect(bus.read16(0)).toBe(0x1234);
  });

  it('repeats a 256K ROM in the 512K at $F80000', () => {
    const { bus } = machine();
    expect(bus.read16(0xfc0008)).toBe(0x4e72);
    expect(bus.read16(0xf80008)).toBe(0x4e72);
  });

  it('mirrors 512K of chip RAM through the 2MB chip space', () => {
    const amiga = machine();
    amiga.overlay = false;
    amiga.bus.write16(0x100, 0xbeef);
    expect(amiga.bus.read16(0x80100)).toBe(0xbeef);
    expect(amiga.bus.read16(0x180100)).toBe(0xbeef);
  });

  it('has 512K of slow RAM at $C00000, and echoes the custom chips above it', () => {
    const amiga = machine();
    const { bus } = amiga;
    bus.write16(0xc00010, 0x5678);
    expect(bus.read16(0xc00010)).toBe(0x5678);
    expect(amiga.slow[0x10]).toBe(0x56);
    // INTENA written through the echo at $C8F09A reads back from INTENAR.
    bus.write16(0xc8f09a, 0xc020);
    expect(bus.read16(0xdff01c)).toBe(0x4020);
    expect(bus.read16(0xc8f01c)).toBe(0x4020);
  });

  it('puts CIA-A on odd addresses and CIA-B on even ones', () => {
    const amiga = machine();
    const { bus } = amiga;
    // The data direction registers for port B read back as written.
    bus.write8(0xbfe301, 0x34);
    bus.write8(0xbfd300, 0x56);
    expect(bus.read8(0xbfe301)).toBe(0x34);
    expect(bus.read8(0xbfd300)).toBe(0x56);
    expect(bus.read16(0xbfd300)).toBe(0x56ff);
  });

  it('writes a byte to a custom register on both halves of the word', () => {
    const amiga = machine();
    amiga.bus.write8(0xdff181, 0x0f);
    expect(amiga.denise.colors[0]).toBe(0xf0f);
  });

  it('makes the CPU wait for the chip bus while bitplane DMA uses it', () => {
    const amiga = machine();
    amiga.overlay = false;
    const { bus, cpu, agnus } = amiga;
    // Six lores planes in the whole display window take most cycles of each line.
    bus.write16(0xdff100, 0x6200);
    bus.write16(0xdff08e, 0x2c81);
    bus.write16(0xdff090, 0x2cc1);
    bus.write16(0xdff092, 0x0038);
    bus.write16(0xdff094, 0x00d0);
    bus.write16(0xdff096, 0x8300);
    while (agnus.vpos !== 0x40 || agnus.hpos !== 0x40) agnus.step();
    cpu.cycles = agnus.clock * 2 + 4;
    const before = cpu.cycles;
    for (let i = 0; i < 20; i++) {
      cpu.cycles += 4;
      bus.read16(0x1000);
    }
    expect(cpu.cycles - before).toBeGreaterThan(20 * 4 + 20);
  });
});
