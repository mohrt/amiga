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

/**
 * The blitter's cycles, as a program per blit: for copies one per combination of A, B, C and D
 * (A in bit 3), with and without fill, and for lines one per combination of B and C. Each step
 * takes a cycle: `-` needs nothing, `i` needs the bus to be free but leaves it (to the CPU, even
 * with BLTPRI), `b` uses the bus, `d` writes D (on a copy's first word D isn't written yet, so it
 * is an idle cycle). `R` ends a word: the program starts again for the next one, or carries on
 * with the steps after it once the last word is done; `E` ends the blit. They follow the Hardware
 * Reference Manual's timing table and its errata, as vAmiga has them.
 */
const COPY_PROGRAMS = [
  'i iR - E',
  'i dR - dE',
  'i bR - E',
  'i b dR - dE',
  'i b iR - E',
  'i b dR - dE',
  'i b bR - E',
  'i b b dR - dE',
  'b iR - E',
  'b dR - dE',
  'b bR - E',
  'b b dR - dE',
  'b b iR - E',
  'b b dR - dE',
  'b b bR - E',
  'b b b dR - dE',
];
/** Fill changes the timing of four of them. */
const FILL_PROGRAMS: Record<number, string> = { 1: 'i d iR - dE', 5: 'i b d iR - dE', 9: 'b d iR - dE', 13: 'b b d iR - dE' };
const LINE_PROGRAMS = ['i i i iR - E', 'i b i dR - E', 'i b i i b iR - iE', 'i b b i b dR - iE'];

const STEP_IDLE = 1;
const STEP_BUS = 2;
const STEP_WRITE_D = 3;
const STEP_WORD_END = 4;
const STEP_BLIT_END = 8;

function compile(program: string): Uint8Array {
  return Uint8Array.from(program.split(' '), (step) => {
    const kind = step[0] === 'i' ? STEP_IDLE : step[0] === 'b' ? STEP_BUS : step[0] === 'd' ? STEP_WRITE_D : 0;
    return kind | (step.includes('R') ? STEP_WORD_END : 0) | (step.includes('E') ? STEP_BLIT_END : 0);
  });
}

/** All the programs: the copies (0-15), the copies with fill (16-31), then the lines (32-35). */
const PROGRAMS = [
  ...COPY_PROGRAMS.map(compile),
  ...COPY_PROGRAMS.map((program, use) => compile(FILL_PROGRAMS[use] ?? program)),
  ...LINE_PROGRAMS.map(compile),
];
const FILL_PROGRAM = 16;
const LINE_PROGRAM = 32;
/** The steps before a blit's program: BLTSIZE taking effect, then two start cycles that need the bus free. */
const SIZE_WRITTEN = -3;
const START1 = -2;
const START2 = -1;
/** Not blitting. */
const IDLE = -4;

export interface BlitterBus {
  /** Whether the blitter may use this cycle (no other DMA has it, blitter DMA is on, and the CPU hasn't priority). */
  free(): boolean;
  take(): void;
}

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
  /** DMACONR's BBUSY: from the blit's start until its last word. */
  busy = false;
  /** From BLTSIZE until the blit's last cycle (what the Copper waits for). */
  running = false;
  /** Every word written so far was zero (DMACONR's BZERO). */
  zero = true;
  /** Called when a blit finishes (it raises the BLIT interrupt and wakes a Copper waiting for it). */
  onDone: () => void = () => {};

  private width = 0;
  private height = 0;
  private x = 0;
  private y = 0;
  /** ECS: BLTCON0L, BLTSIZV and BLTSIZH. */
  ecs = false;
  /** The blit's height and width (from BLTSIZE, or BLTSIZV and BLTSIZH). */
  private sizeHeight = 0;
  private sizeWidth = 0;
  /** BLTSIZV, waiting for BLTSIZH. */
  private bigHeight = 0;
  /** The blit's program (an index into PROGRAMS, so a save state holds a number) and its next step. */
  private program = 0;
  private pc = IDLE;
  /** D isn't written on a copy's first word (its data comes through the pipeline a word later). */
  private lockD = true;
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
    this.busy = this.running = false;
    this.zero = true;
    this.pc = IDLE;
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
        this.start((value >> 6) & 0x3ff || 1024, value & 0x3f || 64);
        break;
      case Reg.BLTCON0L:
        if (this.ecs) this.con0 = (this.con0 & 0xff00) | (value & 0xff);
        break;
      case Reg.BLTSIZV:
        if (this.ecs) this.bigHeight = value & 0x7fff;
        break;
      case Reg.BLTSIZH:
        if (this.ecs) this.start(this.bigHeight || 0x8000, value & 0x7ff || 0x800);
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

  private start(height: number, width: number): void {
    this.sizeHeight = height;
    this.sizeWidth = width;
    this.running = true;
    this.pc = SIZE_WRITTEN;
  }

  /** Whether a blit is under way (one started by BLTSIZE in this cycle has its first step in the next). */
  get active(): boolean {
    return this.pc !== IDLE;
  }

  /** The blitter's step for this cycle; one that needs the bus waits for a cycle it can have. */
  step(bus: BlitterBus): void {
    const pc = this.pc;
    if (pc < 0) {
      if (pc === SIZE_WRITTEN) {
        this.pc = START1;
      } else if (pc === START1) {
        this.prepare();
        if (bus.free()) this.pc = START2;
      } else if (pc === START2 && bus.free()) {
        this.begin();
      }
      return;
    }
    const step = PROGRAMS[this.program][pc];
    const kind = step & 3;
    const usesBus = kind === STEP_BUS || (kind === STEP_WRITE_D && (!this.lockD || this.program >= LINE_PROGRAM));
    if (kind !== 0) {
      if (!bus.free()) return;
      if (usesBus) bus.take();
    }
    this.pc++;
    if (step & STEP_WORD_END) {
      this.lockD = false;
      const last = this.program >= LINE_PROGRAM ? this.linePixel() : this.areaWord();
      if (last) this.busy = false;
      else this.pc = 0;
    }
    if (step & STEP_BLIT_END) this.finish();
  }

  /** The first start cycle: BBUSY goes on and the counters are set. */
  private prepare(): void {
    this.height = this.sizeHeight;
    this.width = this.sizeWidth;
    this.x = this.y = 0;
    this.busy = true;
    this.zero = true;
  }

  /** The second start cycle: the blit's program begins in the next. */
  private begin(): void {
    this.aOld = this.bOld = 0;
    this.fillCarry = this.con1 & CON1_FCI ? 1 : 0;
    const use = (this.con0 >> 8) & 0xf;
    if (this.con1 & CON1_LINE) {
      this.program = LINE_PROGRAM + ((use >> 1) & 3);
      this.lockD = false;
      this.lineError = signed16(this.apt);
      this.lineSign = (this.con1 & CON1_SIGN) !== 0;
      this.lineShift = this.con0 >>> 12;
      const textureShift = this.con1 >>> 12;
      this.lineTexture = ((this.bdat << textureShift) | (this.bdat >>> (16 - textureShift))) & 0xffff;
      this.lineDotDone = false;
    } else {
      this.program = use + (this.con1 & (CON1_IFE | CON1_EFE) ? FILL_PROGRAM : 0);
      this.lockD = true;
    }
    this.pc = 0;
  }

  /** Runs the blit to its end at once (for tests and for loading save states). */
  finishNow(): void {
    const always: BlitterBus = { free: () => true, take: () => {} };
    while (this.running) this.step(always);
  }

  private finish(): void {
    this.busy = this.running = false;
    this.pc = IDLE;
    this.onDone();
  }

  /** Does a word of a copy; returns whether it was the last. */
  private areaWord(): boolean {
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

    if (++this.x < this.width) return false;
    this.x = 0;
    this.fillCarry = this.con1 & CON1_FCI ? 1 : 0;
    const sign = descending ? -1 : 1;
    if (con0 & CON0_USEA) this.apt = (this.apt + sign * this.amod) & POINTER_MASK;
    if (con0 & CON0_USEB) this.bpt = (this.bpt + sign * this.bmod) & POINTER_MASK;
    if (con0 & CON0_USEC) this.cpt = (this.cpt + sign * this.cmod) & POINTER_MASK;
    if (con0 & CON0_USED) this.dpt = (this.dpt + sign * this.dmod) & POINTER_MASK;
    return ++this.y >= this.height;
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

  /** Draws a pixel of a line; returns whether it was the last. */
  private linePixel(): boolean {
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

    if (++this.y < this.height) return false;
    // The registers are left as the hardware leaves them, for programs that carry on from there.
    this.dpt = this.cpt;
    this.apt = ((this.apt & 0xffff0000) | (this.lineError & 0xffff)) >>> 0;
    this.con0 = (this.con0 & 0x0fff) | (this.lineShift << 12);
    this.con1 = this.lineSign ? this.con1 | CON1_SIGN : this.con1 & ~CON1_SIGN;
    return true;
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
