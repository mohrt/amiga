import { describe, expect, it } from 'vitest';
import { ADF_SIZE, FloppyDisk } from '../src/drive/adf';
import { decodeTrack, encodeTrack, TRACK_BYTES, TRACK_WORDS } from '../src/drive/mfm';
import { bootableAdf, colourLoop } from './helpers/adf';
import { idleMachine, localKickstart, machineWith, runSeconds, screenshot } from './helpers/machine';

function randomTrack(seed: number): Uint8Array {
  let state = seed;
  return Uint8Array.from({ length: TRACK_BYTES }, () => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state >>> 24;
  });
}

describe('MFM', () => {
  it('encodes an AmigaDOS track and decodes it back', () => {
    const sectors = randomTrack(1);
    const words = encodeTrack(sectors, 37);
    expect(words.length).toBe(TRACK_WORDS);
    expect(words.filter((word) => word === 0x4489).length).toBe(22);
    const decoded = new Uint8Array(TRACK_BYTES);
    expect(decodeTrack(words, 37, decoded)).toBe(11);
    expect(decoded).toEqual(sectors);
  });

  it('finds sectors that wrap past the end of the track, and refuses damaged ones', () => {
    const sectors = randomTrack(2);
    const words = encodeTrack(sectors, 5);
    const rotated = new Uint16Array(words.length);
    rotated.set(words.subarray(3000));
    rotated.set(words.subarray(0, 3000), words.length - 3000);
    const decoded = new Uint8Array(TRACK_BYTES);
    expect(decodeTrack(rotated, 5, decoded)).toBe(11);
    expect(decoded).toEqual(sectors);
    rotated[100] ^= 0x0100;
    expect(decodeTrack(rotated, 5, new Uint8Array(TRACK_BYTES))).toBe(10);
  });

  it('never puts two one bits in a row (MFM clocking), except in sync words', () => {
    const words = encodeTrack(randomTrack(3), 0);
    for (let i = 0; i < words.length; i++) {
      if (words[i] === 0x4489) continue;
      const pair = ((words[i] << 1) | (i + 1 < words.length ? words[i + 1] >> 15 : 0)) & 0x1ffff;
      expect(pair & (pair >> 1), `word ${i}`).toBe(0);
    }
  });
});

describe('disk images', () => {
  it('turns away high-density and odd-sized images', () => {
    expect(() => FloppyDisk.fromAdf(new Uint8Array(ADF_SIZE * 2), 'hd.adf')).toThrow(/high-density/);
    expect(() => FloppyDisk.fromAdf(new Uint8Array(1000), 'odd.adf')).toThrow(/901,120/);
  });

  it('reads extended ADFs, with raw MFM tracks for copy-protected disks', () => {
    const header = new Uint8Array(12 + 2 * 12);
    header.set([...'UAE-1ADF'].map((char) => char.charCodeAt(0)));
    const view = new DataView(header.buffer);
    view.setUint16(10, 2);
    view.setUint16(12 + 2, 0);
    view.setUint32(12 + 4, TRACK_BYTES);
    view.setUint32(12 + 8, TRACK_BYTES * 8);
    view.setUint16(24 + 2, 1);
    view.setUint32(24 + 4, 8);
    view.setUint32(24 + 8, 64);
    const sectors = randomTrack(4);
    const raw = new Uint8Array([0x44, 0x89, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]);
    const file = new Uint8Array(header.length + TRACK_BYTES + raw.length);
    file.set(header);
    file.set(sectors, header.length);
    file.set(raw, header.length + TRACK_BYTES);
    const disk = FloppyDisk.fromAdf(file, 'protected.adf');
    expect([...disk.track(1)]).toEqual([0x4489, 0x1234, 0x5678, 0x9abc]);
    const decoded = new Uint8Array(TRACK_BYTES);
    decodeTrack(disk.track(0), 0, decoded);
    expect(decoded).toEqual(sectors);
  });

  it('writes a track by disk DMA and decodes it back into the .adf', () => {
    const amiga = idleMachine();
    const disk = FloppyDisk.fromAdf(new Uint8Array(ADF_SIZE), 'blank.adf');
    amiga.insertDisk(0, disk);
    const replacement = randomTrack(5);
    const mfm = encodeTrack(replacement, 0);
    const buffer = 0x20000;
    mfm.forEach((word, i) => amiga.chip.write16(buffer + i * 2, word));
    // Motor on and drive 0 selected (CIA-B port B: /MTR and /SEL0 low); the port is set before its direction, as Kickstart does.
    amiga.ciaB.write(0x1, 0xff);
    amiga.ciaB.write(0x3, 0xff);
    amiga.ciaB.write(0x1, 0x7f);
    amiga.ciaB.write(0x1, 0x77);
    amiga.writeCustom(0x096, 0x8210);
    amiga.writeCustom(0x020, buffer >> 16);
    amiga.writeCustom(0x022, buffer & 0xffff);
    const length = 0xc000 | mfm.length;
    amiga.writeCustom(0x024, length);
    amiga.writeCustom(0x024, length);
    for (let frame = 0; frame < 15; frame++) amiga.runFrame();
    expect(amiga.paula.intreq & 0x0002).toBe(0x0002);
    expect(disk.dirty).toBe(true);
    expect(disk.toAdf().subarray(0, TRACK_BYTES)).toEqual(replacement);
  });
});

describe('booting from disk', () => {
  const rom = localKickstart('kick13.rom');

  it.skipIf(!rom)('Kickstart 1.3 loads a bootblock from DF0 and runs it', () => {
    const amiga = machineWith(rom!);
    amiga.insertDisk(0, FloppyDisk.fromAdf(bootableAdf(colourLoop(0x0f00)), 'boot.adf'));
    runSeconds(amiga, 10);
    screenshot(amiga, 'bootblock');
    expect(amiga.denise.colors[0]).toBe(0xf00);
  }, 120_000);

  it.skipIf(!rom)('Kickstart 1.3 finds the external drive DF1 by its ID, and leaves a missing one alone', () => {
    for (const connected of [true, false]) {
      const amiga = machineWith(rom!);
      amiga.setExternalDrive(connected);
      amiga.powerOn();
      const drive = amiga.drives[1];
      let selections = 0;
      let wasSelected = false;
      let motorRan = false;
      const step = amiga.agnus.step.bind(amiga.agnus);
      amiga.agnus.step = () => {
        step();
        if (drive.selected && !wasSelected) selections++;
        wasSelected = drive.selected;
        motorRan ||= drive.motor;
      };
      runSeconds(amiga, 8);
      // Reading the 32-bit drive ID takes 32 selections; then trackdisk uses the drive.
      if (connected) {
        expect(selections).toBeGreaterThan(32);
        expect(motorRan).toBe(true);
      } else {
        expect(selections).toBe(0);
        expect(motorRan).toBe(false);
      }
    }
  }, 120_000);

  it.skipIf(!rom)('Kickstart 1.3 boots a disk inserted at the insert-disk screen', () => {
    const amiga = machineWith(rom!);
    runSeconds(amiga, 6);
    amiga.insertDisk(0, FloppyDisk.fromAdf(bootableAdf(colourLoop(0x00f0)), 'boot.adf'));
    runSeconds(amiga, 8);
    expect(amiga.denise.colors[0]).toBe(0x0f0);
  }, 120_000);
});
