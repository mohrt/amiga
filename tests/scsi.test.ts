import { describe, expect, it } from 'vitest';
import { HardDiskImage } from '../src/ide/image';
import { ScsiDisk } from '../src/scsi/disk';
import { A3000Scsi } from '../src/scsi/sdmac';

const SASR = 0xdd0049;
const SCMD = 0xdd0043;
const CNTR = 0xdd000b;
const ISTR = 0xdd001f;

const memory = new Uint8Array(0x10000);
const dma = { read8: (address: number) => memory[address & 0xffff], write8: (address: number, value: number) => (memory[address & 0xffff] = value) };

/** Writes a WD33C93 register through the SDMAC. */
const writeWd = (scsi: A3000Scsi, reg: number, value: number) => {
  scsi.write8(SASR, reg);
  scsi.write8(SCMD, value);
};

describe("the A3000's SCSI controller with no drive", () => {
  it('times a selection out, interrupting through the SDMAC until the status is read', () => {
    const scsi = new A3000Scsi(dma);
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
    const scsi = new A3000Scsi(dma);
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

/** Runs lines until the controller interrupts, then reads (and so acknowledges) the status. */
function nextStatus(scsi: A3000Scsi): number {
  for (let line = 0; line < 2000 && !(scsi.read8(SASR) & 0x80); line++) scsi.tick();
  scsi.write8(SASR, 0x17);
  return scsi.read8(SCMD);
}

describe("a hard disk on the A3000's SCSI controller", () => {
  const image = HardDiskImage.blank(10);
  const sector = new Uint8Array(512).map((_, i) => i * 7);
  image.write(5, sector);

  it('goes through the phases of a READ (6): identify message, command polled, data by DMA, status and message', () => {
    const scsi = new A3000Scsi(dma);
    scsi.drives[0] = new ScsiDisk(image);
    writeWd(scsi, 0x15, 0);
    writeWd(scsi, 0x18, 0x06);
    expect(nextStatus(scsi), 'selected').toBe(0x11);
    expect(nextStatus(scsi), 'message out wanted').toBe(0x8e);
    // The identify message, a byte through the data register.
    writeWd(scsi, 0x18, 0xa0);
    expect(scsi.read8(SASR) & 0x01, 'data buffer ready').toBe(1);
    writeWd(scsi, 0x19, 0x80);
    expect(nextStatus(scsi), 'command phase next').toBe(0x1a);
    // READ (6) of block 5, one block, polled.
    writeWd(scsi, 0x12, 0);
    writeWd(scsi, 0x13, 0);
    writeWd(scsi, 0x14, 6);
    writeWd(scsi, 0x18, 0x20);
    scsi.write8(SASR, 0x19);
    for (const byte of [0x08, 0, 0, 5, 1, 0]) scsi.write8(SCMD, byte);
    expect(nextStatus(scsi), 'data in next').toBe(0x19);
    // The data by DMA to $1000.
    writeWd(scsi, 0x01, 0x80);
    writeWd(scsi, 0x12, 0);
    writeWd(scsi, 0x13, 2);
    writeWd(scsi, 0x14, 0);
    scsi.write16(0xdd000c, 0);
    scsi.write16(0xdd000e, 0x1000);
    scsi.write16(0xdd0012, 0);
    writeWd(scsi, 0x18, 0x20);
    expect(nextStatus(scsi), 'status next').toBe(0x1b);
    expect(memory.subarray(0x1000, 0x1200)).toEqual(sector);
    writeWd(scsi, 0x01, 0x00);
    writeWd(scsi, 0x18, 0xa0);
    scsi.write8(SASR, 0x19);
    expect(scsi.read8(SCMD), 'status GOOD').toBe(0);
    expect(nextStatus(scsi), 'message in next').toBe(0x1f);
    writeWd(scsi, 0x18, 0xa0);
    scsi.write8(SASR, 0x19);
    expect(scsi.read8(SCMD), 'command complete').toBe(0);
    expect(nextStatus(scsi), 'message in, ACK held').toBe(0x20);
    writeWd(scsi, 0x18, 0x03);
    expect(nextStatus(scsi), 'disconnected').toBe(0x85);
  });

  it('runs a whole command with SELECT-AND-TRANSFER, the status in TARGET LUN', () => {
    const scsi = new A3000Scsi(dma);
    scsi.drives[0] = new ScsiDisk(image);
    memory.fill(0, 0x2000, 0x2200);
    writeWd(scsi, 0x01, 0x88);
    writeWd(scsi, 0x15, 0);
    scsi.write8(SASR, 0x03);
    for (const byte of [0x28, 0, 0, 0, 0, 5, 0, 0, 1, 0]) scsi.write8(SCMD, byte);
    writeWd(scsi, 0x12, 0);
    writeWd(scsi, 0x13, 2);
    writeWd(scsi, 0x14, 0);
    scsi.write16(0xdd000e, 0x2000);
    writeWd(scsi, 0x18, 0x09);
    expect(nextStatus(scsi)).toBe(0x16);
    scsi.write8(SASR, 0x0f);
    expect(scsi.read8(SCMD), 'status GOOD').toBe(0);
    expect(memory.subarray(0x2000, 0x2200)).toEqual(sector);
  });

  it('writes a block from memory with SELECT-AND-TRANSFER', () => {
    const scsi = new A3000Scsi(dma);
    const disk = HardDiskImage.blank(10);
    scsi.drives[0] = new ScsiDisk(disk);
    memory.fill(0x5a, 0x3000, 0x3200);
    writeWd(scsi, 0x01, 0x88);
    writeWd(scsi, 0x15, 0);
    scsi.write8(SASR, 0x03);
    for (const byte of [0x2a, 0, 0, 0, 0, 9, 0, 0, 1, 0]) scsi.write8(SCMD, byte);
    writeWd(scsi, 0x12, 0);
    writeWd(scsi, 0x13, 2);
    writeWd(scsi, 0x14, 0);
    scsi.write16(0xdd000e, 0x3000);
    writeWd(scsi, 0x18, 0x09);
    expect(nextStatus(scsi)).toBe(0x16);
    const written = new Uint8Array(512);
    disk.read(9, written);
    expect(written.every((byte) => byte === 0x5a)).toBe(true);
  });
});
