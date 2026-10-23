import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Amiga } from '../src/amiga';
import { Akiko } from '../src/cd32/akiko';
import { CdImage } from '../src/cd32/disc';
import { modelById } from '../src/models';
import { colourCount, localKickstart, root, runSeconds, screenshot } from './helpers/machine';

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
  it('plays an audio track into the output, and says when it has started and ended', () => {
    // A data track of 200 sectors, then 2 sectors of audio at a steady left 0x1000, right -0x1000.
    const audio = new Uint8Array(2352 * 2);
    for (let i = 0; i < audio.length; i += 4) audio.set([0x00, 0x10, 0x00, 0xf0], i);
    const both = new Uint8Array(2352 * 200 + audio.length);
    both.set(audio, 2352 * 200);
    const disc = CdImage.fromCue(['FILE "a.bin" BINARY', 'TRACK 01 MODE1/2352', 'INDEX 01 00:00:00', 'TRACK 02 AUDIO', 'INDEX 01 00:02:50'].join('\n'), new Map([['a.bin', both]]));
    const akiko = new Akiko(dma, () => 312);
    akiko.disc = disc;
    const lines = (count: number) => {
      for (let i = 0; i < count; i++) akiko.tick();
    };
    lines(300);
    /** A command through $B80028, a byte at a time, with its checksum. */
    const send = (bytes: number[]) => {
      const sum = bytes.reduce((total, byte) => total + byte, 0);
      for (const byte of [...bytes, (0xff - sum) & 0xff]) akiko.write8(0xb80028, byte);
      lines(2);
    };
    /** The drive's result, read from $B80028. */
    const receive = (length: number) => Array.from({ length }, () => akiko.read8(0xb80028));
    send([0x07]);
    expect(receive(2)[0], 'status').toBe(0x07);
    receive(19);
    lines(300);
    expect(receive(3), 'the disc reported').toEqual([0x0a, 0x01, 0xf4]);
    // Play from 00:04:50 (sector 200) to 00:04:52.
    send([0x04, 0x00, 0x04, 0x50, 0x00, 0x04, 0x52, 0x00, 0, 0, 0, 0]);
    expect(receive(2)).toEqual([0x04, 0x42]);
    receive(1);
    lines(1000);
    expect(receive(2), 'play started').toEqual([0x04, 0x0b]);
    receive(1);
    // Subcode Q: track 2, index 1, 00:00:00 into it, 00:04:50 on the disc.
    send([0x06]);
    const q = receive(16);
    expect(q.slice(2, 13)).toEqual([0, 0x01, 0x02, 0x01, 0x00, 0x00, 0x00, 0, 0x00, 0x04, 0x50]);
    const out = new Float32Array(2);
    akiko.mix(out, 44100);
    expect(out[0]).toBeCloseTo(0x1000 * (0.5 / 32768));
    expect(out[1]).toBeCloseTo(-0x1000 * (0.5 / 32768));
    for (let i = 0; i < 588 * 2; i++) akiko.mix(out.fill(0), 44100);
    out.fill(0);
    akiko.mix(out, 44100);
    expect(out[0], 'silent after the end').toBe(0);
    lines(300);
    expect(receive(2), 'play ended').toEqual([0x04, 0x01]);
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

// CD images are never committed: put your own CD32 games (a .cue with its files) in disks/cd32/.
const CD_DIR = join(root, 'disks', 'cd32');
const cueSheets = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return cueSheets(path);
        return /\.cue$/i.test(name) ? [path] : [];
      });

const cds = cueSheets(CD_DIR);

describe.skipIf(cds.length === 0)('CD32 games from disks/cd32/', () => {
  const rom = localKickstart('kick31-cd32.rom');
  const extended = localKickstart('cd32-ext.rom');
  for (const cue of cds) {
    const name = basename(cue).replace(/\.cue$/i, '');
    it.skipIf(!rom || !extended)(`${name} boots from the CD and draws a picture`, () => {
      const sheet = readFileSync(cue, 'utf8');
      const files = new Map<string, Uint8Array>();
      for (const match of sheet.matchAll(/FILE\s+"(.+?)"/gi)) files.set(match[1], new Uint8Array(readFileSync(join(dirname(cue), match[1]))));
      const disc = CdImage.fromCue(sheet, files);
      const read = disc.readSector.bind(disc);
      let sectors = 0;
      disc.readSector = (lsn, into) => {
        sectors++;
        return read(lsn, into);
      };
      const amiga = new Amiga();
      amiga.setModel(modelById('cd32'));
      amiga.setMemory({ chipKb: 2048, slowKb: 0, fastKb: 0 });
      amiga.setKickstart(rom!, extended!);
      amiga.akiko!.disc = disc;
      amiga.powerOn();
      // A first boot formats the save memory, which takes a while.
      runSeconds(amiga, 60);
      screenshot(amiga, `CD32 - ${name}`);
      expect(sectors, 'sectors read from the disc').toBeGreaterThan(50);
      expect(colourCount(amiga), 'colours on screen').toBeGreaterThan(8);
    }, 300_000);
  }
});
