/**
 * The picture is drawn in hires pixels: 720 of them (360 lores) from lores position $6D, which
 * centres the standard display window ($81 to $1C1) as a TV does. The line ends at $1C6; the
 * few positions after that show the background.
 */
export const FRAME_WIDTH = 720;
export const PICTURE_LEFT = 0x6d;
const FIRST_X = PICTURE_LEFT * 2;
/** Each line is drawn on two rows of the frame (the two fields of an interlaced picture). */
export const MAX_FRAME_ROWS = 2 * 288;
/** Hires positions in a line (227 or 228 colour clocks of 4), with room for scrolled words past the end. */
const LINE_PIXELS = 1024;
const LINE_LORES = LINE_PIXELS / 2;
/** Where the first pixel of a bitplane word fetched at colour clock c lands: lores position 2c + 3, as hires. */
const WORD_OFFSET = 6;

/** A 12-bit Amiga colour as canvas pixels (little-endian RGBA). */
export const RGBA = Uint32Array.from({ length: 0x1000 }, (_, rgb) => {
  const r = ((rgb >> 8) & 0xf) * 17;
  const g = ((rgb >> 4) & 0xf) * 17;
  const b = (rgb & 0xf) * 17;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
});

/** Dual playfield: the colour (0-7) of playfield 1 (odd planes) and of playfield 2 (even planes) for each plane value. */
const DPF1 = Uint8Array.from({ length: 64 }, (_, v) => (v & 1) | ((v >> 1) & 2) | ((v >> 2) & 4));
const DPF2 = Uint8Array.from({ length: 64 }, (_, v) => ((v >> 1) & 1) | ((v >> 2) & 2) | ((v >> 3) & 4));

const BPLCON0_HIRES = 0x8000;
const BPLCON0_HAM = 0x0800;
const BPLCON0_DPF = 0x0400;
const BPLCON0_LACE = 0x0004;
const BPLCON2_PF2PRI = 0x0040;

/** Which sprite pairs collide with each other in CLXDAT (bits 9-14). */
const SPRITE_PAIR_BITS: [number, number, number][] = [
  [0, 1, 0x0200],
  [0, 2, 0x0400],
  [0, 3, 0x0800],
  [1, 2, 0x1000],
  [1, 3, 0x2000],
  [2, 3, 0x4000],
];

/**
 * The Denise video chip: the colour registers, the bitplane shifters (lores
 * and hires, up to six planes, scrolled per playfield), single and dual
 * playfields with their priorities, hold-and-modify and extra-half-brite,
 * the eight sprites (attached in pairs for 15 colours) and the collision
 * detector. Agnus hands it each bitplane word as it is fetched and it marks
 * where the word's pixels fall in the line; it turns the line into colours
 * up to the beam whenever a register that changes the picture is written,
 * so colour changes from the Copper land mid-line where they should.
 */
export class Denise {
  readonly colors = new Uint16Array(32);
  bplcon0 = 0;
  bplcon1 = 0;
  bplcon2 = 0;
  readonly bplDat = new Uint16Array(6);
  readonly sprPos = new Uint16Array(8);
  readonly sprCtl = new Uint16Array(8);
  readonly sprDataA = new Uint16Array(8);
  readonly sprDataB = new Uint16Array(8);
  readonly sprArmed = new Uint8Array(8);
  clxcon = 0;
  clxdat = 0;
  /** The display window's horizontal edges, in lores positions. */
  diwHStart = 0x81;
  diwHStop = 0x1c1;
  /** Whether this line is inside the display window's height (Agnus decides). */
  private verticalDisplay = false;
  /** The plane bits of each hires position in the line. */
  private readonly planes = new Uint8Array(LINE_PIXELS + 64);
  /** Per lores position: the colour register (16-31) of the front sprite, or 0. */
  private readonly spriteColor = new Uint8Array(LINE_LORES);
  /** The pair (0-3) of that sprite. */
  private readonly spritePair = new Uint8Array(LINE_LORES);
  /** Per lores position: the sprite pairs with a pixel there, for collisions (bit n for pair n). */
  private readonly spriteGroups = new Uint8Array(LINE_LORES);
  private spritesDirty = true;
  private anySprite = false;
  private renderedTo = 0;
  /** The frame row this line is drawn on, or -1 above or below the picture. */
  private row = -1;
  private hamColor = 0;
  /** Lines of the picture (each drawn on two rows). */
  outputLines = 284;
  readonly framebuffer = new Uint32Array(FRAME_WIDTH * MAX_FRAME_ROWS);
  /** The beam's position as a hires position in the line (Agnus provides it). */
  beamX: () => number = () => 0;

  reset(): void {
    this.colors.fill(0);
    this.bplcon0 = this.bplcon1 = this.bplcon2 = 0;
    this.bplDat.fill(0);
    this.sprPos.fill(0);
    this.sprCtl.fill(0);
    this.sprDataA.fill(0);
    this.sprDataB.fill(0);
    this.sprArmed.fill(0);
    this.clxcon = this.clxdat = 0;
    this.spritesDirty = true;
  }

  get interlaced(): boolean {
    return (this.bplcon0 & BPLCON0_LACE) !== 0;
  }

  private get planeCount(): number {
    return Math.min(6, (this.bplcon0 >> 12) & 7);
  }

  // --- Lines -------------------------------------------------------------------------

  /** A new line: `frameLine` is its place in the picture (negative or past the end if not shown). */
  startLine(frameLine: number, verticalDisplay: boolean, longFrame: boolean): void {
    this.verticalDisplay = verticalDisplay;
    this.planes.fill(0);
    this.renderedTo = 0;
    this.hamColor = this.colors[0];
    this.spritesDirty = true;
    if (frameLine < 0 || frameLine >= this.outputLines) this.row = -1;
    else this.row = frameLine * 2 + (this.interlaced && !longFrame ? 1 : 0);
  }

  /** Draws the rest of the line; outside interlace it is copied to the field's other row too. */
  finishLine(lineEnd: number): void {
    this.renderUpTo(lineEnd);
    if (this.row < 0) return;
    const start = this.row * FRAME_WIDTH;
    const drawn = Math.max(0, lineEnd - FIRST_X);
    if (drawn < FRAME_WIDTH) this.framebuffer.fill(RGBA[this.colors[0]], start + drawn, start + FRAME_WIDTH);
    if (!this.interlaced && this.row + 1 < MAX_FRAME_ROWS) {
      this.framebuffer.copyWithin(start + FRAME_WIDTH, start, start + FRAME_WIDTH);
    }
  }

  /** Agnus fetched plane 1 (the last of a fetch unit) at colour clock `cck`: the planes' words start shifting out. */
  drawWord(cck: number): void {
    const count = this.planeCount;
    const hires = (this.bplcon0 & BPLCON0_HIRES) !== 0;
    const base = cck * 4 + WORD_OFFSET;
    const oddDelay = (this.bplcon1 & 0xf) * 2;
    const evenDelay = ((this.bplcon1 >> 4) & 0xf) * 2;
    const planes = this.planes;
    for (let p = 0; p < count; p++) {
      const word = this.bplDat[p];
      const mask = 1 << p;
      const clear = ~mask;
      let x = base + (p & 1 ? evenDelay : oddDelay);
      if (hires) {
        for (let bit = 15; bit >= 0; bit--, x++) planes[x] = (word >> bit) & 1 ? planes[x] | mask : planes[x] & clear;
      } else {
        for (let bit = 15; bit >= 0; bit--, x += 2) {
          const value = (word >> bit) & 1 ? planes[x] | mask : planes[x] & clear;
          planes[x] = value;
          planes[x + 1] = value;
        }
      }
    }
  }

  // --- Registers ---------------------------------------------------------------------

  /** Brings the picture up to the beam, so a register change takes effect from here on. */
  private catchUp(): void {
    this.renderUpTo(this.beamX());
  }

  writeColor(index: number, value: number): void {
    this.catchUp();
    this.colors[index] = value & 0xfff;
  }

  writeBplcon0(value: number): void {
    this.catchUp();
    this.bplcon0 = value;
  }

  writeBplcon1(value: number): void {
    this.catchUp();
    this.bplcon1 = value;
  }

  writeBplcon2(value: number): void {
    this.catchUp();
    this.bplcon2 = value;
  }

  writeDiw(start: number, stop: number): void {
    this.catchUp();
    this.diwHStart = start & 0xff;
    this.diwHStop = (stop & 0xff) | 0x100;
  }

  writeClxcon(value: number): void {
    this.clxcon = value;
  }

  readClxdat(): number {
    this.catchUp();
    const value = this.clxdat | 0x8000;
    this.clxdat = 0;
    return value;
  }

  /** SPRxPOS: the vertical start (Agnus keeps its own copy) and the horizontal position's high bits. */
  writeSprPos(n: number, value: number): void {
    this.catchUp();
    this.sprPos[n] = value;
    this.spritesDirty = true;
  }

  /** SPRxCTL: the rest of the position and the attach bit; writing it switches the sprite off. */
  writeSprCtl(n: number, value: number): void {
    this.catchUp();
    this.sprCtl[n] = value;
    this.sprArmed[n] = 0;
    this.spritesDirty = true;
  }

  /** SPRxDATA: the low plane of the sprite's line; writing it switches the sprite on. */
  writeSprDataA(n: number, value: number): void {
    this.catchUp();
    this.sprDataA[n] = value;
    this.sprArmed[n] = 1;
    this.spritesDirty = true;
  }

  writeSprDataB(n: number, value: number): void {
    this.catchUp();
    this.sprDataB[n] = value;
    this.spritesDirty = true;
  }

  // --- Drawing -----------------------------------------------------------------------

  /** Where each armed sprite's 16 pixels fall in the line, from lores position `from` on. */
  private placeSprites(from: number): void {
    const { spriteColor, spritePair, spriteGroups } = this;
    spriteColor.fill(0, from);
    spritePair.fill(0, from);
    spriteGroups.fill(0, from);
    this.spritesDirty = false;
    this.anySprite = false;
    // Lower-numbered pairs are in front, so they are placed last.
    for (let pair = 3; pair >= 0; pair--) {
      const even = pair * 2;
      const odd = even + 1;
      const attached = (this.sprCtl[odd] & 0x80) !== 0;
      const oddCollides = (this.clxcon >> (12 + pair)) & 1;
      const group = 1 << pair;
      // The even sprite goes on top of the odd one (or, attached, adds the colour's low bits).
      for (let n = odd; n >= even; n--) {
        if (!this.sprArmed[n]) continue;
        this.anySprite = true;
        const start = (((this.sprPos[n] & 0xff) << 1) | (this.sprCtl[n] & 1)) + 1;
        const a = this.sprDataA[n];
        const b = this.sprDataB[n];
        for (let i = 0; i < 16; i++) {
          const x = start + i;
          if (x < from || x >= LINE_LORES) continue;
          const value = ((a >> (15 - i)) & 1) | (((b >> (15 - i)) & 1) << 1);
          if (!value) continue;
          if (n === even || oddCollides) spriteGroups[x] |= group;
          if (attached) {
            // The odd sprite gives the colour's top two bits, the even one the bottom two.
            const current = spritePair[x] === pair && spriteColor[x] ? spriteColor[x] - 16 : 0;
            const combined = n === odd ? (current & 3) | (value << 2) : (current & 0xc) | value;
            spriteColor[x] = 16 + combined;
          } else {
            spriteColor[x] = 16 + pair * 4 + value;
          }
          spritePair[x] = pair;
        }
      }
    }
  }

  /** Turns the line into colours up to hires position `end`. */
  renderUpTo(end: number): void {
    const from = this.renderedTo;
    if (end <= from) return;
    this.renderedTo = end;
    if (this.row < 0) return;
    const start = Math.max(from, FIRST_X);
    const stop = Math.min(end, FIRST_X + FRAME_WIDTH);
    if (start >= stop) return;
    if (this.spritesDirty) this.placeSprites(start >> 1);

    const framebuffer = this.framebuffer;
    let out = this.row * FRAME_WIDTH + (start - FIRST_X);
    const background = RGBA[this.colors[0]];
    if (!this.verticalDisplay) {
      framebuffer.fill(background, out, out + (stop - start));
      return;
    }
    const windowStart = this.diwHStart * 2;
    const windowStop = this.diwHStop * 2;
    // A stop before the start leaves the window open across the end of the line.
    const wraps = windowStop <= windowStart;
    const hires = (this.bplcon0 & BPLCON0_HIRES) !== 0;
    for (let x = start; x < stop; x++, out++) {
      if (wraps ? x < windowStart && x >= windowStop : x < windowStart || x >= windowStop) {
        framebuffer[out] = background;
        continue;
      }
      // Lores and HAM pixels are worked out once, on the first of their two hires positions.
      if (!hires && x & 1 && x !== start) {
        framebuffer[out] = framebuffer[out - 1];
        continue;
      }
      framebuffer[out] = this.pixel(x);
    }
  }

  /** The colour at hires position `x` inside the display window, noting any collisions. */
  private pixel(x: number): number {
    const value = this.planes[x];
    const lores = x >> 1;
    const colors = this.colors;
    const bplcon0 = this.bplcon0;
    const spriteColor = this.anySprite ? this.spriteColor[lores] : 0;
    if (this.anySprite || value) this.detectCollisions(value, this.anySprite ? this.spriteGroups[lores] : 0);

    if (bplcon0 & BPLCON0_DPF) {
      const pf1 = DPF1[value];
      const pf2 = DPF2[value];
      const pf2Front = (this.bplcon2 & BPLCON2_PF2PRI) !== 0;
      let front = 0;
      let frontColor = 0;
      if (pf1 && (!pf2 || !pf2Front)) {
        front = 1;
        frontColor = colors[pf1];
      } else if (pf2) {
        front = 2;
        frontColor = colors[8 + pf2];
      }
      if (spriteColor) {
        const priority = front === 1 ? this.bplcon2 & 7 : (this.bplcon2 >> 3) & 7;
        if (!front || this.spritePair[lores] < priority) return RGBA[colors[spriteColor]];
      }
      return RGBA[front ? frontColor : colors[0]];
    }

    let color: number;
    if (bplcon0 & BPLCON0_HAM && this.planeCount >= 5) {
      const data = value & 0xf;
      switch (value >> 4) {
        case 0:
          this.hamColor = colors[data];
          break;
        case 1:
          this.hamColor = (this.hamColor & 0xff0) | data;
          break;
        case 2:
          this.hamColor = (this.hamColor & 0x0ff) | (data << 8);
          break;
        default:
          this.hamColor = (this.hamColor & 0xf0f) | (data << 4);
      }
      color = this.hamColor;
    } else if (value >= 32) {
      color = (colors[value & 31] >> 1) & 0x777;
    } else {
      color = colors[value];
    }
    if (spriteColor && (!value || this.spritePair[lores] < ((this.bplcon2 >> 3) & 7))) return RGBA[colors[spriteColor]];
    return RGBA[color];
  }

  private detectCollisions(value: number, groups: number): void {
    const clxcon = this.clxcon;
    // Planes that aren't enabled for collisions always match.
    const mismatch = (value ^ clxcon) & (clxcon >> 6) & 0x3f;
    const pf1 = (mismatch & 0x15) === 0;
    const pf2 = (mismatch & 0x2a) === 0;
    let bits = 0;
    if (pf1 && pf2) bits |= 1;
    if (groups) {
      for (let pair = 0; pair < 4; pair++) {
        if (!(groups & (1 << pair))) continue;
        if (pf1) bits |= 2 << pair;
        if (pf2) bits |= 0x20 << pair;
      }
      for (const [first, second, bit] of SPRITE_PAIR_BITS) {
        if (groups & (1 << first) && groups & (1 << second)) bits |= bit;
      }
    }
    this.clxdat |= bits;
  }
}
