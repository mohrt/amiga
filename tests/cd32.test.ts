import { describe, expect, it } from 'vitest';
import { Amiga } from '../src/amiga';
import { Akiko } from '../src/cd32/akiko';
import { CdImage } from '../src/cd32/disc';
import { modelById } from '../src/models';
import { colourCount, localKickstart, runSeconds, screenshot } from './helpers/machine';

const dma = { read8: () => 0, write8: () => {} };

/** An ISO of `sectors` sectors with a primary volume descriptor at 16 and its terminator at 17. */
function testIso(sectors: number): Uint8Array {
  const iso = new Uint8Array(2048 * sectors);
  iso.set([1, ...[...'CD001'].map((char) => char.charCodeAt(0)), 1], 16 * 2048);
  iso[17 * 2048] = 255;
  return iso;
}

describe('CD images', () => {
  it('makes an ISO one data track, its sectors framed as the drive reads them', () => {
    const disc = CdImage.fromIso(testIso(300));
    expect(disc.sectorCount).toBe(300);
    // First track 1, last track 1, lead-out at 300 + 150 frames = 00:06:00, track 1 at 00:02:00.
    expect(disc.toc.map((entry) => [entry[1], entry[3], entry[8], entry[9], entry[10]])).toEqual([
      [0x41, 0xa0, 1, 0, 0],
      [0x41, 0xa1, 1, 0, 0],
      [0x41, 0xa2, 0, 6, 0],
      [0x41, 0x01, 0, 2, 0],
    ]);
    const sector = new Uint8Array(2352);
    expect(disc.readSector(16, sector)).toBe(true);
    expect([...sector.subarray(0, 12)]).toEqual([0, ...new Array(10).fill(0xff), 0]);
    // The header: 16 + 150 = 166 frames = 00:02:16, mode 1, then the data.
    expect([...sector.subarray(12, 16)]).toEqual([0x00, 0x02, 0x16, 1]);
    expect(String.fromCharCode(...sector.subarray(17, 22))).toBe('CD001');
    expect(disc.readSector(300, sector)).toBe(false);
  });

  it('reads a CUE sheet: a data track and an audio track in one BIN, or a BIN each', () => {
    const data = new Uint8Array(2352 * 200).fill(1);
    const audio = new Uint8Array(2352 * 100).fill(2);
    const both = new Uint8Array(data.length + audio.length);
    both.set(data);
    both.set(audio, data.length);
    const single = CdImage.fromCue(
      ['FILE "game.bin" BINARY', '  TRACK 01 MODE1/2352', '    INDEX 01 00:00:00', '  TRACK 02 AUDIO', '    INDEX 00 00:02:50', '    INDEX 01 00:02:65'].join('\n'),
      new Map([['GAME.BIN', both]]),
    );
    expect(single.sectorCount).toBe(300);
    // Track 2 starts at 2:65 = 215 sectors; its control bits say audio.
    expect(single.toc[4][3]).toBe(0x02);
    expect(single.toc[4][1]).toBe(0x01);
    expect([single.toc[4][8], single.toc[4][9], single.toc[4][10]]).toEqual([0x00, 0x04, 0x65]);
    const separate = CdImage.fromCue(
      ['FILE "game (Track 1).bin" BINARY', 'TRACK 01 MODE1/2352', 'INDEX 01 00:00:00', 'FILE "game (Track 2).bin" BINARY', 'TRACK 02 AUDIO', 'INDEX 01 00:00:00'].join('\r\n'),
      new Map([
        ['game (Track 1).bin', data],
        ['game (Track 2).bin', audio],
      ]),
    );
    expect(separate.sectorCount).toBe(300);
    const sector = new Uint8Array(2352);
    expect(separate.readSector(250, sector)).toBe(true);
    expect(sector[0]).toBe(2);
    expect(() => CdImage.fromCue('FILE "missing.bin" BINARY', new Map())).toThrow(/missing\.bin/);
  });
});

describe('Akiko', () => {
  it('answers with its ID', () => {
    const akiko = new Akiko(dma, () => 312);
    expect([0, 1, 2, 3].map((i) => akiko.read8(0xb80000 + i))).toEqual([0xc0, 0xca, 0xca, 0xfe]);
  });

  it('turns 32 chunky pixels into eight planes', () => {
    const akiko = new Akiko(dma, () => 312);
    // The first pixel is 128 (plane 7), every other one 1 (plane 0).
    const longs = new Array(8).fill(0x01010101);
    longs[0] = 0x80010101;
    for (const long of longs) {
      akiko.write16(0xb80038, long >>> 16);
      akiko.write16(0xb8003a, long & 0xffff);
    }
    const planes = Array.from({ length: 8 }, () => ((akiko.read16(0xb80038) << 16) | akiko.read16(0xb8003a)) >>> 0);
    expect(planes[0]).toBe(0x7fffffff);
    expect(planes[7]).toBe(0x80000000);
    expect(planes.slice(1, 7)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('the CD32 (roms/kick31-cd32.rom and roms/cd32-ext.rom)', () => {
  const rom = localKickstart('kick31-cd32.rom');
  const extended = localKickstart('cd32-ext.rom');
  const cd32 = (disc: CdImage | null) => {
    const amiga = new Amiga();
    amiga.setModel(modelById('cd32'));
    amiga.setMemory({ chipKb: 2048, slowKb: 0, fastKb: 0 });
    amiga.setKickstart(rom!, extended!);
    amiga.akiko!.disc = disc;
    amiga.powerOn();
    return amiga;
  };

  it.skipIf(!rom || !extended)('shows its start screen with no disc in', () => {
    const amiga = cd32(null);
    runSeconds(amiga, 15);
    screenshot(amiga, 'CD32 - no disc');
    expect(colourCount(amiga), 'colours on screen').toBeGreaterThan(30);
  }, 120_000);

  it.skipIf(!rom || !extended)('reads the TOC and a disc\'s volume descriptor through Akiko', () => {
    const disc = CdImage.fromIso(testIso(400));
    const read = disc.readSector.bind(disc);
    const sectors = new Set<number>();
    disc.readSector = (lsn, into) => {
      sectors.add(lsn);
      return read(lsn, into);
    };
    const amiga = cd32(disc);
    runSeconds(amiga, 10);
    expect(sectors.has(16), 'primary volume descriptor read').toBe(true);
  }, 120_000);
});
