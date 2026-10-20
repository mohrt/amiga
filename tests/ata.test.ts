import { describe, expect, it } from 'vitest';
import type { Amiga } from '../src/amiga';
import { Status } from '../src/ide/ata';
import { HardDiskImage, SECTOR_BYTES, isPartitionOnly, rdbGeometry } from '../src/ide/image';
import { Int } from '../src/custom/registers';
import { HardDisks } from '../src/storage/hard-disks';
import { MemoryStore } from '../src/storage/store';
import { idleMachine } from './helpers/machine';

const IDE = 0xda2000;
const reg = (n: number) => IDE + n * 4;
const DEVCTRL = 0xda3018;
const GAYLE_IRQ = 0xda9000;
const GAYLE_INTENA = 0xdaa000;

function withDisk(megabytes = 1): { amiga: Amiga; image: HardDiskImage } {
  const amiga = idleMachine();
  const image = HardDiskImage.blank(megabytes);
  amiga.attachHardDisk(image);
  return { amiga, image };
}

/** Runs lines until the drive is no longer busy. */
function waitReady(amiga: Amiga): number {
  for (let i = 0; i < 100; i++) {
    const status = amiga.bus.read8(DEVCTRL);
    if (!(status & Status.BSY)) return status;
    amiga.gayle!.tick();
  }
  throw new Error('The drive stayed busy');
}

function command(amiga: Amiga, code: number, task: Partial<Record<'count' | 'sector' | 'cylLow' | 'cylHigh' | 'select', number>> = {}): number {
  const { bus } = amiga;
  bus.write8(reg(2), task.count ?? 1);
  bus.write8(reg(3), task.sector ?? 1);
  bus.write8(reg(4), task.cylLow ?? 0);
  bus.write8(reg(5), task.cylHigh ?? 0);
  bus.write8(reg(6), task.select ?? 0xa0);
  bus.write8(reg(7), code);
  return waitReady(amiga);
}

const readWords = (amiga: Amiga, count: number) => Array.from({ length: count }, () => amiga.bus.read16(IDE));

describe('Gayle', () => {
  it('gives its ID a bit at a time from $DE1000, starting again after a write', () => {
    const { amiga } = withDisk();
    const id = () => {
      let value = 0;
      for (let i = 0; i < 8; i++) value = (value << 1) | (amiga.bus.read8(0xde1000) >> 7);
      return value;
    };
    amiga.bus.write8(0xde1000, 0);
    expect(id()).toBe(0xd0);
    amiga.bus.write8(0xde1000, 0);
    expect(id()).toBe(0xd0);
  });

  it('is absent without a hard disk', () => {
    const amiga = idleMachine();
    amiga.bus.write8(0xde1000, 0);
    expect(amiga.bus.read8(0xde1000) >> 7).toBe(0);
  });

  it('raises INT2 for an enabled IDE interrupt, and a write clears the change flag', () => {
    const { amiga } = withDisk();
    amiga.bus.write8(GAYLE_INTENA, 0x80);
    amiga.paula.writeIntreq(0x7fff);
    command(amiga, 0xec);
    expect(amiga.bus.read8(0xda8000) & 0x80).toBe(0x80);
    expect(amiga.paula.intreq & Int.PORTS).toBe(Int.PORTS);
    expect(amiga.bus.read8(GAYLE_IRQ) & 0x80).toBe(0x80);
    amiga.bus.write8(GAYLE_IRQ, 0x7c);
    expect(amiga.bus.read8(GAYLE_IRQ) & 0x80).toBe(0);
    // Reading the status register acknowledges the drive's interrupt.
    amiga.bus.read8(reg(7));
    expect(amiga.bus.read8(0xda8000) & 0x80).toBe(0);
  });
});

describe('ATA drive', () => {
  it('identifies itself with byte-swapped words, as the A600 wiring delivers them', () => {
    const { amiga, image } = withDisk(20);
    const status = command(amiga, 0xec);
    expect(status & Status.DRQ).toBe(Status.DRQ);
    const swap = (word: number) => ((word & 0xff) << 8) | (word >> 8);
    const words = readWords(amiga, 256).map(swap);
    expect(words[1]).toBe(image.geometry.cylinders);
    expect(words[3]).toBe(16);
    expect(words[6]).toBe(63);
    expect(words[49] & 0x0200).toBe(0x0200);
    expect(words[60] | (words[61] << 16)).toBe(image.sectorCount);
    expect(String.fromCharCode(...words.slice(27, 31).flatMap((w) => [w >> 8, w & 0xff]))).toBe('AMIGA500');
    expect(amiga.bus.read8(reg(7)) & Status.DRQ).toBe(0);
  });

  it('reads sectors by cylinder, head and sector, in disk order', () => {
    const { amiga, image } = withDisk(20);
    // Cylinder 1, head 2, sector 3 is LBA (1 * 16 + 2) * 63 + 2.
    const lba = (1 * 16 + 2) * 63 + 2;
    image.bytes.set([0x12, 0x34, 0x56, 0x78], lba * SECTOR_BYTES);
    command(amiga, 0x20, { sector: 3, cylLow: 1, select: 0xa2 });
    expect(readWords(amiga, 2)).toEqual([0x1234, 0x5678]);
    readWords(amiga, 254);
    expect(amiga.bus.read8(reg(7)) & (Status.DRQ | Status.ERR)).toBe(0);
    // The task file now points at the next sector.
    expect(amiga.bus.read8(reg(3))).toBe(4);
  });

  it('writes several sectors by LBA, a block at a time, and notes the changed piece', () => {
    const { amiga, image } = withDisk(20);
    command(amiga, 0x30, { count: 2, sector: 10, select: 0xe0 });
    for (let i = 0; i < 512; i++) {
      amiga.bus.write16(IDE, i);
      if (i === 255) waitReady(amiga);
    }
    waitReady(amiga);
    const view = new DataView(image.bytes.buffer);
    expect(view.getUint16(10 * SECTOR_BYTES + 2)).toBe(1);
    expect(view.getUint16(11 * SECTOR_BYTES)).toBe(256);
    expect([...image.dirty]).toEqual([0]);
  });

  it('reads with READ MULTIPLE after SET MULTIPLE MODE', () => {
    const { amiga, image } = withDisk(20);
    image.bytes[3 * SECTOR_BYTES] = 0xaa;
    image.bytes[4 * SECTOR_BYTES] = 0xbb;
    expect(command(amiga, 0xc4) & Status.ERR).toBe(Status.ERR);
    command(amiga, 0xc6, { count: 4 });
    command(amiga, 0xc4, { count: 2, sector: 3, select: 0xe0 });
    const words = readWords(amiga, 512);
    expect(words[0] >> 8).toBe(0xaa);
    expect(words[256] >> 8).toBe(0xbb);
  });

  it('refuses sectors past the end of the disk', () => {
    const { amiga, image } = withDisk(1);
    const last = image.sectorCount;
    const status = command(amiga, 0x20, { sector: last & 0xff, cylLow: last >> 8, select: 0xe0 });
    expect(status & Status.ERR).toBe(Status.ERR);
  });

  it('keeps quiet with nIEN set, and has no slave drive', () => {
    const { amiga } = withDisk();
    amiga.bus.write8(GAYLE_INTENA, 0x80);
    amiga.bus.write8(DEVCTRL, 0x02);
    command(amiga, 0xec);
    expect(amiga.bus.read8(0xda8000) & 0x80).toBe(0);
    amiga.bus.write8(reg(6), 0xb0);
    expect(amiga.bus.read8(reg(7))).toBe(0);
  });

  it('resets with SRST', () => {
    const { amiga } = withDisk();
    amiga.bus.write8(DEVCTRL, 0x04);
    expect(amiga.bus.read8(DEVCTRL) & Status.BSY).toBe(Status.BSY);
    amiga.bus.write8(DEVCTRL, 0x00);
    expect(amiga.bus.read8(DEVCTRL)).toBe(Status.DRDY | Status.DSC);
    expect(amiga.bus.read8(reg(1))).toBe(1);
  });
});

describe('hard disk images', () => {
  it('takes the geometry from a Rigid Disk Block and spots partition-only images', () => {
    const bytes = new Uint8Array(64 * SECTOR_BYTES);
    const view = new DataView(bytes.buffer);
    view.setUint32(SECTOR_BYTES, 0x5244534b);
    view.setUint32(SECTOR_BYTES + 64, 4);
    view.setUint32(SECTOR_BYTES + 68, 8);
    view.setUint32(SECTOR_BYTES + 72, 2);
    expect(rdbGeometry(bytes)).toEqual({ cylinders: 4, heads: 2, sectors: 8 });
    expect(isPartitionOnly(bytes)).toBe(false);
    const partition = new Uint8Array(64 * SECTOR_BYTES);
    partition.set([0x44, 0x4f, 0x53, 0x01]);
    expect(isPartitionOnly(partition)).toBe(true);
  });

  it('are stored in pieces, leaving out the empty ones, and saved piece by piece', async () => {
    const store = new MemoryStore<unknown>();
    const disks = new HardDisks(store);
    const image = HardDiskImage.blank(20);
    image.bytes[5] = 1;
    await disks.replace(image, 'Work');
    expect(await disks.info()).toEqual({ name: 'Work', bytes: image.bytes.length });
    expect((await store.entries()).length).toBe(2);

    const sector = new Uint8Array(SECTOR_BYTES).fill(7);
    image.write(5000, sector);
    await disks.persist(image);
    const loaded = (await disks.load())!;
    expect(Buffer.compare(loaded.bytes, image.bytes), 'contents').toBe(0);
    expect(loaded.geometry).toEqual(image.geometry);

    await disks.delete();
    expect(await disks.info()).toBeNull();
    expect((await store.entries()).length).toBe(0);
  });
});
