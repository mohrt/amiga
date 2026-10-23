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
/** The first BPL1DAT write of a line opens the output this many hires positions after it. */
const BPLDAT_LATENCY = 3;
/** Denise's horizontal counter goes from $1C7 on to $002. */
const COUNTER_WRAP = 0x1c8;
const COUNTER_RESTART = 0x002;
/** A drawing cycle c puts its first pixel at hires position 4c + 2. */
const DRAW_OFFSET = 2;

/** A 12-bit Amiga colour as canvas pixels (little-endian RGBA). */
export const RGBA = Uint32Array.from({ length: 0x1000 }, (_, rgb) => {
  const r = ((rgb >> 8) & 0xf) * 17;
  const g = ((rgb >> 4) & 0xf) * 17;
  const b = (rgb & 0xf) * 17;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
});

/** A 24-bit colour (0xRRGGBB) as a canvas pixel. */
const rgba = (rgb: number) => (0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)) >>> 0;
/** A 12-bit colour as 24 bits (each nibble twice). */
const expand12 = (value: number) => (((value & 0xf00) * 0x1100) | ((value & 0x0f0) * 0x110) | ((value & 0x00f) * 0x11)) >>> 0;

/** Dual playfield: the colour of playfield 1 (odd planes) and of playfield 2 (even planes) for each plane value. */
const DPF1 = Uint8Array.from({ length: 256 }, (_, v) => (v & 1) | ((v >> 1) & 2) | ((v >> 2) & 4) | ((v >> 3) & 8));
const DPF2 = Uint8Array.from({ length: 256 }, (_, v) => ((v >> 1) & 1) | ((v >> 2) & 2) | ((v >> 3) & 4) | ((v >> 4) & 8));
/** AGA's BPLCON3 PF2OF: the colour offset of playfield 2. */
const PF2_OFFSETS = [0, 2, 4, 8, 16, 32, 64, 128];

const BPLCON0_HIRES = 0x8000;
/** ECS super-hires (35 ns pixels, two to each hires position here: every other one is shown). */
const BPLCON0_SHRES = 0x0040;
/** ECS BPLCON3: the border is black. */
const BPLCON3_BRDRBLNK = 0x0020;
const BPLCON0_HAM = 0x0800;
const BPLCON0_DPF = 0x0400;
/** AGA's fourth plane-count bit. */
const BPLCON0_BPU3 = 0x0010;
/** AGA BPLCON3: the colour bank (bits 15-13), and LOCT, which makes colour writes set the low nibbles. */
const BPLCON3_LOCT = 0x0200;
/** AGA BPLCON2: no extra half-brite with six planes. */
const BPLCON2_KILLEHB = 0x0200;
/** AGA BPLCON2: colour registers read back (and ignore writes). */
const BPLCON2_RDRAM = 0x0100;
const NO_WORDS: readonly number[] = [];
/** How far right (in lores pixels) SSCAN2's second match of a sprite falls: SPRxPOS bit 7's weight. */
const SSCAN2_REPEAT = 256;
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
  /** The 12-bit colour registers as written (bank 0 on AGA). */
  readonly colors = new Uint16Array(32);
  /** Every colour register as 24 bits (256 on AGA, the first 32 otherwise), and as canvas pixels. */
  readonly rgb = new Uint32Array(256);
  private readonly palette = new Uint32Array(256).fill(RGBA[0]);
  bplcon0 = 0;
  bplcon1 = 0;
  bplcon2 = 0;
  /** ECS BPLCON3. */
  bplcon3 = 0;
  /** AGA BPLCON4: the XOR on bitplane colours (bits 15-8) and the even and odd sprites' colour banks. */
  bplcon4 = 0x0011;
  /** The data registers: four words for each of eight planes (AGA fetches up to 64 bits). */
  readonly bplDat = new Uint16Array(32);
  readonly sprPos = new Uint16Array(8);
  readonly sprCtl = new Uint16Array(8);
  /** Each sprite's data words, four apiece: AGA's wide sprites are 32 or 64 pixels. */
  readonly sprDataA = new Uint16Array(32);
  readonly sprDataB = new Uint16Array(32);
  /** How many of each sprite's data words its last SPRxDATA load carried. */
  readonly sprWords = new Uint8Array(8).fill(1);
  /** AGA's SSCAN2 (FMODE bit 15), which takes over SPRxPOS bit 7. */
  sscan2 = false;
  readonly sprArmed = new Uint8Array(8);
  clxcon = 0;
  clxdat = 0;
  /** The display window's horizontal edges, in lores positions. */
  diwHStart = 0x81;
  diwHStop = 0x1c1;
  /** The horizontal display window flip-flop. */
  private windowOpen = true;
  /**
   * Where the line's first BPL1DAT write opens the output (a little after it): before it the line
   * is border, sprites included, whatever DIWSTRT says.
   */
  private dataStartX = LINE_PIXELS;
  /** ECS Denise (Super Denise): DENISEID, and DIWHIGH's horizontal bit 8. */
  ecs = false;
  /** Lisa (AGA): 256 colours of 24 bits, eight planes, HAM8 and BPLCON4. */
  aga = false;
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
  /** The hires position each line starts at (Agnus sets it). */
  lineStartX = 0;

  reset(): void {
    this.colors.fill(0);
    this.rgb.fill(0);
    this.palette.fill(RGBA[0]);
    this.bplcon0 = this.bplcon1 = this.bplcon2 = this.bplcon3 = 0;
    this.bplcon4 = 0x0011;
    this.bplDat.fill(0);
    this.sprPos.fill(0);
    this.sprCtl.fill(0);
    this.sprDataA.fill(0);
    this.sprDataB.fill(0);
    this.sprWords.fill(1);
    this.sscan2 = false;
    this.sprArmed.fill(0);
    this.clxcon = this.clxdat = 0;
    this.spritesDirty = true;
  }

  get interlaced(): boolean {
    return (this.bplcon0 & BPLCON0_LACE) !== 0;
  }

  private get planeCount(): number {
    if (this.aga) return Math.min(8, ((this.bplcon0 >> 12) & 7) | (this.bplcon0 & BPLCON0_BPU3 ? 8 : 0));
    return Math.min(6, (this.bplcon0 >> 12) & 7);
  }

  // --- Lines -------------------------------------------------------------------------

  /** A new line: `frameLine` is its place in the picture (negative or past the end if not shown). */
  startLine(frameLine: number, longFrame: boolean): void {
    this.planes.fill(0);
    this.renderedTo = this.lineStartX;
    this.dataStartX = LINE_PIXELS;
    this.hamColor = this.rgb[0];
    this.spritesDirty = true;
    if (frameLine < 0 || frameLine >= this.outputLines) this.row = -1;
    else this.row = frameLine * 2 + (this.interlaced && !longFrame ? 1 : 0);
  }

  /** The vertical sync opens the horizontal window flip-flop (as vAmiga does; real machines agree in vAmigaTS's diw10). */
  verticalSync(): void {
    this.windowOpen = true;
  }

  /** Draws the rest of the line; outside interlace it is copied to the field's other row too. */
  finishLine(lineEnd: number): void {
    this.renderUpTo(lineEnd);
    if (this.row < 0) return;
    const start = this.row * FRAME_WIDTH;
    const drawn = Math.max(0, lineEnd - FIRST_X);
    if (drawn < FRAME_WIDTH) this.framebuffer.fill(this.palette[0], start + drawn, start + FRAME_WIDTH);
    if (!this.interlaced && this.row + 1 < MAX_FRAME_ROWS) {
      this.framebuffer.copyWithin(start + FRAME_WIDTH, start, start + FRAME_WIDTH);
    }
  }

  /**
   * BPL1DAT was written (by a fetch of plane 1, the last of a fetch unit, or by hand) at colour
   * clock `cck`: the data registers go to the shift registers. Each playfield's sixteen pixels come
   * out at its next drawing cycle, the first after the write whose position in the fetch unit is
   * its BPLCON1 scroll (in pairs of lores pixels; the odd value adds one).
   */
  drawWord(cck: number, words = 1): void {
    this.dataStartX = Math.min(this.dataStartX, this.beamX() + BPLDAT_LATENCY);
    const count = this.planeCount;
    const shres = this.ecs && (this.bplcon0 & BPLCON0_SHRES) !== 0;
    const hires = shres || (this.bplcon0 & BPLCON0_HIRES) !== 0;
    const unit = shres ? 1 : hires ? 3 : 7;
    // Each playfield's scroll: in lores pixels, six bits on AGA (BPLCON1 bits 10-11 or 14-15 on top).
    const bplcon1 = this.bplcon1;
    const oddScroll = (bplcon1 & 0xf) | (this.aga ? ((bplcon1 >> 10) & 3) << 4 : 0);
    const evenScroll = ((bplcon1 >> 4) & 0xf) | (this.aga ? ((bplcon1 >> 14) & 3) << 4 : 0);
    const step = unit + 1;
    const shift = shres ? 2 : hires ? 3 : 4;
    /**
     * The drawing cycle that loads the shift registers: the first after the write whose position
     * in a drawing cycle is the scroll's. When AGA fetches several words at once, it must also be
     * the drawing cycle (counted along the line) whose word the scroll's high bits pick.
     */
    const startX = (scroll: number) => {
      const target = (scroll >> 1) & unit;
      let cycle = cck + 1 + ((target - (cck + 1)) & unit);
      if (words > 1) {
        const slot = (scroll >> shift) & (words - 1);
        while (Math.floor(cycle / step) % words !== slot) cycle += step;
      }
      return cycle * 4 + DRAW_OFFSET + (scroll & 1) * 2;
    };
    const oddX = startX(oddScroll);
    const evenX = startX(evenScroll);
    const planes = this.planes;
    for (let p = 0; p < count; p++) {
      const mask = 1 << p;
      const clear = ~mask;
      let x = p & 1 ? evenX : oddX;
      for (let w = 0; w < words; w++) {
        const word = this.bplDat[p * 4 + w];
        if (shres) {
          for (let bit = 15; bit >= 0; bit -= 2, x++) planes[x] = (word >> bit) & 1 ? planes[x] | mask : planes[x] & clear;
        } else if (hires) {
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
  }

  // --- Registers ---------------------------------------------------------------------

  /** Brings the picture up to the beam, so a register change takes effect from here on. */
  private catchUp(): void {
    this.renderUpTo(this.beamX());
  }

  /**
   * COLORxx. AGA writes go to the register in BPLCON3's bank: with LOCT clear they set the high
   * nibbles of its components (and the low ones to the same, as for the older chips), with LOCT
   * set only the low nibbles.
   */
  writeColor(index: number, value: number): void {
    this.catchUp();
    if (!this.aga) {
      this.colors[index] = value & 0xfff;
      this.setColor(index, expand12(value));
      return;
    }
    if (this.bplcon2 & BPLCON2_RDRAM) return;
    const reg = ((this.bplcon3 >> 13) << 5) | index;
    if (this.bplcon3 & BPLCON3_LOCT) {
      const low = ((value & 0xf00) << 8) | ((value & 0x0f0) << 4) | (value & 0x00f);
      this.setColor(reg, ((this.rgb[reg] & 0xf0f0f0) | low) >>> 0);
      return;
    }
    if (reg < 32) this.colors[reg] = value & 0xfff;
    this.setColor(reg, expand12(value));
  }

  /**
   * A read of COLORxx: Lisa with BPLCON2's RDRAM set returns the register in BPLCON3's bank, its
   * components' high nibbles or with LOCT the low ones; the older chips' colours are write-only.
   */
  readColor(index: number): number {
    if (!this.aga || !(this.bplcon2 & BPLCON2_RDRAM)) return 0;
    const rgb = this.rgb[((this.bplcon3 >> 13) << 5) | index];
    const nibbles = this.bplcon3 & BPLCON3_LOCT ? rgb : rgb >> 4;
    return ((nibbles >> 8) & 0xf00) | ((nibbles >> 4) & 0x0f0) | (nibbles & 0x00f);
  }

  private setColor(reg: number, rgb: number): void {
    this.rgb[reg] = rgb;
    this.palette[reg] = rgba(rgb);
  }

  /** AGA BPLCON4. */
  writeBplcon4(value: number): void {
    this.catchUp();
    this.bplcon4 = value;
    this.spritesDirty = true;
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

  writeBplcon3(value: number): void {
    this.catchUp();
    this.bplcon3 = value;
  }

  /** A write to BPLxDAT from the CPU or the Copper; BPL1DAT loads the shift registers, as a fetch does. */
  writeBplDat(plane: number, value: number): void {
    this.bplDat[plane * 4] = value;
    if (plane === 0) {
      this.catchUp();
      this.drawWord(this.beamX() >> 2);
    }
  }

  /** DENISEID: $FC from ECS Denise, $F8 from Lisa; the original Denise doesn't answer. */
  get id(): number {
    return this.aga ? 0xf8 : this.ecs ? 0xfc : 0xffff;
  }

  /** ECS DIWHIGH: bit 8 of the horizontal start (bit 5) and stop (bit 13). */
  writeDiwHigh(value: number): void {
    if (!this.ecs) return;
    this.catchUp();
    this.diwHStart = (this.diwHStart & 0xff) | (value & 0x20 ? 0x100 : 0);
    this.diwHStop = (this.diwHStop & 0xff) | (value & 0x2000 ? 0x100 : 0);
  }

  /** DIWSTRT's horizontal start (Agnus takes the vertical part). */
  writeDiwStart(value: number): void {
    this.catchUp();
    this.diwHStart = value & 0xff;
  }

  /** DIWSTOP's horizontal stop, whose bit 8 is always set. */
  writeDiwStop(value: number): void {
    this.catchUp();
    this.diwHStop = (value & 0xff) | 0x100;
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

  /**
   * SPRxDATA: the low plane of the sprite's line; writing it switches the sprite on. An AGA wide
   * fetch brings `rest`, the words after the first (the CPU and the Copper write just one).
   */
  writeSprDataA(n: number, value: number, rest: readonly number[] = NO_WORDS): void {
    this.catchUp();
    this.loadSpriteWords(this.sprDataA, n, value, rest);
    this.sprArmed[n] = 1;
    this.spritesDirty = true;
  }

  writeSprDataB(n: number, value: number, rest: readonly number[] = NO_WORDS): void {
    this.catchUp();
    this.loadSpriteWords(this.sprDataB, n, value, rest);
    this.spritesDirty = true;
  }

  writeSscan2(on: boolean): void {
    this.catchUp();
    this.sscan2 = on;
    this.spritesDirty = true;
  }

  private loadSpriteWords(data: Uint16Array, n: number, value: number, rest: readonly number[]): void {
    data[n * 4] = value;
    for (let w = 0; w < rest.length; w++) data[n * 4 + 1 + w] = rest[w];
    this.sprWords[n] = rest.length + 1;
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
      // AGA's BPLCON4 picks the even and odd sprites' 16-colour banks (both colours 16-31 at first).
      const evenBase = this.aga ? ((this.bplcon4 >> 4) & 0xf) * 16 : 16;
      const oddBase = this.aga ? (this.bplcon4 & 0xf) * 16 : 16;
      const group = 1 << pair;
      // The even sprite goes on top of the odd one (or, attached, adds the colour's low bits).
      for (let n = odd; n >= even; n--) {
        if (!this.sprArmed[n]) continue;
        this.anySprite = true;
        // With SSCAN2 the comparator ignores SPRxPOS bit 7, so it matches the sprite twice a line.
        const position = this.sscan2 ? this.sprPos[n] & 0x7f : this.sprPos[n] & 0xff;
        const start = ((position << 1) | (this.sprCtl[n] & 1)) + 1;
        const width = this.sprWords[n] * 16;
        for (let i = 0; i < width * (this.sscan2 ? 2 : 1); i++) {
          const x = i < width ? start + i : start + SSCAN2_REPEAT + i - width;
          if (x < from || x >= LINE_LORES) continue;
          const word = n * 4 + ((i % width) >> 4);
          const bit = 15 - (i & 15);
          const value = ((this.sprDataA[word] >> bit) & 1) | (((this.sprDataB[word] >> bit) & 1) << 1);
          if (!value) continue;
          if (n === even || oddCollides) spriteGroups[x] |= group;
          if (attached) {
            // The odd sprite gives the colour's top two bits, the even one the bottom two.
            const current = spritePair[x] === pair && spriteColor[x] ? (spriteColor[x] - oddBase) & 0xf : 0;
            const combined = n === odd ? (current & 3) | (value << 2) : (current & 0xc) | value;
            spriteColor[x] = oddBase + combined;
          } else {
            spriteColor[x] = (n === odd ? oddBase : evenBase) + pair * 4 + value;
          }
          spritePair[x] = pair;
        }
      }
    }
  }

  /**
   * Turns the line into colours up to hires position `end`. The horizontal display window is a
   * flip-flop, set where Denise's counter (in lores positions, $1C7 followed by $002) matches
   * DIWSTRT and cleared where it matches DIWSTOP; a value it never reaches leaves it as it is,
   * from one line to the next.
   */
  renderUpTo(end: number): void {
    const from = this.renderedTo;
    if (end <= from) return;
    this.renderedTo = end;
    const visible = this.row >= 0;
    const start = Math.max(from, FIRST_X);
    const stop = Math.min(end, FIRST_X + FRAME_WIDTH);
    if (visible && start < stop && this.spritesDirty) this.placeSprites(start >> 1);
    const framebuffer = this.framebuffer;
    const rowStart = this.row * FRAME_WIDTH - FIRST_X;
    const border = this.ecs && this.bplcon3 & BPLCON3_BRDRBLNK ? RGBA[0] : this.palette[0];
    const hires = (this.bplcon0 & BPLCON0_HIRES) !== 0 || (this.ecs && (this.bplcon0 & BPLCON0_SHRES) !== 0);
    for (let x = from; x < end; x++) {
      if (!(x & 1)) {
        let counter = x >> 1;
        if (counter >= COUNTER_WRAP) counter -= COUNTER_WRAP - COUNTER_RESTART;
        if (counter === this.diwHStart) this.windowOpen = true;
        if (counter === this.diwHStop) this.windowOpen = false;
      }
      if (!visible || x < start || x >= stop) continue;
      const out = rowStart + x;
      if (!this.windowOpen || x < this.dataStartX) {
        framebuffer[out] = border;
        this.hamColor = this.rgb[0];
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

  /**
   * The colour at hires position `x` inside the display window, noting any collisions. The planes
   * give a colour register (from one playfield or two). In HAM the top two of six planes (or on
   * AGA the bottom two of eight) then say whether that register is the colour or whose bits
   * replace part of one component of the last.
   */
  private pixel(x: number): number {
    const value = this.planes[x];
    const lores = x >> 1;
    const bplcon0 = this.bplcon0;
    const bplcon2 = this.bplcon2;
    const aga = this.aga;
    const spriteColor = this.anySprite ? this.spriteColor[lores] : 0;
    if (this.anySprite || value) this.detectCollisions(value, this.anySprite ? this.spriteGroups[lores] : 0);
    const hamMode = (bplcon0 & BPLCON0_HAM) !== 0 && (aga || !(bplcon0 & BPLCON0_HIRES));
    const planes = this.planeCount;
    const ham8 = hamMode && aga && planes >= 7;
    const colorXor = aga ? this.bplcon4 >> 8 : 0;

    let index: number;
    let spriteInFront: boolean;
    if (bplcon0 & BPLCON0_DPF) {
      const pf1 = DPF1[value];
      const pf2 = DPF2[value];
      // A playfield whose sprite priority is invalid (above 4) shows its pixels in colour 0.
      if (pf1 && (!pf2 || !(bplcon2 & BPLCON2_PF2PRI))) {
        index = (bplcon2 & 7) > 4 ? 0 : pf1;
        spriteInFront = this.spritePair[lores] < (bplcon2 & 7);
      } else if (pf2) {
        const offset = aga ? PF2_OFFSETS[(this.bplcon3 >> 10) & 7] : 8;
        index = ((bplcon2 >> 3) & 7) > 4 ? 0 : (pf2 + offset) & 0xff;
        spriteInFront = this.spritePair[lores] < ((bplcon2 >> 3) & 7);
      } else {
        index = 0;
        spriteInFront = true;
      }
      index ^= colorXor;
    } else {
      // With an invalid PF2 priority (above 4), plane 5 blanks planes 1-4 where it is set (not in HAM).
      index = !hamMode && !aga && ((bplcon2 >> 3) & 7) > 4 && value & 0x10 ? value & 0x30 : value;
      spriteInFront = !index || this.spritePair[lores] < ((bplcon2 >> 3) & 7);
      index ^= colorXor;
    }

    if (hamMode) {
      const rgb = this.rgb;
      if (ham8) {
        const data = index & 0xfc;
        switch (value & 3) {
          case 0:
            this.hamColor = rgb[index >> 2];
            break;
          case 1:
            this.hamColor = (this.hamColor & 0xffff00) | data | (this.hamColor & 3);
            break;
          case 2:
            this.hamColor = (this.hamColor & 0x00ffff) | ((data | ((this.hamColor >> 16) & 3)) << 16);
            break;
          default:
            this.hamColor = (this.hamColor & 0xff00ff) | ((data | ((this.hamColor >> 8) & 3)) << 8);
        }
      } else {
        // HAM6: the original chips' 4-bit components fill the 8 (AGA leaves the low bits clear).
        const data = (index & 0xf) * (aga ? 0x10 : 0x11);
        switch ((value >> 4) & 3) {
          case 0:
            this.hamColor = rgb[index & 0xf];
            break;
          case 1:
            this.hamColor = (this.hamColor & 0xffff00) | data;
            break;
          case 2:
            this.hamColor = (this.hamColor & 0x00ffff) | (data << 16);
            break;
          default:
            this.hamColor = (this.hamColor & 0xff00ff) | (data << 8);
        }
      }
    }
    if (spriteColor && spriteInFront) return this.palette[spriteColor];
    if (hamMode) return rgba(this.hamColor);
    // Extra half-brite: the sixth plane halves one of the first 32 colours (AGA: only with exactly six planes, unless KILLEHB).
    const ehb = aga ? planes === 6 && !(bplcon2 & BPLCON2_KILLEHB) && !(bplcon0 & BPLCON0_DPF) : index >= 32;
    if (ehb && index >= 32) return aga ? rgba((this.rgb[index & 31] >> 1) & 0x7f7f7f) : RGBA[(this.colors[index & 31] >> 1) & 0x777];
    return this.palette[index];
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
