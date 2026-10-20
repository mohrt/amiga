import type { ChipRam } from '../memory/chip-ram';
import { Reg } from '../custom/registers';

const CON0_USEA = 0x0800;
const CON0_USEB = 0x0400;
const CON0_USEC = 0x0200;
const CON0_USED = 0x0100;
const CON1_LINE = 0x0001;
const CON1_DESC = 0x0002;
const CON1_FCI = 0x0004;
const CON1_IFE = 0x0008;
const CON1_EFE = 0x0010;
// Line mode reuses BLTCON1's bits.
const CON1_SING = 0x0002;
const CON1_AUL = 0x0004;
const CON1_SUL = 0x0008;
const CON1_SUD = 0x0010;
const CON1_SIGN = 0x0040;

/** Colour clocks the blitter needs per word, by which of A, B, C and D it uses (A in bit 3). */
const CYCLES_PER_WORD = [2, 2, 2, 3, 3, 3, 3, 4, 2, 2, 2, 3, 3, 3, 4, 4];
const CYCLES_PER_LINE_PIXEL = 4;
/** The blitter starts a couple of cycles after BLTSIZE is written. */
const START_DELAY = 2;

const signed16 = (value: number) => ((value & 0xffff) ^ 0x8000) - 0x8000;
const POINTER_MASK = 0x1ffffe;

/** The blitter's logic function: for each bit, LF's bit (A<<2 | B<<1 | C) gives the result. */
export function minterm(lf: number, a: number, b: number, c: number): number {
  let d = 0;
  if (lf & 0x01) d |= ~a & ~b & ~c;
  if (lf & 0x02) d |= ~a & ~b & c;
  if (lf & 0x04) d |= ~a & b & ~c;
  if (lf & 0x08) d |= ~a & b & c;
  if (lf & 0x10) d |= a & ~b & ~c;
  if (lf & 0x20) d |= a & ~b & c;
  if (lf & 0x40) d |= a & b & ~c;
  if (lf & 0x80) d |= a & b & c;
  return d & 0xffff;
}

/**
 * The blitter: copies and combines up to three sources (A, B, C) into a
 * destination (D) with any of the 256 logic functions, shifting A and B and
 * masking A's first and last words, ascending or descending, with
 * inclusive or exclusive area fill; and in line mode draws lines (with a
 * texture, and one dot per row for filled shapes). It does a word whenever
 * it has collected that word's memory cycles from Agnus.
 */
export class Blitter {
  con0 = 0;
  con1 = 0;
  afwm = 0xffff;
  alwm = 0xffff;
  apt = 0;
  bpt = 0;
  cpt = 0;
  dpt = 0;
  amod = 0;
  bmod = 0;
  cmod = 0;
  dmod = 0;
  adat = 0;
  bdat = 0;
  cdat = 0;
  ddat = 0;
  busy = false;
  /** Every word written so far was zero (DMACONR's BZERO). */
  zero = true;
  /** Called when a blit finishes (it raises the BLIT interrupt). */
  onDone: () => void = () => {};

  private width = 0;
  private height = 0;
  private x = 0;
  private y = 0;
  private cyclesPerWord = 2;
  private cyclesCollected = 0;
  private aOld = 0;
  private bOld = 0;
  private fillCarry = 0;
  // Line mode
  private lineError = 0;
  private lineSign = false;
  private lineShift = 0;
  private lineTexture = 0;
  private lineDotDone = false;

  constructor(private readonly chip: ChipRam) {}

  reset(): void {
    this.con0 = this.con1 = 0;
    this.afwm = this.alwm = 0xffff;
    this.busy = false;
    this.zero = true;
  }

  /** Writes one of the blitter's registers; BLTSIZE starts a blit. */
  write(reg: number, value: number): void {
    switch (reg) {
      case Reg.BLTCON0:
        this.con0 = value;
        break;
      case Reg.BLTCON1:
        this.con1 = value;
        break;
      case Reg.BLTAFWM:
        this.afwm = value;
        break;
      case Reg.BLTALWM:
        this.alwm = value;
        break;
      case Reg.BLTCPTH:
        this.cpt = ((value << 16) | (this.cpt & 0xffff)) & POINTER_MASK;
        break;
      case Reg.BLTCPTL:
        this.cpt = ((this.cpt & 0xffff0000) | value) & POINTER_MASK;
        break;
      case Reg.BLTBPTH:
        this.bpt = ((value << 16) | (this.bpt & 0xffff)) & POINTER_MASK;
        break;
      case Reg.BLTBPTL:
        this.bpt = ((this.bpt & 0xffff0000) | value) & POINTER_MASK;
        break;
      case Reg.BLTAPTH:
        this.apt = ((value << 16) | (this.apt & 0xffff)) & POINTER_MASK;
        break;
      case Reg.BLTAPTL:
        // Line mode keeps its error term in the low word, odd values included.
        this.apt = ((this.apt & 0xffff0000) | value) >>> 0;
        break;
      case Reg.BLTDPTH:
        this.dpt = ((value << 16) | (this.dpt & 0xffff)) & POINTER_MASK;
        break;
      case Reg.BLTDPTL:
        this.dpt = ((this.dpt & 0xffff0000) | value) & POINTER_MASK;
        break;
      case Reg.BLTSIZE:
        this.start(value);
        break;
      case Reg.BLTCMOD:
        this.cmod = signed16(value & 0xfffe);
        break;
      case Reg.BLTBMOD:
        this.bmod = signed16(value & 0xfffe);
        break;
      case Reg.BLTAMOD:
        this.amod = signed16(value & 0xfffe);
        break;
      case Reg.BLTDMOD:
        this.dmod = signed16(value & 0xfffe);
        break;
      case Reg.BLTCDAT:
        this.cdat = value;
        break;
      case Reg.BLTBDAT:
        this.bdat = value;
        break;
      case Reg.BLTADAT:
        this.adat = value;
        break;
    }
  }

  private start(size: number): void {
    this.height = (size >> 6) & 0x3ff || 1024;
    this.width = size & 0x3f || 64;
    this.x = this.y = 0;
    this.aOld = this.bOld = 0;
    this.zero = true;
    this.busy = true;
    this.fillCarry = this.con1 & CON1_FCI ? 1 : 0;
    if (this.con1 & CON1_LINE) {
      this.cyclesPerWord = CYCLES_PER_LINE_PIXEL;
      this.lineError = signed16(this.apt);
      this.lineSign = (this.con1 & CON1_SIGN) !== 0;
      this.lineShift = this.con0 >>> 12;
      const textureShift = this.con1 >>> 12;
      this.lineTexture = ((this.bdat << textureShift) | (this.bdat >>> (16 - textureShift))) & 0xffff;
      this.lineDotDone = false;
    } else {
      this.cyclesPerWord = CYCLES_PER_WORD[(this.con0 >> 8) & 0xf];
    }
    this.cyclesCollected = -START_DELAY;
  }

  /** A memory cycle Agnus gave the blitter. */
  cycle(): void {
    if (++this.cyclesCollected < this.cyclesPerWord) return;
    this.cyclesCollected = 0;
    if (this.con1 & CON1_LINE) this.linePixel();
    else this.areaWord();
  }

  /** Runs the blit to its end at once (for tests and for loading save states). */
  finishNow(): void {
    while (this.busy) {
      this.cyclesCollected = this.cyclesPerWord;
      this.cycle();
    }
  }

  private finish(): void {
    this.busy = false;
    this.onDone();
  }

  private areaWord(): void {
    const { chip, con0 } = this;
    const descending = (this.con1 & CON1_DESC) !== 0;
    const step = descending ? -2 : 2;
    if (con0 & CON0_USEA) {
      this.adat = chip.read16(this.apt);
      this.apt = (this.apt + step) & POINTER_MASK;
    }
    if (con0 & CON0_USEB) {
      this.bdat = chip.read16(this.bpt);
      this.bpt = (this.bpt + step) & POINTER_MASK;
    }
    if (con0 & CON0_USEC) {
      this.cdat = chip.read16(this.cpt);
      this.cpt = (this.cpt + step) & POINTER_MASK;
    }

    let a = this.adat;
    if (this.x === 0) a &= this.afwm;
    if (this.x === this.width - 1) a &= this.alwm;
    const aShift = con0 >>> 12;
    const bShift = this.con1 >>> 12;
    let aShifted: number;
    let bShifted: number;
    if (descending) {
      aShifted = (((a << 16) | this.aOld) >>> (16 - aShift)) & 0xffff;
      bShifted = (((this.bdat << 16) | this.bOld) >>> (16 - bShift)) & 0xffff;
    } else {
      aShifted = (((this.aOld << 16) | a) >>> aShift) & 0xffff;
      bShifted = (((this.bOld << 16) | this.bdat) >>> bShift) & 0xffff;
    }
    this.aOld = a;
    this.bOld = this.bdat;

    let d = minterm(con0 & 0xff, aShifted, bShifted, this.cdat);
    if (this.con1 & (CON1_IFE | CON1_EFE)) d = this.fill(d);
    if (d) this.zero = false;
    this.ddat = d;
    if (con0 & CON0_USED) {
      chip.write16(this.dpt, d);
      this.dpt = (this.dpt + step) & POINTER_MASK;
    }

    if (++this.x < this.width) return;
    this.x = 0;
    this.fillCarry = this.con1 & CON1_FCI ? 1 : 0;
    const sign = descending ? -1 : 1;
    if (con0 & CON0_USEA) this.apt = (this.apt + sign * this.amod) & POINTER_MASK;
    if (con0 & CON0_USEB) this.bpt = (this.bpt + sign * this.bmod) & POINTER_MASK;
    if (con0 & CON0_USEC) this.cpt = (this.cpt + sign * this.cmod) & POINTER_MASK;
    if (con0 & CON0_USED) this.dpt = (this.dpt + sign * this.dmod) & POINTER_MASK;
    if (++this.y >= this.height) this.finish();
  }

  /** Area fill, from the word's right (low) bit leftwards, carrying between the words of a row. */
  private fill(d: number): number {
    const inclusive = (this.con1 & CON1_IFE) !== 0;
    let carry = this.fillCarry;
    let out = 0;
    for (let bit = 0; bit < 16; bit++) {
      const set = (d >> bit) & 1;
      if (inclusive) {
        out |= (carry | set) << bit;
        carry ^= set;
      } else {
        carry ^= set;
        out |= carry << bit;
      }
    }
    this.fillCarry = carry;
    return out;
  }

  private linePixel(): void {
    const { chip, con0, con1 } = this;
    if (con0 & CON0_USEC) this.cdat = chip.read16(this.cpt);
    const a = ((this.adat & this.afwm) >>> this.lineShift) & 0xffff;
    const b = this.lineTexture & 0x8000 ? 0xffff : 0;
    const d = minterm(con0 & 0xff, a, b, this.cdat);
    if (d) this.zero = false;
    this.ddat = d;
    if (con0 & CON0_USED && !(con1 & CON1_SING && this.lineDotDone)) chip.write16(this.cpt, d);
    this.lineDotDone = true;
    this.lineTexture = ((this.lineTexture << 1) | (this.lineTexture >>> 15)) & 0xffff;

    // SUD ("sometimes up or down"): the line is mostly horizontal, so Y is the axis that only steps sometimes.
    if (!this.lineSign) {
      this.lineError += this.amod;
      if (con1 & CON1_SUD) this.lineStepY(con1 & CON1_SUL ? -1 : 1);
      else this.lineStepX(con1 & CON1_SUL ? -1 : 1);
    } else {
      this.lineError += this.bmod;
    }
    if (con1 & CON1_SUD) this.lineStepX(con1 & CON1_AUL ? -1 : 1);
    else this.lineStepY(con1 & CON1_AUL ? -1 : 1);
    this.lineError = signed16(this.lineError);
    this.lineSign = this.lineError < 0;

    if (++this.y < this.height) return;
    // The registers are left as the hardware leaves them, for programs that carry on from there.
    this.dpt = this.cpt;
    this.apt = ((this.apt & 0xffff0000) | (this.lineError & 0xffff)) >>> 0;
    this.con0 = (this.con0 & 0x0fff) | (this.lineShift << 12);
    this.con1 = this.lineSign ? this.con1 | CON1_SIGN : this.con1 & ~CON1_SIGN;
    this.finish();
  }

  private lineStepX(direction: number): void {
    this.lineShift += direction;
    if (this.lineShift > 15) {
      this.lineShift = 0;
      this.cpt = (this.cpt + 2) & POINTER_MASK;
    } else if (this.lineShift < 0) {
      this.lineShift = 15;
      this.cpt = (this.cpt - 2) & POINTER_MASK;
    }
  }

  private lineStepY(direction: number): void {
    this.cpt = (this.cpt + direction * this.cmod) & POINTER_MASK;
    this.lineDotDone = false;
  }
}
