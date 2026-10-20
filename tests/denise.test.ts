import { describe, expect, it } from 'vitest';
import type { Amiga } from '../src/amiga';
import { FRAME_WIDTH, PICTURE_LEFT, RGBA } from '../src/denise/denise';
import { idleMachine } from './helpers/machine';

const PLANES = 0x10000;
const PLANE_SIZE = 0x4000;
/** The standard display window starts at lores $81, line $2C; the picture starts at line $1C. */
const LEFT = (0x81 - PICTURE_LEFT) * 2;
const TOP_ROW = (0x2c - 0x1c) * 2;

interface Display {
  planes: number;
  hires?: boolean;
  bplcon0?: number;
  bplcon1?: number;
  bplcon2?: number;
}

/** A 320×256 (or 640) display of `planes` bitplanes whose first word of each line is `words[plane]`. */
function display(amiga: Amiga, setup: Display, words: number[]): void {
  for (let p = 0; p < setup.planes; p++) {
    for (let line = 0; line < 256; line++) amiga.chip.write16(PLANES + p * PLANE_SIZE + line * 80, words[p] ?? 0);
    amiga.writeCustom(0x0e0 + p * 4, (PLANES + p * PLANE_SIZE) >> 16);
    amiga.writeCustom(0x0e2 + p * 4, (PLANES + p * PLANE_SIZE) & 0xffff);
  }
  const hires = setup.hires ?? false;
  amiga.writeCustom(0x100, setup.bplcon0 ?? ((setup.planes << 12) | (hires ? 0x8000 : 0) | 0x0200));
  amiga.writeCustom(0x102, setup.bplcon1 ?? 0);
  amiga.writeCustom(0x104, setup.bplcon2 ?? 0x24);
  amiga.writeCustom(0x08e, 0x2c81);
  amiga.writeCustom(0x090, 0x2cc1);
  amiga.writeCustom(0x092, hires ? 0x3c : 0x38);
  amiga.writeCustom(0x094, hires ? 0xd4 : 0xd0);
  // Lines are 80 bytes apart: a modulo takes the rest of the line.
  amiga.writeCustom(0x108, hires ? 0 : 40);
  amiga.writeCustom(0x10a, hires ? 0 : 40);
  amiga.writeCustom(0x096, 0x8300);
}

function runToLine(amiga: Amiga, line: number): void {
  while (amiga.agnus.vpos !== line) amiga.agnus.step();
}

const pixel = (amiga: Amiga, x: number, row = TOP_ROW) => amiga.denise.framebuffer[row * FRAME_WIDTH + x];
const colour = (rgb: number) => RGBA[rgb];

function setColours(amiga: Amiga, colours: number[]): void {
  colours.forEach((value, i) => amiga.writeCustom(0x180 + i * 2, value));
}

describe('Denise', () => {
  it('starts the first bitplane word at the display window, a lores pixel on two hires positions', () => {
    const amiga = idleMachine();
    setColours(amiga, [0x000, 0xf00]);
    display(amiga, { planes: 1 }, [0xa000]);
    runToLine(amiga, 0x2e);
    expect(pixel(amiga, LEFT - 1)).toBe(colour(0x000));
    expect(pixel(amiga, LEFT)).toBe(colour(0xf00));
    expect(pixel(amiga, LEFT + 1)).toBe(colour(0xf00));
    expect(pixel(amiga, LEFT + 2)).toBe(colour(0x000));
    expect(pixel(amiga, LEFT + 4)).toBe(colour(0xf00));
    // Both rows of the line outside interlace, and the line above the window is the background.
    expect(pixel(amiga, LEFT, TOP_ROW + 1)).toBe(colour(0xf00));
    expect(pixel(amiga, LEFT, TOP_ROW - 2)).toBe(colour(0x000));
  });

  it('shows hires pixels one per position', () => {
    const amiga = idleMachine();
    setColours(amiga, [0x000, 0x0f0]);
    display(amiga, { planes: 1, hires: true }, [0xa000]);
    runToLine(amiga, 0x2e);
    expect(pixel(amiga, LEFT)).toBe(colour(0x0f0));
    expect(pixel(amiga, LEFT + 1)).toBe(colour(0x000));
    expect(pixel(amiga, LEFT + 2)).toBe(colour(0x0f0));
  });

  it('scrolls the odd and even planes by BPLCON1', () => {
    const amiga = idleMachine();
    setColours(amiga, [0x000, 0xf00, 0x00f, 0xfff]);
    display(amiga, { planes: 2, bplcon1: 0x0030 }, [0x8000, 0x8000]);
    runToLine(amiga, 0x2e);
    expect(pixel(amiga, LEFT)).toBe(colour(0xf00));
    expect(pixel(amiga, LEFT + 6)).toBe(colour(0x00f));
  });

  it('shows the upper 32 colours at half brightness with six planes (extra half-brite)', () => {
    const amiga = idleMachine();
    setColours(amiga, [0x000, 0xeee]);
    display(amiga, { planes: 6 }, [0x8000, 0, 0, 0, 0, 0x8000]);
    runToLine(amiga, 0x2e);
    expect(pixel(amiga, LEFT)).toBe(colour(0x777));
  });

  it('holds and modifies the previous colour in HAM', () => {
    const amiga = idleMachine();
    setColours(amiga, [0x000, 0x123]);
    // Pixel 0: colour 1; pixel 1: set blue to $F; pixel 2: set red to $F; pixel 3: set green to $8.
    display(amiga, { planes: 6, bplcon0: 0x6a00 }, [0xe000, 0x6000, 0x6000, 0x7000, 0x5000, 0x3000]);
    runToLine(amiga, 0x2e);
    expect(pixel(amiga, LEFT)).toBe(colour(0x123));
    expect(pixel(amiga, LEFT + 2)).toBe(colour(0x12f));
    expect(pixel(amiga, LEFT + 4)).toBe(colour(0xf2f));
    expect(pixel(amiga, LEFT + 6)).toBe(colour(0xf8f));
  });

  it('puts playfield 2 in front of playfield 1 with PF2PRI, in dual playfield mode', () => {
    for (const [bplcon2, expected] of [
      [0x00, 0xf00],
      [0x40, 0x00f],
    ]) {
      const amiga = idleMachine();
      setColours(amiga, [0x000, 0xf00, 0, 0, 0, 0, 0, 0, 0x000, 0x00f]);
      display(amiga, { planes: 2, bplcon0: 0x2600, bplcon2 }, [0x8000, 0x8000]);
      runToLine(amiga, 0x2e);
      expect(pixel(amiga, LEFT)).toBe(colour(expected));
    }
  });

  it('draws a sprite from its registers, in front of the playfield or behind it by priority', () => {
    for (const [bplcon2, expected] of [
      [0x24, 0x0f0],
      [0x00, 0xf00],
    ]) {
      const amiga = idleMachine();
      setColours(amiga, [0x000, 0xf00]);
      amiga.writeCustom(0x1a2, 0x0f0);
      display(amiga, { planes: 1, bplcon2 }, [0xffff]);
      // Sprite 0 at lores $80 (shown from $81), written by the CPU: POS, CTL, then DATB and DATA (which arms it).
      amiga.writeCustom(0x140, 0x2c40);
      amiga.writeCustom(0x142, 0x3000);
      amiga.writeCustom(0x146, 0);
      amiga.writeCustom(0x144, 0x8000);
      runToLine(amiga, 0x2e);
      expect(pixel(amiga, LEFT)).toBe(colour(expected));
      expect(pixel(amiga, LEFT + 2)).toBe(colour(0xf00));
    }
  });

  it('combines attached sprites into 15 colours', () => {
    const amiga = idleMachine();
    setColours(amiga, [0x000]);
    amiga.writeCustom(0x180 + 2 * 16 + 2 * 0b0110, 0x0ff);
    display(amiga, { planes: 0 }, []);
    amiga.writeCustom(0x140, 0x2c48);
    amiga.writeCustom(0x142, 0x3000);
    amiga.writeCustom(0x148, 0x2c48);
    amiga.writeCustom(0x14a, 0x3080);
    amiga.writeCustom(0x146, 0x8000);
    amiga.writeCustom(0x144, 0x0000);
    amiga.writeCustom(0x14c, 0x8000);
    amiga.writeCustom(0x14e, 0x0000);
    runToLine(amiga, 0x2e);
    expect(pixel(amiga, (0x91 - PICTURE_LEFT) * 2)).toBe(colour(0x0ff));
  });

  it('notes collisions between sprites and playfields in CLXDAT', () => {
    const amiga = idleMachine();
    display(amiga, { planes: 1 }, [0xffff]);
    amiga.writeCustom(0x098, 0x0041);
    amiga.writeCustom(0x140, 0x2c40);
    amiga.writeCustom(0x142, 0x3000);
    amiga.writeCustom(0x144, 0x8000);
    runToLine(amiga, 0x2e);
    expect(amiga.readCustom(0x00e) & 0x0002).toBe(0x0002);
    expect(amiga.readCustom(0x00e) & 0x0002).toBe(0);
  });

  it('draws interlaced fields on alternate rows', () => {
    const amiga = idleMachine();
    setColours(amiga, [0x000, 0xf00]);
    display(amiga, { planes: 1, bplcon0: 0x1204 }, [0x8000]);
    // The frame after LACE is set is a short one, drawn on the odd rows.
    amiga.runFrame();
    expect(amiga.agnus.lof).toBe(false);
    display(amiga, { planes: 1, bplcon0: 0x1204 }, [0x8000]);
    runToLine(amiga, 0x2e);
    expect(pixel(amiga, LEFT, TOP_ROW + 1)).toBe(colour(0xf00));
  });
});
