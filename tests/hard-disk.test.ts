import { describe, expect, it } from 'vitest';
import { Amiga } from '../src/amiga';
import { HardDiskImage } from '../src/ide/image';
import { modelById, type ModelId } from '../src/models';
import { formattedHardDisk } from './helpers/hdf';
import { colourCount, localKickstart, runSeconds, screenshot } from './helpers/machine';

/** An A500 (or another model) with this Kickstart and hard disk, switched on, noting the sectors Kickstart reads. */
function bootWith(rom: Uint8Array, image: HardDiskImage, model: ModelId = 'a500'): { amiga: Amiga; sectorsRead: Set<number>; commands: number[] } {
  const amiga = new Amiga();
  amiga.setModel(modelById(model));
  amiga.setMemory(modelById(model).memory[0].config);
  amiga.setKickstart(rom);
  amiga.attachHardDisk(image);
  amiga.powerOn();
  const sectorsRead = new Set<number>();
  const read = image.read.bind(image);
  image.read = (lba, into, offset) => {
    sectorsRead.add(lba);
    read(lba, into, offset);
  };
  const commands: number[] = [];
  const drive = amiga.gayle!.drive;
  const writeRegister = drive.writeRegister.bind(drive);
  drive.writeRegister = (reg, value) => {
    if (reg === 7) commands.push(value);
    writeRegister(reg, value);
  };
  return { amiga, sectorsRead, commands };
}

// Kickstarts are copyrighted and never committed: put your own in roms/ to run these.
describe('the A600-style IDE hard drive with Kickstart 3.1 (roms/kick31.rom)', () => {
  const rom = localKickstart('kick31.rom');

  it.skipIf(!rom)('is found by scsi.device, which looks for a Rigid Disk Block', () => {
    const { amiga, sectorsRead, commands } = bootWith(rom!, HardDiskImage.blank(20));
    runSeconds(amiga, 10);
    screenshot(amiga, 'Kickstart 3.1 - blank hard disk');
    expect(commands, 'IDENTIFY').toContain(0xec);
    expect(sectorsRead.has(0), 'block 0 read').toBe(true);
    // With nothing to boot from on it, Kickstart goes on to ask for a disk.
    expect(colourCount(amiga), 'colours on screen').toBeGreaterThan(2);
  }, 120_000);

  it.skipIf(!rom)('boots from a formatted partition with no floppy in', () => {
    const { image, rootLba } = formattedHardDisk(20);
    const { amiga, sectorsRead } = bootWith(rom!, image);
    runSeconds(amiga, 12);
    screenshot(amiga, 'Kickstart 3.1 - hard disk boot');
    expect(sectorsRead.has(rootLba), 'root block read').toBe(true);
    expect(colourCount(amiga), 'colours on screen').toBeGreaterThan(2);
  }, 180_000);
});

describe("the A4000's own IDE port with its Kickstart 3.1 (roms/kick31-a4000.rom)", () => {
  const rom = localKickstart('kick31-a4000.rom');

  it.skipIf(!rom)('is found by scsi.device, which looks for a Rigid Disk Block', () => {
    const { amiga, sectorsRead, commands } = bootWith(rom!, HardDiskImage.blank(20), 'a4000');
    runSeconds(amiga, 10);
    expect(commands, 'IDENTIFY').toContain(0xec);
    expect(sectorsRead.has(0), 'block 0 read').toBe(true);
    expect(colourCount(amiga), 'colours on screen').toBeGreaterThan(2);
  }, 120_000);

  it.skipIf(!rom)('boots from a formatted partition with no floppy in', () => {
    const { image, rootLba } = formattedHardDisk(20);
    const { amiga, sectorsRead } = bootWith(rom!, image, 'a4000');
    runSeconds(amiga, 12);
    screenshot(amiga, 'A4000 - hard disk boot');
    expect(sectorsRead.has(rootLba), 'root block read').toBe(true);
    expect(colourCount(amiga), 'colours on screen').toBeGreaterThan(2);
  }, 180_000);
});
