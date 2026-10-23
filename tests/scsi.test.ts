import { describe, expect, it } from 'vitest';
import { A3000Scsi } from '../src/scsi/sdmac';

const SASR = 0xdd0049;
const SCMD = 0xdd0043;
const CNTR = 0xdd000b;
const ISTR = 0xdd001f;

/** Writes a WD33C93 register through the SDMAC. */
const writeWd = (scsi: A3000Scsi, reg: number, value: number) => {
  scsi.write8(SASR, reg);
  scsi.write8(SCMD, value);
};

describe("the A3000's SCSI controller with no drive", () => {
  it('times a selection out, interrupting through the SDMAC until the status is read', () => {
    const scsi = new A3000Scsi();
    scsi.write8(CNTR, 0x04);
    writeWd(scsi, 0x15, 0);
    writeWd(scsi, 0x18, 0x06);
    // Busy until the selection gives up.
    expect(scsi.read8(SASR) & 0x20).toBe(0x20);
    for (let line = 0; line < 1000; line++) scsi.tick();
    expect(scsi.read8(SASR) & 0x80, 'interrupt').toBe(0x80);
    expect(scsi.read8(ISTR) & 0x50, 'INTS and INT_P').toBe(0x50);
    expect(scsi.interrupting).toBe(true);
    scsi.write8(SASR, 0x17);
    expect(scsi.read8(SCMD), 'selection timeout').toBe(0x42);
    expect(scsi.interrupting).toBe(false);
    expect(scsi.read8(SASR) & 0xa0).toBe(0);
  });

  it('reports a reset, with the advanced features when the own ID asks for them', () => {
    const scsi = new A3000Scsi();
    writeWd(scsi, 0x00, 0x0f);
    writeWd(scsi, 0x18, 0x00);
    scsi.tick();
    scsi.tick();
    scsi.write8(SASR, 0x17);
    expect(scsi.read8(SCMD)).toBe(0x01);
    // Without CNTR's interrupt enable, the CPU isn't interrupted.
    expect(scsi.interrupting).toBe(false);
  });
});
