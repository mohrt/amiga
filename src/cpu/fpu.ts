/** What the FPU needs of the CPU: its registers, its instruction stream, memory and effective addresses, and traps. */
export interface FpuHost {
  readonly d: Uint32Array;
  readonly a: Uint32Array;
  pc: number;
  /** The address of the instruction being run (FPIAR, and the PC traps stack). */
  readonly instructionAddress: number;
  readonly supervisor: boolean;
  fetch16(): number;
  fetch32(): number;
  /** The address of a memory operand in modes 2, 5, 6 and 7 (absolute and PC-relative). */
  address(mode: number, reg: number): number;
  read8(address: number): number;
  read16(address: number): number;
  read32(address: number): number;
  write8(address: number, value: number): void;
  write16(address: number, value: number): void;
  write32(address: number, value: number): void;
  /** Takes an exception through `vector`. */
  trap(vector: number): void;
  addCycles(cycles: number): void;
}

const VECTOR_ILLEGAL = 4;
const VECTOR_PRIVILEGE = 8;
const VECTOR_LINE_F = 11;
const VECTOR_TRAPCC = 7;

/** Operand formats in the instruction's source-specifier field, and their sizes in bytes. */
const FORMAT_LONG = 0;
const FORMAT_SINGLE = 1;
const FORMAT_EXTENDED = 2;
const FORMAT_PACKED = 3;
const FORMAT_WORD = 4;
const FORMAT_DOUBLE = 5;
const FORMAT_BYTE = 6;
const FORMAT_PACKED_DYNAMIC = 7;
const FORMAT_BYTES = [4, 4, 12, 12, 2, 8, 1, 12];

/** FPSR condition codes (bits 27-24) and FPCR's rounding precision and mode. */
const CC_N = 0x08000000;
const CC_Z = 0x04000000;
const CC_I = 0x02000000;
const CC_NAN = 0x01000000;
const PRECISION_SINGLE = 1;
const PRECISION_DOUBLE = 2;

/** FSAVE's idle frame of a 68882: its version, and the bytes after the header. */
const FRAME_VERSION = 0x20;
const FRAME_SIZE = 0x38;
/** Cycles an FPU instruction is counted as, beyond its memory accesses. */
const OPERATION_CYCLES = 20;

/** FMOVECR's constant ROM: offsets that hold a constant, and their values (beyond doubles, infinity). */
const CONSTANTS: Record<number, number> = {
  0x00: Math.PI,
  0x0b: Math.log10(2),
  0x0c: Math.E,
  0x0d: Math.LOG2E,
  0x0e: Math.LOG10E,
  0x0f: 0,
  0x30: Math.LN2,
  0x31: Math.LN10,
  0x32: 1,
  0x33: 10,
  0x34: 100,
  0x35: 1e4,
  0x36: 1e8,
  0x37: 1e16,
  0x38: 1e32,
  0x39: 1e64,
  0x3a: 1e128,
  0x3b: 1e256,
  0x3c: Infinity,
  0x3d: Infinity,
  0x3e: Infinity,
  0x3f: Infinity,
};

const scratch = new DataView(new ArrayBuffer(8));

/** A double from the 68881's extended format: sign and 15-bit exponent, then a 64-bit mantissa with its integer bit. */
export function fromExtended(high: number, mantissaHigh: number, mantissaLow: number): number {
  const sign = high & 0x80000000 ? -1 : 1;
  const exponent = (high >>> 16) & 0x7fff;
  const mantissa = (mantissaHigh >>> 0) * 2 ** 32 + (mantissaLow >>> 0);
  if (exponent === 0x7fff) return (mantissaHigh & 0x7fffffff) === 0 && mantissaLow === 0 ? sign * Infinity : NaN;
  if (mantissa === 0) return sign * 0;
  // Scale in two steps, so neither factor overflows on the way to a value a double can hold.
  const power = exponent - 16383 - 63;
  const half = Math.trunc(power / 2);
  return sign * mantissa * 2 ** half * 2 ** (power - half);
}

/** A double in the 68881's extended format: [sign and exponent << 16, mantissa high, mantissa low]. */
export function toExtended(value: number): [number, number, number] {
  scratch.setFloat64(0, value);
  const sign = scratch.getUint32(0) & 0x80000000;
  if (Number.isNaN(value)) return [0x7fff0000, 0xffffffff, 0xffffffff];
  if (!Number.isFinite(value)) return [(sign | 0x7fff0000) >>> 0, 0, 0];
  if (value === 0) return [sign >>> 0, 0, 0];
  const high = scratch.getUint32(0);
  const low = scratch.getUint32(4);
  let exponent = (high >>> 20) & 0x7ff;
  // The double's 52 fraction bits, with the integer bit made explicit, moved to the top of 64.
  let fractionHigh = (high & 0xfffff) >>> 0;
  let fractionLow = low;
  if (exponent === 0) {
    // A subnormal double: shift it up until its top bit is the integer bit.
    exponent = 1;
    while (!(fractionHigh & 0x100000)) {
      fractionHigh = ((fractionHigh << 1) | (fractionLow >>> 31)) >>> 0;
      fractionLow = (fractionLow << 1) >>> 0;
      exponent--;
    }
  } else {
    fractionHigh |= 0x100000;
  }
  const mantissaHigh = ((fractionHigh << 11) | (fractionLow >>> 21)) >>> 0;
  const mantissaLow = (fractionLow << 11) >>> 0;
  return [(sign | ((exponent - 1023 + 16383) << 16)) >>> 0, mantissaHigh, mantissaLow];
}

/**
 * A 68881/68882 floating-point unit for the 68030 Amigas, as coprocessor 1
 * (line F, $F200-$F3FF): eight registers held as doubles (rather than the
 * chip's 80-bit extended precision), FPCR, FPSR and FPIAR; FMOVE in every
 * format, FMOVEM, FMOVECR, the arithmetic and transcendental operations,
 * FBcc, FScc, FDBcc and FTRAPcc, and FSAVE/FRESTORE with a 68882's frames.
 * Exceptions the FPCR could enable aren't raised; their status bits aren't kept.
 */
export class Fpu {
  readonly fp = new Float64Array(8);
  fpcr = 0;
  fpsr = 0;
  fpiar = 0;
  /** Whether it has done anything since a reset (FSAVE gives a null frame until then). */
  private used = false;

  constructor(private readonly cpu: FpuHost) {}

  reset(): void {
    this.fp.fill(NaN);
    this.fpcr = this.fpsr = this.fpiar = 0;
    this.used = false;
  }

  /** Runs an instruction from $F200-$F3FF. */
  execute(op: number): void {
    const type = (op >> 6) & 7;
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    this.cpu.addCycles(OPERATION_CYCLES);
    switch (type) {
      case 0:
        this.general(mode, reg);
        return;
      case 1:
        this.conditional(mode, reg);
        return;
      case 2:
      case 3:
        this.branch(op, type === 3);
        return;
      case 4:
        this.save(mode, reg);
        return;
      case 5:
        this.restore(mode, reg);
        return;
      default:
        this.cpu.trap(VECTOR_LINE_F);
    }
  }

  // --- Operands --------------------------------------------------------------------

  /** The address of a memory operand of `size` bytes ((An)+ and -(An) step by the whole size). */
  private operandAddress(mode: number, reg: number, size: number): number {
    const a = this.cpu.a;
    if (mode === 3) {
      const address = a[reg];
      a[reg] = (address + (size === 1 && reg === 7 ? 2 : size)) >>> 0;
      return address;
    }
    if (mode === 4) {
      a[reg] = (a[reg] - (size === 1 && reg === 7 ? 2 : size)) >>> 0;
      return a[reg];
    }
    if (mode === 7 && reg === 4) {
      // An immediate: a byte or word is in the low half of a word.
      const address = (this.cpu.pc + (size === 1 ? 1 : 0)) >>> 0;
      this.cpu.pc = (this.cpu.pc + Math.max(2, size)) >>> 0;
      return address;
    }
    return this.cpu.address(mode, reg);
  }

  /** A source operand in `format`, from a data register or memory. */
  private readOperand(format: number, mode: number, reg: number): number {
    if (mode === 0) {
      const value = this.cpu.d[reg];
      switch (format) {
        case FORMAT_LONG:
          return value | 0;
        case FORMAT_SINGLE:
          scratch.setUint32(0, value);
          return scratch.getFloat32(0);
        case FORMAT_WORD:
          return (value << 16) >> 16;
        case FORMAT_BYTE:
          return (value << 24) >> 24;
        default:
          this.cpu.trap(VECTOR_ILLEGAL);
          return 0;
      }
    }
    const address = this.operandAddress(mode, reg, FORMAT_BYTES[format]);
    const cpu = this.cpu;
    switch (format) {
      case FORMAT_LONG:
        return cpu.read32(address) | 0;
      case FORMAT_SINGLE:
        scratch.setUint32(0, cpu.read32(address));
        return scratch.getFloat32(0);
      case FORMAT_EXTENDED:
        return fromExtended(cpu.read32(address), cpu.read32(address + 4), cpu.read32(address + 8));
      case FORMAT_PACKED:
      case FORMAT_PACKED_DYNAMIC:
        return this.readPacked(address);
      case FORMAT_WORD:
        return (cpu.read16(address) << 16) >> 16;
      case FORMAT_DOUBLE:
        scratch.setUint32(0, cpu.read32(address));
        scratch.setUint32(4, cpu.read32(address + 4));
        return scratch.getFloat64(0);
      default:
        return (cpu.read8(address) << 24) >> 24;
    }
  }

  /** FMOVE to a data register or memory, rounded (and for the integers, clamped) as the FPCR says. */
  private writeOperand(format: number, mode: number, reg: number, value: number, kFactor: number): void {
    const cpu = this.cpu;
    const integer = (bits: number) => {
      const limit = 2 ** (bits - 1);
      if (Number.isNaN(value)) return limit - 1;
      return Math.max(-limit, Math.min(limit - 1, this.round(value)));
    };
    if (mode === 0) {
      const d = cpu.d;
      if (format === FORMAT_LONG) d[reg] = integer(32) >>> 0;
      else if (format === FORMAT_WORD) d[reg] = (d[reg] & 0xffff0000) | (integer(16) & 0xffff);
      else if (format === FORMAT_BYTE) d[reg] = (d[reg] & 0xffffff00) | (integer(8) & 0xff);
      else if (format === FORMAT_SINGLE) {
        scratch.setFloat32(0, value);
        d[reg] = scratch.getUint32(0);
      } else cpu.trap(VECTOR_ILLEGAL);
      return;
    }
    const address = this.operandAddress(mode, reg, FORMAT_BYTES[format]);
    switch (format) {
      case FORMAT_LONG:
        cpu.write32(address, integer(32) >>> 0);
        break;
      case FORMAT_SINGLE:
        scratch.setFloat32(0, value);
        cpu.write32(address, scratch.getUint32(0));
        break;
      case FORMAT_EXTENDED: {
        const [high, mantissaHigh, mantissaLow] = toExtended(value);
        cpu.write32(address, high);
        cpu.write32(address + 4, mantissaHigh);
        cpu.write32(address + 8, mantissaLow);
        break;
      }
      case FORMAT_PACKED:
      case FORMAT_PACKED_DYNAMIC:
        this.writePacked(address, value, kFactor);
        break;
      case FORMAT_WORD:
        cpu.write16(address, integer(16) & 0xffff);
        break;
      case FORMAT_DOUBLE:
        scratch.setFloat64(0, value);
        cpu.write32(address, scratch.getUint32(0));
        cpu.write32(address + 4, scratch.getUint32(4));
        break;
      default:
        cpu.write8(address, integer(8) & 0xff);
    }
  }

  /** Packed decimal: a sign, a three-digit exponent with its sign, then one integer and 16 fraction digits. */
  private readPacked(address: number): number {
    const cpu = this.cpu;
    const high = cpu.read32(address);
    const middle = cpu.read32(address + 4);
    const low = cpu.read32(address + 8);
    const digit = (word: number, n: number) => (word >>> (28 - n * 4)) & 15;
    const exponent = digit(high, 1) * 100 + digit(high, 2) * 10 + digit(high, 3);
    let mantissa = `${high & 15}.`;
    for (let n = 0; n < 8; n++) mantissa += digit(middle, n);
    for (let n = 0; n < 8; n++) mantissa += digit(low, n);
    const value = Number(`${mantissa}e${high & 0x40000000 ? '-' : ''}${exponent}`);
    return high & 0x80000000 ? -value : value;
  }

  /** Packed decimal out: `kFactor` significant digits if positive (17 at most), else that many after the point. */
  private writePacked(address: number, value: number, kFactor: number): void {
    const cpu = this.cpu;
    const negative = value < 0 || Object.is(value, -0);
    const magnitude = Math.abs(value);
    const exponent = magnitude === 0 ? 0 : Math.floor(Math.log10(magnitude));
    const digits = kFactor > 0 ? Math.min(17, kFactor) : Math.max(1, Math.min(17, exponent + 1 - kFactor));
    const [mantissa, exponentText] = magnitude.toExponential(digits - 1).split('e');
    const all = mantissa.replace('.', '').padEnd(17, '0');
    const e = Math.abs(Number(exponentText));
    const nibbles = (text: string) => [...text].reduce((word, char) => ((word << 4) | Number(char)) >>> 0, 0);
    const high = ((negative ? 0x80000000 : 0) | (Number(exponentText) < 0 ? 0x40000000 : 0) | (nibbles(String(e).padStart(3, '0')) << 16) | Number(all[0])) >>> 0;
    cpu.write32(address, high);
    cpu.write32(address + 4, nibbles(all.slice(1, 9)));
    cpu.write32(address + 8, nibbles(all.slice(9, 17)));
  }

  /** Rounds to an integer as FPCR's mode says: to nearest (even), toward zero, down or up. */
  private round(value: number): number {
    switch ((this.fpcr >> 4) & 3) {
      case 1:
        return Math.trunc(value);
      case 2:
        return Math.floor(value);
      case 3:
        return Math.ceil(value);
      default: {
        const floor = Math.floor(value);
        const difference = value - floor;
        if (difference !== 0.5) return Math.round(value);
        return floor % 2 === 0 ? floor : floor + 1;
      }
    }
  }

  /** A result to FPCR's rounding precision, with the condition codes it sets. */
  private result(value: number, precision = (this.fpcr >> 6) & 3): number {
    if (precision === PRECISION_SINGLE) value = Math.fround(value);
    this.setConditions(value);
    return value;
  }

  private setConditions(value: number): void {
    let cc = 0;
    if (Number.isNaN(value)) cc = CC_NAN;
    else {
      if (value < 0 || Object.is(value, -0)) cc |= CC_N;
      if (value === 0) cc |= CC_Z;
      if (!Number.isFinite(value)) cc |= CC_I;
    }
    this.fpsr = ((this.fpsr & 0x00ffffff) | cc) >>> 0;
  }

  // --- The general instructions -----------------------------------------------------

  private general(mode: number, reg: number): void {
    const extension = this.cpu.fetch16();
    const kind = extension >> 13;
    this.used = true;
    switch (kind) {
      case 0:
      case 2:
        this.arithmetic(extension, mode, reg);
        return;
      case 3: {
        // FMOVE FPn to <ea>, in the destination format (with the packed k-factor).
        this.fpiar = this.cpu.instructionAddress;
        const format = (extension >> 10) & 7;
        const source = (extension >> 7) & 7;
        const k = format === FORMAT_PACKED_DYNAMIC ? (this.cpu.d[(extension >> 4) & 7] << 25) >> 25 : (extension << 25) >> 25;
        this.writeOperand(format, mode, reg, this.fp[source], k);
        return;
      }
      case 4:
      case 5:
        this.moveControl(extension, mode, reg, kind === 5);
        return;
      case 6:
      case 7:
        this.moveMultiple(extension, mode, reg, kind === 7);
        return;
      default:
        this.cpu.trap(VECTOR_LINE_F);
    }
  }

  private arithmetic(extension: number, mode: number, reg: number): void {
    const fromMemory = (extension & 0x4000) !== 0;
    const sourceSpec = (extension >> 10) & 7;
    const destination = (extension >> 7) & 7;
    const opmode = extension & 0x7f;
    this.fpiar = this.cpu.instructionAddress;
    // FMOVECR: a constant from the ROM.
    if (fromMemory && sourceSpec === 7) {
      this.fp[destination] = this.result(CONSTANTS[opmode] ?? 0);
      return;
    }
    const source = fromMemory ? this.readOperand(sourceSpec, mode, reg) : this.fp[sourceSpec];
    const fp = this.fp;
    const dest = fp[destination];
    // FSINCOS: the sine to FPn, the cosine to the register in the low three bits.
    if ((opmode & 0x78) === 0x30) {
      fp[opmode & 7] = Math.cos(source);
      fp[destination] = this.result(Math.sin(source));
      return;
    }
    let value: number;
    switch (opmode) {
      case 0x00:
      case 0x40:
      case 0x44:
        // FMOVE, FSMOVE and FDMOVE.
        value = source;
        break;
      case 0x01:
        value = this.round(source);
        break;
      case 0x02:
        value = Math.sinh(source);
        break;
      case 0x03:
        value = Math.trunc(source);
        break;
      case 0x04:
      case 0x41:
      case 0x45:
        value = Math.sqrt(source);
        break;
      case 0x06:
        value = Math.log1p(source);
        break;
      case 0x08:
        value = Math.expm1(source);
        break;
      case 0x09:
        value = Math.tanh(source);
        break;
      case 0x0a:
        value = Math.atan(source);
        break;
      case 0x0c:
        value = Math.asin(source);
        break;
      case 0x0d:
        value = Math.atanh(source);
        break;
      case 0x0e:
        value = Math.sin(source);
        break;
      case 0x0f:
        value = Math.tan(source);
        break;
      case 0x10:
        value = Math.exp(source);
        break;
      case 0x11:
        value = 2 ** source;
        break;
      case 0x12:
        value = 10 ** source;
        break;
      case 0x14:
        value = Math.log(source);
        break;
      case 0x15:
        value = Math.log10(source);
        break;
      case 0x16:
        value = Math.log2(source);
        break;
      case 0x18:
      case 0x58:
      case 0x5c:
        value = Math.abs(source);
        break;
      case 0x19:
        value = Math.cosh(source);
        break;
      case 0x1a:
      case 0x5a:
      case 0x5e:
        value = -source;
        break;
      case 0x1c:
        value = Math.acos(source);
        break;
      case 0x1d:
        value = Math.cos(source);
        break;
      case 0x1e:
        // FGETEXP: the unbiased exponent.
        value = source === 0 || !Number.isFinite(source) ? (Number.isNaN(source) || !Number.isFinite(source) ? NaN : source) : Math.floor(Math.log2(Math.abs(source)));
        break;
      case 0x1f: {
        // FGETMAN: the mantissa, from 1 up to 2.
        if (source === 0 || !Number.isFinite(source)) value = Number.isFinite(source) ? source : NaN;
        else value = source / 2 ** Math.floor(Math.log2(Math.abs(source)));
        break;
      }
      case 0x20:
      case 0x24:
      case 0x60:
      case 0x64:
        value = dest / source;
        break;
      case 0x21:
      case 0x25: {
        // FMOD (truncated quotient) and FREM (rounded to nearest), with the quotient's low bits in FPSR.
        const quotient = opmode === 0x21 ? Math.trunc(dest / source) : Math.round(dest / source);
        value = dest - quotient * source;
        const bits = (Math.abs(quotient) & 0x7f) | (quotient < 0 ? 0x80 : 0);
        this.fpsr = ((this.fpsr & 0xff00ffff) | (bits << 16)) >>> 0;
        break;
      }
      case 0x22:
      case 0x62:
      case 0x66:
        value = dest + source;
        break;
      case 0x23:
      case 0x27:
      case 0x63:
      case 0x67:
        value = dest * source;
        break;
      case 0x26:
        value = dest * 2 ** Math.trunc(source);
        break;
      case 0x28:
      case 0x68:
      case 0x6c:
        value = dest - source;
        break;
      case 0x38:
        // FCMP: the codes of the difference, the register unchanged.
        this.setConditions(dest === source ? (Object.is(dest, -0) && !Object.is(source, -0) ? -0 : 0) : dest - source);
        return;
      case 0x3a:
        // FTST.
        this.setConditions(source);
        return;
      default:
        this.cpu.trap(VECTOR_LINE_F);
        return;
    }
    // The single (FS...) and double (FD...) forms round to that precision whatever the FPCR says.
    const precision = opmode >= 0x40 ? (opmode & 4 ? PRECISION_DOUBLE : PRECISION_SINGLE) : opmode === 0x24 || opmode === 0x27 ? PRECISION_SINGLE : undefined;
    fp[destination] = this.result(value, precision);
  }

  /** FMOVE(M) of FPCR, FPSR and FPIAR (bits 12, 11 and 10), in that order up through memory. */
  private moveControl(extension: number, mode: number, reg: number, toMemory: boolean): void {
    const selected = [0x1000, 0x0800, 0x0400].filter((bit) => extension & bit);
    if (!selected.length) selected.push(0x0400);
    const get = (bit: number) => (bit === 0x1000 ? this.fpcr : bit === 0x0800 ? this.fpsr : this.fpiar);
    const set = (bit: number, value: number) => {
      if (bit === 0x1000) this.fpcr = value & 0xfff0;
      else if (bit === 0x0800) this.fpsr = value & 0x0ffffff8;
      else this.fpiar = value >>> 0;
    };
    if (mode === 0 || mode === 1) {
      const regs = mode === 0 ? this.cpu.d : this.cpu.a;
      if (toMemory) regs[reg] = get(selected[0]) >>> 0;
      else set(selected[0], regs[reg]);
      return;
    }
    if (mode === 7 && reg === 4 && !toMemory) {
      for (const bit of selected) set(bit, this.cpu.fetch32());
      return;
    }
    const size = selected.length * 4;
    let address: number;
    if (mode === 4) {
      this.cpu.a[reg] = (this.cpu.a[reg] - size) >>> 0;
      address = this.cpu.a[reg];
    } else if (mode === 3) {
      address = this.cpu.a[reg];
      this.cpu.a[reg] = (address + size) >>> 0;
    } else {
      address = this.cpu.address(mode, reg);
    }
    for (const bit of selected) {
      if (toMemory) this.cpu.write32(address, get(bit) >>> 0);
      else set(bit, this.cpu.read32(address));
      address += 4;
    }
  }

  /** FMOVEM of FP registers as extended values: a static or dynamic (Dn) list, reversed for -(An). */
  private moveMultiple(extension: number, mode: number, reg: number, toMemory: boolean): void {
    const list = extension & 0x0800 ? this.cpu.d[(extension >> 4) & 7] & 0xff : extension & 0xff;
    const predecrement = (extension & 0x1000) === 0;
    // In the control and postincrement forms bit 7 is FP0; in the predecrement form bit 0 is.
    const registers: number[] = [];
    for (let n = 0; n < 8; n++) if (list & (predecrement ? 1 << n : 0x80 >> n)) registers.push(n);
    const cpu = this.cpu;
    if (mode === 4) {
      let address = cpu.a[reg];
      for (const n of [...registers].reverse()) {
        address = (address - 12) >>> 0;
        this.writeExtended(address, this.fp[n]);
      }
      cpu.a[reg] = address;
      return;
    }
    let address = mode === 3 ? cpu.a[reg] : cpu.address(mode, reg);
    for (const n of registers) {
      if (toMemory) this.writeExtended(address, this.fp[n]);
      else this.fp[n] = fromExtended(cpu.read32(address), cpu.read32(address + 4), cpu.read32(address + 8));
      address = (address + 12) >>> 0;
    }
    if (mode === 3) cpu.a[reg] = address;
  }

  private writeExtended(address: number, value: number): void {
    const [high, mantissaHigh, mantissaLow] = toExtended(value);
    this.cpu.write32(address, high);
    this.cpu.write32(address + 4, mantissaHigh);
    this.cpu.write32(address + 8, mantissaLow);
  }

  // --- Conditions --------------------------------------------------------------------

  /** One of the 32 FPU conditions (the second 16 are the first, also signalling on NAN). */
  condition(predicate: number): boolean {
    const n = (this.fpsr & CC_N) !== 0;
    const z = (this.fpsr & CC_Z) !== 0;
    const nan = (this.fpsr & CC_NAN) !== 0;
    switch (predicate & 15) {
      case 0:
        return false;
      case 1:
        return z;
      case 2:
        return !(nan || z || n);
      case 3:
        return z || !(nan || n);
      case 4:
        return n && !(nan || z);
      case 5:
        return z || (n && !nan);
      case 6:
        return !(nan || z);
      case 7:
        return !nan;
      case 8:
        return nan;
      case 9:
        return nan || z;
      case 10:
        return nan || !(n || z);
      case 11:
        return nan || z || !n;
      case 12:
        return nan || (n && !z);
      case 13:
        return nan || z || n;
      case 14:
        return !z;
      default:
        return true;
    }
  }

  /** FScc, FDBcc and FTRAPcc ($F240-$F27F): the condition in an extension word. */
  private conditional(mode: number, reg: number): void {
    const predicate = this.cpu.fetch16() & 0x3f;
    const cpu = this.cpu;
    if (mode === 1) {
      // FDBcc: unless the condition holds, count Dn down and branch while it isn't -1.
      const displacement = (cpu.fetch16() << 16) >> 16;
      if (this.condition(predicate)) return;
      const count = ((cpu.d[reg] & 0xffff) - 1) & 0xffff;
      cpu.d[reg] = (cpu.d[reg] & 0xffff0000) | count;
      if (count !== 0xffff) cpu.pc = (cpu.pc - 2 + displacement) >>> 0;
      return;
    }
    if (mode === 7 && reg >= 2) {
      // FTRAPcc with a word, a long or no operand.
      if (reg === 2) cpu.fetch16();
      else if (reg === 3) cpu.fetch32();
      if (this.condition(predicate)) cpu.trap(VECTOR_TRAPCC);
      return;
    }
    const value = this.condition(predicate) ? 0xff : 0;
    if (mode === 0) cpu.d[reg] = (cpu.d[reg] & 0xffffff00) | value;
    else cpu.write8(this.operandAddress(mode, reg, 1), value);
  }

  /** FBcc with a 16- or 32-bit displacement (FNOP is FBF.W 0). */
  private branch(op: number, long: boolean): void {
    const cpu = this.cpu;
    const base = cpu.pc;
    const displacement = long ? cpu.fetch32() | 0 : (cpu.fetch16() << 16) >> 16;
    if (this.condition(op & 0x3f)) cpu.pc = (base + displacement) >>> 0;
  }

  // --- Context switching -------------------------------------------------------------

  /** FSAVE: a null frame until the FPU has been used, then an idle one (a 68882's). */
  private save(mode: number, reg: number): void {
    if (!this.cpu.supervisor) {
      this.cpu.trap(VECTOR_PRIVILEGE);
      return;
    }
    const size = this.used ? 4 + FRAME_SIZE : 4;
    const address = this.frameAddress(mode, reg, size);
    this.cpu.write32(address, this.used ? ((FRAME_VERSION << 24) | (FRAME_SIZE << 16)) >>> 0 : 0);
    for (let at = 4; at < size; at += 4) this.cpu.write32(address + at, at === size - 4 ? 0x70000000 : 0);
  }

  /** FRESTORE: a null frame resets the FPU; any other is taken as idle. */
  private restore(mode: number, reg: number): void {
    if (!this.cpu.supervisor) {
      this.cpu.trap(VECTOR_PRIVILEGE);
      return;
    }
    const cpu = this.cpu;
    const address = mode === 3 ? cpu.a[reg] : cpu.address(mode, reg);
    const header = cpu.read32(address);
    const version = header >>> 24;
    const size = version === 0 ? 4 : 4 + ((header >>> 16) & 0xff);
    if (mode === 3) cpu.a[reg] = (address + size) >>> 0;
    if (version === 0) this.reset();
    else this.used = true;
  }

  private frameAddress(mode: number, reg: number, size: number): number {
    const a = this.cpu.a;
    if (mode === 4) {
      a[reg] = (a[reg] - size) >>> 0;
      return a[reg];
    }
    return this.cpu.address(mode, reg);
  }
}
