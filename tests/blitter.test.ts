import { describe, expect, it } from 'vitest';
import { Blitter, minterm } from '../src/agnus/blitter';
import { Reg } from '../src/custom/registers';
import { ChipRam } from '../src/memory/chip-ram';

const A = 0x1000;
const B = 0x2000;
const C = 0x3000;
const D = 0x4000;

function blitter(): { blitter: Blitter; chip: ChipRam } {
  const chip = new ChipRam(0x80000);
  return { blitter: new Blitter(chip), chip };
}

function setPointer(blit: Blitter, high: number, address: number): void {
  blit.write(high, address >>> 16);
  blit.write(high + 2, address & 0xffff);
}

describe('blitter', () => {
  it('computes all 256 logic functions', () => {
    const a = 0xf0f0;
    const b = 0xcccc;
    const c = 0xaaaa;
    for (let lf = 0; lf < 256; lf++) {
      let expected = 0;
      for (let bit = 0; bit < 16; bit++) {
        const index = (((a >> bit) & 1) << 2) | (((b >> bit) & 1) << 1) | ((c >> bit) & 1);
        if ((lf >> index) & 1) expected |= 1 << bit;
      }
      expect(minterm(lf, a, b, c)).toBe(expected);
    }
  });

  it('copies A to D shifted right, masking the first and last words, with modulos', () => {
    const { blitter: blit, chip } = blitter();
    // Two rows of two words, with a modulo of one word between rows.
    [0xffff, 0x0f0f, 0x1234, 0xaaaa, 0x5555, 0x9999].forEach((word, i) => chip.write16(A + i * 2, word));
    blit.write(Reg.BLTCON0, 0x49f0); // ASH 4, A and D, D = A
    blit.write(Reg.BLTCON1, 0);
    blit.write(Reg.BLTAFWM, 0x0fff);
    blit.write(Reg.BLTALWM, 0xfff0);
    blit.write(Reg.BLTAMOD, 2);
    blit.write(Reg.BLTDMOD, 0);
    setPointer(blit, Reg.BLTAPTH, A);
    setPointer(blit, Reg.BLTDPTH, D);
    blit.write(Reg.BLTSIZE, (2 << 6) | 2);
    expect(blit.busy).toBe(true);
    blit.finishNow();
    expect(blit.busy).toBe(false);
    const words = [0, 1, 2, 3].map((i) => chip.read16(D + i * 2));
    // Row 1: $0FFF >> 4, then ($0FFF << 12 | $0F00) >> 4 from the carried-over bits.
    expect(words[0]).toBe(0x00ff);
    expect(words[1]).toBe(0xf0f0);
    // Row 2 ($AAAA, $5555 after skipping $1234) starts with row 1's last word still in the shifter.
    expect(words[2]).toBe(0x00aa);
    expect(words[3]).toBe(0xa555);
  });

  it('copies descending, shifting left', () => {
    const { blitter: blit, chip } = blitter();
    chip.write16(A, 0x1234);
    chip.write16(A + 2, 0x5678);
    blit.write(Reg.BLTCON0, 0x89f0); // ASH 8
    blit.write(Reg.BLTCON1, 0x0002);
    setPointer(blit, Reg.BLTAPTH, A + 2);
    setPointer(blit, Reg.BLTDPTH, D + 2);
    blit.write(Reg.BLTSIZE, (1 << 6) | 2);
    blit.finishNow();
    expect(chip.read16(D + 2)).toBe(0x7800);
    expect(chip.read16(D)).toBe(0x3456);
  });

  it('fills between edges, inclusively and exclusively (dropping the left edge), right to left', () => {
    for (const [con1, expected] of [
      [0x000a, 0x3ffc],
      [0x0012, 0x1ffc],
    ] as const) {
      const { blitter: blit, chip } = blitter();
      chip.write16(A, 0x2004);
      blit.write(Reg.BLTCON0, 0x09f0);
      blit.write(Reg.BLTCON1, con1);
      setPointer(blit, Reg.BLTAPTH, A);
      setPointer(blit, Reg.BLTDPTH, D);
      blit.write(Reg.BLTSIZE, (1 << 6) | 1);
      blit.finishNow();
      expect(chip.read16(D)).toBe(expected);
    }
  });

  it('combines A, B and C, and reports whether every result was zero', () => {
    const { blitter: blit, chip } = blitter();
    chip.write16(A, 0xff00);
    chip.write16(B, 0xf0f0);
    chip.write16(C, 0x000f);
    blit.write(Reg.BLTCON0, 0x0fca); // A·B + ¬A·C, the usual cookie cut
    blit.write(Reg.BLTCON1, 0);
    for (const [high, address] of [
      [Reg.BLTAPTH, A],
      [Reg.BLTBPTH, B],
      [Reg.BLTCPTH, C],
      [Reg.BLTDPTH, D],
    ]) {
      setPointer(blit, high, address);
    }
    blit.write(Reg.BLTSIZE, (1 << 6) | 1);
    blit.finishNow();
    expect(chip.read16(D)).toBe(0xf00f);
    expect(blit.zero).toBe(false);
  });

  it('draws lines in all eight octants as Bresenham would', () => {
    const width = 40;
    const ends = [
      [70, 10],
      [10, 30],
      [-60, 25],
      [-15, 70],
      [-80, -20],
      [-5, -40],
      [55, -33],
      [12, -66],
    ];
    for (const [dxSigned, dySigned] of ends) {
      const { blitter: blit, chip } = blitter();
      const x0 = 160;
      const y0 = 100;
      const dx = Math.abs(dxSigned);
      const dy = Math.abs(dySigned);
      const xMajor = dx >= dy;
      const major = xMajor ? dx : dy;
      const minor = xMajor ? dy : dx;
      // SUD for mostly horizontal lines; SUL and AUL for the minor and major axes going backwards.
      const sud = xMajor ? 0x10 : 0;
      const sul = (xMajor ? dySigned < 0 : dxSigned < 0) ? 0x08 : 0;
      const aul = (xMajor ? dxSigned < 0 : dySigned < 0) ? 0x04 : 0;
      const error = 4 * minor - 2 * major;
      const start = D + y0 * width + (x0 >> 3);
      blit.write(Reg.BLTCON0, ((x0 & 15) << 12) | 0x0bca);
      blit.write(Reg.BLTCON1, sud | sul | aul | (error < 0 ? 0x40 : 0) | 0x0001);
      blit.write(Reg.BLTADAT, 0x8000);
      blit.write(Reg.BLTBDAT, 0xffff);
      blit.write(Reg.BLTAFWM, 0xffff);
      blit.write(Reg.BLTAMOD, (4 * (minor - major)) & 0xffff);
      blit.write(Reg.BLTBMOD, 4 * minor);
      blit.write(Reg.BLTCMOD, width);
      blit.write(Reg.BLTDMOD, width);
      blit.write(Reg.BLTAPTL, error & 0xffff);
      setPointer(blit, Reg.BLTCPTH, start & ~1);
      setPointer(blit, Reg.BLTDPTH, start & ~1);
      blit.write(Reg.BLTSIZE, ((major + 1) << 6) | 2);
      blit.finishNow();

      const expected = new Set<string>();
      let e = 2 * minor - major;
      let x = x0;
      let y = y0;
      for (let i = 0; i <= major; i++) {
        expected.add(`${x},${y}`);
        if (e >= 0) {
          if (xMajor) y += Math.sign(dySigned);
          else x += Math.sign(dxSigned);
          e += 2 * (minor - major);
        } else {
          e += 2 * minor;
        }
        if (xMajor) x += Math.sign(dxSigned);
        else y += Math.sign(dySigned);
      }
      const drawn = new Set<string>();
      for (let py = 0; py < 200; py++) {
        for (let px = 0; px < 320; px++) {
          if (chip.bytes[D + py * width + (px >> 3)] & (0x80 >> (px & 7))) drawn.add(`${px},${py}`);
        }
      }
      expect([...drawn].sort(), `line to ${dxSigned},${dySigned}`).toEqual([...expected].sort());
    }
  });
});
