import { describe, expect, it } from 'vitest';
import { I2cEeprom } from '../src/cd32/eeprom';

/** An I2C master bit-banging the chip, as the CD32's nonvolatile.library does through Akiko. */
function master(chip: I2cEeprom) {
  const lines = (scl: boolean, sda: boolean) => chip.setLines(scl, sda);
  const start = () => {
    lines(true, true);
    lines(true, false);
    lines(false, false);
  };
  const stop = () => {
    lines(false, false);
    lines(true, false);
    lines(true, true);
  };
  /** Sends a byte; true if the chip acknowledged it. */
  const write = (byte: number) => {
    for (let i = 7; i >= 0; i--) {
      const bit = ((byte >> i) & 1) === 1;
      lines(false, bit);
      lines(true, bit);
      lines(false, bit);
    }
    lines(false, true);
    lines(true, true);
    const ack = !chip.dataLine;
    lines(false, true);
    return ack;
  };
  const read = (last: boolean) => {
    let byte = 0;
    for (let i = 0; i < 8; i++) {
      lines(false, true);
      lines(true, true);
      byte = (byte << 1) | (chip.dataLine ? 1 : 0);
      lines(false, true);
    }
    lines(false, last);
    lines(true, last);
    lines(false, last);
    return byte;
  };
  return { start, stop, write, read };
}

describe('the CD32 save memory (24C08 EEPROM)', () => {
  it('writes bytes at the stop and reads them back from an address', () => {
    const chip = new I2cEeprom();
    const bus = master(chip);
    bus.start();
    expect(bus.write(0xa2), 'device, block 1').toBe(true);
    expect(bus.write(0x10)).toBe(true);
    expect(bus.write(0x12)).toBe(true);
    expect(bus.write(0x34)).toBe(true);
    bus.stop();
    expect(chip.bytes[0x110]).toBe(0x12);
    expect(chip.bytes[0x111]).toBe(0x34);
    expect(chip.changed).toBe(true);
    // A random read: the address written, then a repeated start with the read bit.
    bus.start();
    bus.write(0xa2);
    bus.write(0x10);
    bus.start();
    expect(bus.write(0xa3)).toBe(true);
    expect(bus.read(false)).toBe(0x12);
    expect(bus.read(true)).toBe(0x34);
    bus.stop();
  });

  it("doesn't answer another device's address", () => {
    const bus = master(new I2cEeprom());
    bus.start();
    expect(bus.write(0x50)).toBe(false);
    bus.stop();
  });
});
