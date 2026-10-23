/** What the 68000 sees of the machine: a 24-bit address bus of bytes and big-endian words. */
export interface M68kBus {
  read8(address: number): number;
  read16(address: number): number;
  write8(address: number, value: number): void;
  write16(address: number, value: number): void;
  /** The CPU took an interrupt at `level` (devices on the Genesis use autovectors). */
  acknowledgeInterrupt(level: number): void;
  /** The RESET instruction pulses the reset line of the other chips. */
  resetDevices(): void;
}

import { Fpu } from './fpu';

/** The CPUs this core can be: the A500's 68000, the A1200's 68EC020, or the A3000's and A4000's 68030. */
export type CpuModel = '68000' | '68ec020' | '68030';

type Size = 1 | 2 | 4;
type Handler = (this: M68k, op: number) => void;

const MASK = [0, 0xff, 0xffff, 0, 0xffffffff];
const MSB = [0, 0x80, 0x8000, 0, 0x80000000];
/** The size field of most instructions: 00 byte, 01 word, 10 long. */
const SIZE_FIELD: Size[] = [1, 2, 4];

const VECTOR_ADDRESS_ERROR = 3;
const VECTOR_ILLEGAL = 4;
const VECTOR_ZERO_DIVIDE = 5;
const VECTOR_CHK = 6;
const VECTOR_TRAPV = 7;
const VECTOR_PRIVILEGE = 8;
const VECTOR_TRACE = 9;
const VECTOR_LINE_A = 10;
const VECTOR_LINE_F = 11;
const VECTOR_AUTOVECTOR = 24;
const VECTOR_TRAP = 32;
/** Bytes a 68020 exception frame has after its format word, by format (0 and 1 have none). */
const FRAME_EXTRA_BYTES: Record<number, number> = { 2: 4, 9: 12, 10: 24, 11: 84 };

/** Exception processing after an instruction's own time: the internal steps around the stacking and vector fetch. */
const EXCEPTION_INTERNAL = 10;
/**
 * An interrupt takes 44 cycles: 6, the PC's low word stacked, 8 acknowledging, the SR and the PC's
 * high word stacked, the vector read, then the handler's first two words fetched with 2 between.
 */
const INTERRUPT_BEFORE_STACKING = 6;
const INTERRUPT_ACKNOWLEDGE = 8;
const INTERRUPT_BETWEEN_PREFETCHES = 2;
/** An address error takes 50 cycles. */
const ADDRESS_ERROR_INTERNAL = 22;

const signed8 = (value: number) => ((value & 0xff) ^ 0x80) - 0x80;
const signed16 = (value: number) => ((value & 0xffff) ^ 0x8000) - 0x8000;
const sizedSigned = (value: number, size: Size) => (size === 1 ? signed8(value) : size === 2 ? signed16(value) : value | 0);
const wrap = (value: number, size: Size) => (size === 4 ? value >>> 0 : value & MASK[size]);

/** Thrown (as a singleton) when a word or long access goes to an odd address; `step` turns it into the exception. */
const ADDRESS_ERROR = { addressError: true };

// --- Effective address classes ------------------------------------------------------

const isValidEa = (mode: number, reg: number) => mode < 7 || reg <= 4;
const isDataEa = (mode: number, reg: number) => mode !== 1 && isValidEa(mode, reg);
const isAlterable = (mode: number, reg: number) => mode < 7 || reg <= 1;
const isDataAlterable = (mode: number, reg: number) => mode !== 1 && isAlterable(mode, reg);
const isMemoryAlterable = (mode: number, reg: number) => mode >= 2 && isAlterable(mode, reg);
const isControl = (mode: number, reg: number) => mode === 2 || mode === 5 || mode === 6 || (mode === 7 && reg <= 3);

/**
 * A Motorola 68000, instruction-stepped. Every 68000 instruction, the
 * supervisor and user stacks, the seven interrupt levels with autovectors,
 * trace, address errors and the other exceptions, and the undocumented flag
 * results of the BCD, CHK and divide instructions. Times are counted per
 * instruction: 4 cycles for each bus access plus each instruction's internal
 * time, including the data-dependent multiply and divide times.
 */
export class M68k {
  readonly d = new Uint32Array(8);
  /** A0-A7; A7 is the stack pointer of the current mode. */
  readonly a = new Uint32Array(8);
  /** The stack pointer of the other mode (the user one in supervisor mode, and the other way round). */
  otherSp = 0;
  pc = 0;
  x = false;
  n = false;
  z = false;
  v = false;
  c = false;
  supervisor = true;
  trace = false;
  intMask = 7;
  /** Stopped by STOP until an interrupt. */
  stopped = false;
  /** The interrupt level asserted by the machine (0 for none). */
  irqLevel = 0;
  /** The level as the CPU last sampled it, which decides whether it takes an interrupt before the next instruction. */
  polledIrqLevel = 0;
  /** Cycles run since power on. */
  cycles = 0;
  /** Address errors taken since power on (the tests skip those, whose stack frames are not modelled exactly). */
  addressErrors = 0;
  /** The opcode being executed. */
  private ir = 0;
  /** The address of the instruction being executed. */
  private instructionPc = 0;
  /** The address of the last memory operand read, for read-modify-write instructions. */
  private ea = 0;
  /** The 68EC020's registers: the vector base, the cache control and address, and the function codes MOVES uses. */
  vbr = 0;
  cacr = 0;
  caar = 0;
  sfc = 0;
  dfc = 0;
  /** The 68020's master stack pointer (the M bit isn't used to switch to it here). */
  msp = 0;
  /** The SR's M bit (68020). */
  private master = false;
  /** The address and direction of an access that faulted. */
  private faultAddress = 0;
  private faultRead = true;
  private faultInstruction = false;

  /** The 68030's MMU registers: translation control, the root pointers, the transparent translations and the status. */
  tc = 0;
  readonly crp = new Uint32Array(2);
  readonly srp = new Uint32Array(2);
  tt0 = 0;
  tt1 = 0;
  mmusr = 0;

  /** The instruction table: the 68000's, the 68EC020's or the 68030's. */
  private table: Handler[] = OPCODES;
  /** A 68EC020 or 68030: 32-bit operations and addressing, a vector base, and word and long accesses at odd addresses. */
  is020 = false;
  /** A 68030: its MMU registers and data cache bits. */
  is030 = false;
  /** The address bus: 24 bits on the 68000 and 68EC020, 32 on the 68030. */
  private addressMask = 0xffffff;

  /** The 68881/68882 FPU on the 68030 models that have one (coprocessor 1). */
  fpu: Fpu | null = null;

  constructor(private readonly bus: M68kBus) {}

  /** Adds or takes away the FPU (coprocessor 1, on a 68030). */
  setFpu(present: boolean): void {
    if (!present) {
      this.fpu = null;
      return;
    }
    const cpu = this;
    this.fpu ??= new Fpu({
      d: this.d,
      a: this.a,
      get pc() {
        return cpu.pc;
      },
      set pc(value: number) {
        cpu.pc = value >>> 0;
      },
      get instructionAddress() {
        return cpu.instructionPc;
      },
      get supervisor() {
        return cpu.supervisor;
      },
      fetch16: () => this.fetch16(),
      fetch32: () => this.fetch32(),
      address: (mode, reg) => this.address(mode, reg, 4),
      read8: (address) => this.read8(address),
      read16: (address) => this.read16(address),
      read32: (address) => this.read32(address),
      write8: (address, value) => this.write8(address, value),
      write16: (address, value) => this.write16(address, value),
      write32: (address, value) => this.write32(address, value),
      trap: (vector) => this.exception(vector, this.instructionPc),
      addCycles: (cycles) => (this.cycles += cycles),
    });
  }

  /** Makes this a 68000, a 68EC020 or a 68030 (for the next reset). */
  setModel(model: CpuModel): void {
    this.is020 = model !== '68000';
    this.is030 = model === '68030';
    this.addressMask = this.is030 ? 0xffffffff : 0xffffff;
    this.table = this.is030 ? OPCODES_030 : this.is020 ? OPCODES_020 : OPCODES;
  }

  /** The reset sequence: supervisor mode, interrupts masked, the stack pointer and PC from the vector table. */
  reset(): void {
    this.supervisor = true;
    this.trace = false;
    this.master = false;
    this.intMask = 7;
    this.stopped = false;
    this.vbr = this.cacr = 0;
    this.tc = this.tt0 = this.tt1 = this.mmusr = 0;
    this.fpu?.reset();
    this.a[7] = this.read32(0);
    this.pc = this.read32(4);
    this.cycles += 132 - 16;
  }

  get sr(): number {
    return (
      (this.trace ? 0x8000 : 0) |
      (this.supervisor ? 0x2000 : 0) |
      (this.master ? 0x1000 : 0) |
      (this.intMask << 8) |
      (this.x ? 0x10 : 0) |
      (this.n ? 0x08 : 0) |
      (this.z ? 0x04 : 0) |
      (this.v ? 0x02 : 0) |
      (this.c ? 0x01 : 0)
    );
  }

  set sr(value: number) {
    this.trace = (value & 0x8000) !== 0;
    this.master = this.is020 && (value & 0x1000) !== 0;
    this.intMask = (value >> 8) & 7;
    this.ccr = value;
    this.setSupervisor((value & 0x2000) !== 0);
  }

  set ccr(value: number) {
    this.x = (value & 0x10) !== 0;
    this.n = (value & 0x08) !== 0;
    this.z = (value & 0x04) !== 0;
    this.v = (value & 0x02) !== 0;
    this.c = (value & 0x01) !== 0;
  }

  get usp(): number {
    return this.supervisor ? this.otherSp : this.a[7];
  }

  set usp(value: number) {
    if (this.supervisor) this.otherSp = value >>> 0;
    else this.a[7] = value;
  }

  get ssp(): number {
    return this.supervisor ? this.a[7] : this.otherSp;
  }

  set ssp(value: number) {
    if (this.supervisor) this.a[7] = value;
    else this.otherSp = value >>> 0;
  }

  private setSupervisor(on: boolean): void {
    if (on === this.supervisor) return;
    const sp = this.a[7];
    this.a[7] = this.otherSp;
    this.otherSp = sp;
    this.supervisor = on;
  }

  /** Runs one instruction (or takes an interrupt) and returns the cycles it took. */
  step(): number {
    const start = this.cycles;
    const tracing = this.trace;
    try {
      if (this.polledIrqLevel > this.intMask) {
        this.interrupt(this.polledIrqLevel);
        return this.cycles - start;
      }
      if (this.stopped) {
        this.cycles += 4;
        return 4;
      }
      this.instructionPc = this.pc;
      const op = this.fetch16();
      this.ir = op;
      this.table[op].call(this, op);
      if (tracing) this.exception(VECTOR_TRACE, this.pc, 0);
    } catch (error) {
      if (error !== ADDRESS_ERROR) throw error;
      this.addressError();
    }
    return this.cycles - start;
  }

  // --- Bus access ---------------------------------------------------------------

  private fault(address: number, read: boolean, instruction: boolean): never {
    this.faultAddress = address;
    this.faultRead = read;
    this.faultInstruction = instruction;
    throw ADDRESS_ERROR;
  }

  private read8(address: number): number {
    this.cycles += 4;
    return this.bus.read8((address & this.addressMask) >>> 0);
  }

  private read16(address: number): number {
    if (address & 1) {
      if (this.is020) return (this.read8(address) << 8) | this.read8(address + 1);
      this.fault(address, true, false);
    }
    this.cycles += 4;
    return this.bus.read16((address & this.addressMask) >>> 0);
  }

  private read32(address: number): number {
    const high = this.read16(address);
    return ((high << 16) | this.read16(address + 2)) >>> 0;
  }

  private write8(address: number, value: number): void {
    this.cycles += 4;
    this.bus.write8((address & this.addressMask) >>> 0, value & 0xff);
  }

  private write16(address: number, value: number): void {
    if (address & 1) {
      if (this.is020) {
        this.write8(address, value >> 8);
        this.write8(address + 1, value);
        return;
      }
      this.fault(address, false, false);
    }
    this.cycles += 4;
    this.bus.write16((address & this.addressMask) >>> 0, value & 0xffff);
  }

  private write32(address: number, value: number): void {
    this.write16(address, value >>> 16);
    this.write16(address + 2, value);
  }

  private readSized(address: number, size: Size): number {
    if (size === 1) return this.read8(address);
    if (size === 2) return this.read16(address);
    return this.read32(address);
  }

  private writeSized(address: number, size: Size, value: number): void {
    if (size === 1) this.write8(address, value);
    else if (size === 2) this.write16(address, value);
    else this.write32(address, value);
  }

  /** Jumps, branches and returns refill the prefetch at once, so an odd target faults within the instruction. */
  private jump(address: number): void {
    this.pc = address >>> 0;
    if (address & 1) this.fault(address, true, true);
  }

  private fetch16(): number {
    const pc = this.pc;
    if (pc & 1) this.fault(pc, true, true);
    this.cycles += 4;
    this.pc = (pc + 2) >>> 0;
    return this.bus.read16((pc & this.addressMask) >>> 0);
  }

  /**
   * A prefetch read whose word this core doesn't use: refilling the queue after a jump reads the
   * target's first word, which the next instruction fetches again as its opcode here.
   */
  private prefetchRead(address: number): void {
    if (address & 1) return;
    this.cycles += 4;
    this.bus.read16((address & this.addressMask) >>> 0);
  }

  private fetch32(): number {
    const high = this.fetch16();
    return ((high << 16) | this.fetch16()) >>> 0;
  }

  private fetchImmediate(size: Size): number {
    if (size === 1) return this.fetch16() & 0xff;
    if (size === 2) return this.fetch16();
    return this.fetch32();
  }

  private push16(value: number): void {
    this.a[7] -= 2;
    this.write16(this.a[7], value);
  }

  private push32(value: number): void {
    this.a[7] -= 4;
    this.write32(this.a[7], value);
  }

  private pop16(): number {
    const value = this.read16(this.a[7]);
    this.a[7] += 2;
    return value;
  }

  private pop32(): number {
    const value = this.read32(this.a[7]);
    this.a[7] += 4;
    return value;
  }

  // --- Effective addresses ----------------------------------------------------------

  /** The step of (An)+ and -(An): the operand size, except that A7 stays word-aligned for bytes. */
  private static step(reg: number, size: Size): number {
    return reg === 7 && size === 1 ? 2 : size;
  }

  /**
   * The address of a memory operand (modes 2-7), fetching its extension words.
   * -(An) takes 2 cycles to decrement, except as a MOVE destination.
   */
  private address(mode: number, reg: number, size: Size, predecrementTime = true): number {
    switch (mode) {
      case 2:
        return this.a[reg];
      case 3: {
        const address = this.a[reg];
        this.a[reg] += M68k.step(reg, size);
        return address;
      }
      case 4:
        if (predecrementTime) this.cycles += 2;
        this.a[reg] -= M68k.step(reg, size);
        return this.a[reg];
      case 5: {
        const base = this.a[reg];
        return (base + signed16(this.fetch16())) >>> 0;
      }
      case 6:
        return this.indexed(this.a[reg]);
      default:
        switch (reg) {
          case 0:
            return signed16(this.fetch16()) >>> 0;
          case 1:
            return this.fetch32();
          case 2: {
            const base = this.pc;
            return (base + signed16(this.fetch16())) >>> 0;
          }
          default:
            return this.indexed(this.pc);
        }
    }
  }

  /** d8(An,Xn) and d8(PC,Xn): the brief extension word gives the index register, its size and the displacement. */
  private indexed(base: number): number {
    const extension = this.fetch16();
    this.cycles += 2;
    const reg = (extension >> 12) & 7;
    let index = extension & 0x8000 ? this.a[reg] : this.d[reg];
    if (!(extension & 0x0800)) index = signed16(index);
    if (!this.is020) return (base + signed8(extension) + index) >>> 0;
    // The 68020 scales the index, and bit 8 marks the full format.
    index = Math.imul(index, 1 << ((extension >> 9) & 3));
    if (!(extension & 0x100)) return (base + signed8(extension) + index) >>> 0;
    return this.fullIndexed(base, extension, index);
  }

  /**
   * The 68020's full extension format: a base displacement, the base and index each possibly
   * suppressed, and memory indirection with the index added before or after it and an outer
   * displacement.
   */
  private fullIndexed(base: number, extension: number, index: number): number {
    if (extension & 0x80) base = 0;
    if (extension & 0x40) index = 0;
    const displacement = (sizeCode: number) => (sizeCode === 2 ? signed16(this.fetch16()) : sizeCode === 3 ? this.fetch32() | 0 : 0);
    const baseDisplacement = displacement((extension >> 4) & 3);
    const indirect = extension & 7;
    this.cycles += 4;
    if (indirect === 0) return (base + baseDisplacement + index) >>> 0;
    const postIndexed = (extension & 0x40) === 0 && (indirect & 4) !== 0;
    const pointerAt = (base + baseDisplacement + (postIndexed ? 0 : index)) >>> 0;
    const pointer = this.read32(pointerAt);
    const outer = displacement(indirect & 3);
    return (pointer + (postIndexed ? index : 0) + outer) >>> 0;
  }

  /** Reads an operand of any addressing mode; memory operands leave their address in `ea` for a write back. */
  private readEa(mode: number, reg: number, size: Size): number {
    if (mode === 0) return wrap(this.d[reg], size);
    if (mode === 1) return wrap(this.a[reg], size);
    if (mode === 7 && reg === 4) return this.fetchImmediate(size);
    this.ea = this.address(mode, reg, size);
    return this.readSized(this.ea, size);
  }

  /** Writes back to the operand last read by `readEa`. */
  private writeBack(mode: number, reg: number, size: Size, value: number): void {
    if (mode === 0) this.setD(reg, size, value);
    else if (mode === 1) this.a[reg] = value;
    else this.writeSized(this.ea, size, value);
  }

  /** Writes an operand that was not read first. */
  private writeEa(mode: number, reg: number, size: Size, value: number, predecrementTime = true): void {
    if (mode === 0) this.setD(reg, size, value);
    else if (mode === 1) this.a[reg] = value;
    else this.writeSized(this.address(mode, reg, size, predecrementTime), size, value);
  }

  private setD(reg: number, size: Size, value: number): void {
    if (size === 4) this.d[reg] = value;
    else if (size === 2) this.d[reg] = (this.d[reg] & 0xffff0000) | (value & 0xffff);
    else this.d[reg] = (this.d[reg] & 0xffffff00) | (value & 0xff);
  }

  // --- Flags and arithmetic -----------------------------------------------------------

  private setNZ(value: number, size: Size): void {
    this.n = (value & MSB[size]) !== 0;
    this.z = (value & MASK[size]) === 0;
  }

  private logic(value: number, size: Size): number {
    this.setNZ(value, size);
    this.v = this.c = false;
    return wrap(value, size);
  }

  private add(source: number, dest: number, size: Size, extend = false): number {
    const raw = source + dest + (extend && this.x ? 1 : 0);
    const result = wrap(raw, size);
    this.x = this.c = raw > MASK[size];
    this.v = (~(source ^ dest) & (source ^ result) & MSB[size]) !== 0;
    this.n = (result & MSB[size]) !== 0;
    if (!extend) this.z = result === 0;
    else if (result !== 0) this.z = false;
    return result;
  }

  /** dest - source. */
  private sub(source: number, dest: number, size: Size, extend = false): number {
    const raw = dest - source - (extend && this.x ? 1 : 0);
    const result = wrap(raw, size);
    this.x = this.c = raw < 0;
    this.v = ((source ^ dest) & (dest ^ result) & MSB[size]) !== 0;
    this.n = (result & MSB[size]) !== 0;
    if (!extend) this.z = result === 0;
    else if (result !== 0) this.z = false;
    return result;
  }

  private compare(source: number, dest: number, size: Size): void {
    const raw = dest - source;
    const result = wrap(raw, size);
    this.c = raw < 0;
    this.v = ((source ^ dest) & (dest ^ result) & MSB[size]) !== 0;
    this.setNZ(result, size);
  }

  private condition(code: number): boolean {
    switch (code) {
      case 0:
        return true;
      case 1:
        return false;
      case 2:
        return !this.c && !this.z;
      case 3:
        return this.c || this.z;
      case 4:
        return !this.c;
      case 5:
        return this.c;
      case 6:
        return !this.z;
      case 7:
        return this.z;
      case 8:
        return !this.v;
      case 9:
        return this.v;
      case 10:
        return !this.n;
      case 11:
        return this.n;
      case 12:
        return this.n === this.v;
      case 13:
        return this.n !== this.v;
      case 14:
        return !this.z && this.n === this.v;
      default:
        return this.z || this.n !== this.v;
    }
  }

  // --- Exceptions -------------------------------------------------------------------

  /** Enters supervisor mode, stacks the PC and SR, and jumps through `vector`. */
  private exception(vector: number, pushedPc: number, internal = EXCEPTION_INTERNAL): void {
    const sr = this.sr;
    this.setSupervisor(true);
    this.trace = false;
    this.cycles += internal;
    if (this.is020) {
      // Format 2 (with the instruction's address) for the traps an instruction raises, format 0 for the rest.
      const format2 = vector === VECTOR_CHK || vector === VECTOR_TRAPV || vector === VECTOR_ZERO_DIVIDE || vector === VECTOR_TRACE;
      if (format2) this.push32(this.instructionPc);
      this.push16((format2 ? 0x2000 : 0) | (vector * 4));
    }
    this.push32(pushedPc);
    this.push16(sr);
    this.jump(this.read32(this.vectorAddress(vector)));
  }

  /** Where a vector is: from the 68020's vector base. */
  private vectorAddress(vector: number): number {
    return ((this.is020 ? this.vbr : 0) + vector * 4) >>> 0;
  }

  private interrupt(level: number): void {
    this.stopped = false;
    const sr = this.sr;
    this.setSupervisor(true);
    this.trace = false;
    this.intMask = level;
    this.polledIrqLevel = 0;
    this.cycles += INTERRUPT_BEFORE_STACKING;
    const vector = VECTOR_AUTOVECTOR + level;
    if (this.is020) this.push16(vector * 4);
    this.a[7] -= 6;
    const sp = this.a[7];
    this.write16(sp + 4, this.pc & 0xffff);
    this.cycles += INTERRUPT_ACKNOWLEDGE;
    this.bus.acknowledgeInterrupt(level);
    this.write16(sp, sr);
    this.write16(sp + 2, this.pc >>> 16);
    this.jump(this.read32(this.vectorAddress(vector)));
    this.read16(this.pc);
    this.cycles += INTERRUPT_BETWEEN_PREFETCHES;
    this.read16(this.pc + 2);
  }

  /** The group 0 frame: the access, the opcode and the SR and PC. A second fault while stacking it would halt a real CPU. */
  private addressError(): void {
    this.addressErrors++;
    const sr = this.sr;
    this.setSupervisor(true);
    this.trace = false;
    this.cycles += ADDRESS_ERROR_INTERNAL;
    const functionCode = (this.supervisor ? 4 : 0) | (this.faultInstruction ? 2 : 1);
    const status = (this.faultRead ? 0x10 : 0) | (this.faultInstruction ? 0 : 0x08) | functionCode;
    try {
      this.push32(this.pc);
      this.push16(sr);
      this.push16(this.ir);
      this.push32(this.faultAddress);
      this.push16(status);
      this.pc = this.read32(this.vectorAddress(VECTOR_ADDRESS_ERROR));
    } catch (error) {
      if (error !== ADDRESS_ERROR) throw error;
      this.stopped = true;
    }
  }

  /** Privileged instructions trap in user mode, stacking the instruction's own address. */
  private privileged(): boolean {
    if (this.supervisor) return true;
    this.exception(VECTOR_PRIVILEGE, this.instructionPc);
    return false;
  }

  // --- Instructions -----------------------------------------------------------------

  illegal(): void {
    this.exception(VECTOR_ILLEGAL, this.instructionPc);
  }

  lineA(): void {
    this.exception(VECTOR_LINE_A, this.instructionPc);
  }

  lineF(): void {
    this.exception(VECTOR_LINE_F, this.instructionPc);
  }

  /** ORI, ANDI, SUBI, ADDI, EORI and CMPI. */
  immediate(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    const kind = (op >> 9) & 7;
    const source = this.fetchImmediate(size);
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const dest = this.readEa(mode, reg, size);
    if (mode === 0 && size === 4) this.cycles += kind === 6 ? 2 : 4;
    let result: number;
    switch (kind) {
      case 0:
        result = this.logic(dest | source, size);
        break;
      case 1:
        result = this.logic(dest & source, size);
        break;
      case 2:
        result = this.sub(source, dest, size);
        break;
      case 3:
        result = this.add(source, dest, size);
        break;
      case 5:
        result = this.logic(dest ^ source, size);
        break;
      default:
        this.compare(source, dest, size);
        return;
    }
    this.writeBack(mode, reg, size, result);
  }

  /** ORI, ANDI and EORI to CCR (size 0) or SR (size 1). */
  immediateToStatus(op: number): void {
    const toSr = (op & 0x40) !== 0;
    if (toSr && !this.privileged()) return;
    const value = this.fetch16();
    const current = toSr ? this.sr : this.sr & 0xff;
    const kind = (op >> 9) & 7;
    const result = kind === 0 ? current | value : kind === 1 ? current & value : current ^ value;
    // Internal time, and refilling the prefetch after the status register changes.
    this.cycles += 12;
    if (toSr) this.sr = result;
    else this.ccr = result;
  }

  /** BTST, BCHG, BCLR and BSET, with the bit number in a register (dynamic) or an immediate word (static). */
  bitOp(op: number): void {
    const kind = (op >> 6) & 3;
    const dynamic = (op & 0x100) !== 0;
    const bitNumber = dynamic ? this.d[(op >> 9) & 7] : this.fetch16();
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    if (mode === 0) {
      const bit = bitNumber & 31;
      const value = this.d[reg];
      this.z = (value & (1 << bit)) === 0;
      if (kind === 0) {
        this.cycles += 2;
        return;
      }
      this.cycles += kind === 2 ? (bit < 16 ? 4 : 6) : bit < 16 ? 2 : 4;
      if (kind === 1) this.d[reg] = value ^ (1 << bit);
      else if (kind === 2) this.d[reg] = value & ~(1 << bit);
      else this.d[reg] = value | (1 << bit);
      return;
    }
    const bit = bitNumber & 7;
    const value = this.readEa(mode, reg, 1);
    this.z = (value & (1 << bit)) === 0;
    if (kind === 0) {
      if (mode === 7 && reg === 4) this.cycles += 2;
      return;
    }
    const result = kind === 1 ? value ^ (1 << bit) : kind === 2 ? value & ~(1 << bit) : value | (1 << bit);
    this.writeBack(mode, reg, 1, result);
  }

  /** MOVEP: a word or long moved to or from alternate bytes of memory (for 8-bit peripherals). */
  movep(op: number): void {
    const dn = (op >> 9) & 7;
    const address = (this.a[op & 7] + signed16(this.fetch16())) >>> 0;
    const long = (op & 0x40) !== 0;
    const bytes = long ? 4 : 2;
    if (op & 0x80) {
      const value = this.d[dn];
      for (let i = 0; i < bytes; i++) this.write8(address + i * 2, value >>> ((bytes - 1 - i) * 8));
    } else {
      let value = 0;
      for (let i = 0; i < bytes; i++) value = (value << 8) | this.read8(address + i * 2);
      this.setD(dn, long ? 4 : 2, value >>> 0);
    }
  }

  move(op: number): void {
    const size: Size = op >> 12 === 1 ? 1 : op >> 12 === 3 ? 2 : 4;
    const value = this.readEa((op >> 3) & 7, op & 7, size);
    const destMode = (op >> 6) & 7;
    const destReg = (op >> 9) & 7;
    this.setNZ(value, size);
    this.v = this.c = false;
    this.writeEa(destMode, destReg, size, value, false);
  }

  movea(op: number): void {
    const size: Size = op >> 12 === 3 ? 2 : 4;
    const value = this.readEa((op >> 3) & 7, op & 7, size);
    this.a[(op >> 9) & 7] = size === 2 ? signed16(value) : value;
  }

  moveq(op: number): void {
    const value = signed8(op);
    this.d[(op >> 9) & 7] = value;
    this.n = value < 0;
    this.z = value === 0;
    this.v = this.c = false;
  }

  moveFromSr(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    if (mode === 0) {
      this.cycles += 2;
      this.setD(reg, 2, this.sr);
      return;
    }
    // The 68000 reads the destination before writing it.
    this.readEa(mode, reg, 2);
    this.writeSized(this.ea, 2, this.sr);
  }

  moveToCcr(op: number): void {
    const value = this.readEa((op >> 3) & 7, op & 7, 2);
    this.cycles += 8;
    this.ccr = value;
  }

  moveToSr(op: number): void {
    if (!this.privileged()) return;
    const value = this.readEa((op >> 3) & 7, op & 7, 2);
    this.cycles += 8;
    this.sr = value;
  }

  moveUsp(op: number): void {
    if (!this.privileged()) return;
    const reg = op & 7;
    if (op & 0x08) this.a[reg] = this.otherSp;
    else this.otherSp = this.a[reg];
  }

  /** NEGX, CLR, NEG and NOT. */
  unary(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    // Even CLR reads its operand first on the 68000.
    const value = this.readEa(mode, reg, size);
    if (mode === 0 && size === 4) this.cycles += 2;
    let result: number;
    switch ((op >> 9) & 3) {
      case 0:
        result = this.sub(value, 0, size, true);
        break;
      case 1:
        result = 0;
        this.n = this.v = this.c = false;
        this.z = true;
        break;
      case 2:
        result = this.sub(value, 0, size);
        break;
      default:
        result = this.logic(~value, size);
        break;
    }
    this.writeBack(mode, reg, size, result);
  }

  tst(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    this.logic(this.readEa((op >> 3) & 7, op & 7, size), size);
  }

  tas(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const value = this.readEa(mode, reg, 1);
    this.logic(value, 1);
    if (mode !== 0) this.cycles += 2;
    this.writeBack(mode, reg, 1, value | 0x80);
  }

  nbcd(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const value = this.readEa(mode, reg, 1);
    if (mode === 0) this.cycles += 2;
    this.writeBack(mode, reg, 1, this.bcdSubtract(value, 0));
  }

  swap(op: number): void {
    const reg = op & 7;
    const value = this.d[reg];
    this.d[reg] = ((value << 16) | (value >>> 16)) >>> 0;
    this.logic(this.d[reg], 4);
  }

  ext(op: number): void {
    const reg = op & 7;
    if (op & 0x40) {
      this.d[reg] = signed16(this.d[reg]);
      this.logic(this.d[reg], 4);
    } else {
      this.setD(reg, 2, signed8(this.d[reg]));
      this.logic(this.d[reg], 2);
    }
  }

  lea(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const address = this.address(mode, reg, 4);
    if (mode === 6 || (mode === 7 && reg === 3)) this.cycles += 2;
    this.a[(op >> 9) & 7] = address;
  }

  pea(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const address = this.address(mode, reg, 4);
    if (mode === 6 || (mode === 7 && reg === 3)) this.cycles += 2;
    this.push32(address);
  }

  /** The extra time JMP and JSR take for each addressing mode, beyond working out the address. */
  private jumpTime(mode: number, reg: number): number {
    if (mode === 2 || mode === 6 || (mode === 7 && reg === 3)) return 4;
    if (mode === 7 && reg === 1) return 0;
    return 2;
  }

  jmp(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const address = this.address(mode, reg, 4);
    this.cycles += this.jumpTime(mode, reg);
    this.jump(address);
  }

  jsr(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const address = this.address(mode, reg, 4);
    this.cycles += this.jumpTime(mode, reg);
    this.push32(this.pc);
    this.jump(address);
  }

  /** MOVEM: registers to memory (bit 10 clear) or memory to registers. The mask word lists D0-D7 then A0-A7. */
  movem(op: number): void {
    const size: Size = op & 0x40 ? 4 : 2;
    const mask = this.fetch16();
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const step = size;
    if (op & 0x400) {
      let address = mode === 3 ? this.a[reg] : this.address(mode, reg, size);
      for (let i = 0; i < 16; i++) {
        if (!(mask & (1 << i))) continue;
        const value = this.readSized(address, size);
        const extended = size === 2 ? signed16(value) : value;
        if (i < 8) this.d[i] = extended;
        else this.a[i - 8] = extended;
        address += step;
      }
      // The 68000 reads one word past the last register.
      this.read16(address);
      if (mode === 3) this.a[reg] = address;
      return;
    }
    if (mode === 4) {
      // Predecrement goes from A7 down to D0; the mask is reversed. A stored An is its value before the instruction.
      const original = this.a[reg];
      let address = original;
      for (let i = 0; i < 16; i++) {
        if (!(mask & (1 << i))) continue;
        const r = 15 - i;
        address = (address - step) >>> 0;
        const value = r < 8 ? this.d[r] : r - 8 === reg ? original : this.a[r - 8];
        this.writeSized(address, size, value);
      }
      this.a[reg] = address;
      return;
    }
    let address = this.address(mode, reg, size);
    for (let i = 0; i < 16; i++) {
      if (!(mask & (1 << i))) continue;
      this.writeSized(address, size, i < 8 ? this.d[i] : this.a[i - 8]);
      address += step;
    }
  }

  chk(op: number): void {
    const bound = signed16(this.readEa((op >> 3) & 7, op & 7, 2));
    const value = signed16(this.d[(op >> 9) & 7]);
    this.cycles += 6;
    this.z = value === 0;
    this.v = this.c = false;
    // The upper bound is checked first, and that trap is 2 cycles quicker.
    if (value > bound) {
      this.n = value < 0;
      this.exception(VECTOR_CHK, this.pc, EXCEPTION_INTERNAL - 2);
    } else if (value < 0) {
      this.n = true;
      this.exception(VECTOR_CHK, this.pc);
    }
  }

  trap(op: number): void {
    this.exception(VECTOR_TRAP + (op & 15), this.pc);
  }

  trapv(): void {
    if (this.v) this.exception(VECTOR_TRAPV, this.pc);
  }

  link(op: number): void {
    const reg = op & 7;
    // LINK A7 stacks A7 as it is after the push.
    this.push32(reg === 7 ? this.a[7] - 4 : this.a[reg]);
    this.a[reg] = this.a[7];
    this.a[7] += signed16(this.fetch16());
  }

  unlk(op: number): void {
    const reg = op & 7;
    this.a[7] = this.a[reg];
    this.a[reg] = this.pop32();
  }

  resetInstruction(): void {
    if (!this.privileged()) return;
    this.bus.resetDevices();
    this.cycles += 128;
  }

  nop(): void {}

  stop(): void {
    if (!this.privileged()) return;
    this.sr = this.fetch16();
    this.stopped = true;
  }

  rte(): void {
    if (!this.privileged()) return;
    for (;;) {
      const sr = this.pop16();
      const pc = this.pop32();
      if (this.is020) {
        // The 68020's frame says how much more there is to take off the stack.
        const format = this.pop16() >> 12;
        this.a[7] += FRAME_EXTRA_BYTES[format] ?? 0;
        if (format === 1) {
          // A throwaway frame: the real one follows on the other stack.
          this.sr = sr;
          continue;
        }
      }
      this.sr = sr;
      this.jump(pc);
      this.prefetchRead(pc);
      return;
    }
  }

  rts(): void {
    const pc = this.pop32();
    this.jump(pc);
    this.prefetchRead(pc);
  }

  rtr(): void {
    this.ccr = this.pop16();
    const pc = this.pop32();
    this.cycles += 4;
    this.jump(pc);
  }

  /** ADDQ and SUBQ: 1-8 added to or taken from an operand. On an address register the whole register changes and no flags do. */
  quick(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const amount = ((op >> 9) & 7) || 8;
    const subtract = (op & 0x100) !== 0;
    if (mode === 1) {
      this.cycles += size === 4 ? 2 : 4;
      this.a[reg] = subtract ? this.a[reg] - amount : this.a[reg] + amount;
      return;
    }
    const value = this.readEa(mode, reg, size);
    if (mode === 0 && size === 4) this.cycles += 4;
    this.writeBack(mode, reg, size, subtract ? this.sub(amount, value, size) : this.add(amount, value, size));
  }

  scc(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const set = this.condition((op >> 8) & 15);
    if (mode === 0) {
      if (set) this.cycles += 2;
      this.setD(reg, 1, set ? 0xff : 0);
      return;
    }
    this.readEa(mode, reg, 1);
    this.writeSized(this.ea, 1, set ? 0xff : 0);
  }

  dbcc(op: number): void {
    const base = this.pc;
    if (this.condition((op >> 8) & 15)) {
      this.cycles += 4;
      this.fetch16();
      return;
    }
    const reg = op & 7;
    const count = (this.d[reg] - 1) & 0xffff;
    this.setD(reg, 2, count);
    this.cycles += 2;
    const displacement = signed16(this.fetch16());
    if (count === 0xffff) {
      // The loop ends: the word after the displacement is read, and the prefetch refilled.
      this.prefetchRead(this.pc);
      return;
    }
    this.jump(base + displacement);
  }

  branch(op: number): void {
    const base = this.pc;
    const condition = (op >> 8) & 15;
    let displacement = signed8(op);
    const long = displacement === 0;
    if (condition === 1) {
      // BSR: the return address is stacked, then the prefetch refilled from the target.
      this.cycles += 2;
      const returnPc = long ? this.pc + 2 : this.pc;
      this.push32(returnPc);
      if (long) displacement = signed16(this.fetch16());
      else this.prefetchRead(base + displacement);
      this.jump(base + displacement);
      return;
    }
    if (this.condition(condition)) {
      this.cycles += 2;
      if (long) displacement = signed16(this.fetch16());
      else this.prefetchRead(base + displacement);
      this.jump(base + displacement);
    } else {
      this.cycles += 4;
      if (long) this.fetch16();
    }
  }

  arithmetic(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const dn = (op >> 9) & 7;
    const line = op >> 12;
    const toEa = (op & 0x100) !== 0;
    const ea = this.readEa(mode, reg, size);
    const register = wrap(this.d[dn], size);
    const [source, dest] = toEa ? [register, ea] : [ea, register];
    let result: number;
    switch (line) {
      case 0x8:
        result = this.logic(source | dest, size);
        break;
      case 0xc:
        result = this.logic(source & dest, size);
        break;
      case 0xd:
        result = this.add(source, dest, size);
        break;
      default:
        result = this.sub(source, dest, size);
        break;
    }
    if (toEa) {
      this.writeBack(mode, reg, size, result);
      return;
    }
    if (size === 4) this.cycles += mode === 0 || mode === 1 || (mode === 7 && reg === 4) ? 4 : 2;
    this.setD(dn, size, result);
  }

  eor(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const value = this.readEa(mode, reg, size);
    if (mode === 0 && size === 4) this.cycles += 4;
    this.writeBack(mode, reg, size, this.logic(value ^ this.d[(op >> 9) & 7], size));
  }

  cmp(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    const value = this.readEa((op >> 3) & 7, op & 7, size);
    if (size === 4) this.cycles += 2;
    this.compare(value, wrap(this.d[(op >> 9) & 7], size), size);
  }

  /** ADDA, SUBA and CMPA: a word source is sign-extended, and the whole address register takes part. */
  addressArithmetic(op: number): void {
    const size: Size = op & 0x100 ? 4 : 2;
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const raw = this.readEa(mode, reg, size);
    const source = size === 2 ? signed16(raw) >>> 0 : raw;
    const an = (op >> 9) & 7;
    const line = op >> 12;
    if (line === 0xb) {
      this.cycles += 2;
      this.compare(source, this.a[an], 4);
      return;
    }
    this.cycles += size === 2 || mode === 0 || mode === 1 || (mode === 7 && reg === 4) ? 4 : 2;
    this.a[an] = line === 0xd ? this.a[an] + source : this.a[an] - source;
  }

  cmpm(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    const source = this.readSized(this.address(3, op & 7, size), size);
    const dest = this.readSized(this.address(3, (op >> 9) & 7, size), size);
    this.compare(source, dest, size);
  }

  /** ADDX, SUBX, ABCD and SBCD: registers (bit 3 clear) or -(Ay),-(Ax). */
  extended(op: number): void {
    const line = op >> 12;
    const bcd = line === 0x8 || line === 0xc;
    const size = bcd ? 1 : SIZE_FIELD[(op >> 6) & 3];
    const rx = (op >> 9) & 7;
    const ry = op & 7;
    let source: number;
    let dest: number;
    const memory = (op & 0x08) !== 0;
    if (memory) {
      source = this.readSized(this.address(4, ry, size), size);
      this.a[rx] -= M68k.step(rx, size);
      this.ea = this.a[rx];
      dest = this.readSized(this.ea, size);
    } else {
      source = wrap(this.d[ry], size);
      dest = wrap(this.d[rx], size);
      if (size === 4) this.cycles += 4;
      else if (bcd) this.cycles += 2;
    }
    let result: number;
    if (line === 0xc) result = this.bcdAdd(source, dest);
    else if (line === 0x8) result = this.bcdSubtract(source, dest);
    else if (line === 0xd) result = this.add(source, dest, size, true);
    else result = this.sub(source, dest, size, true);
    if (memory) this.writeSized(this.ea, size, result);
    else this.setD(rx, size, result);
  }

  /** ABCD's sum, with the 68000's undocumented N and V results. */
  private bcdAdd(source: number, dest: number): number {
    let result = (source & 0x0f) + (dest & 0x0f) + (this.x ? 1 : 0);
    const correction = result > 9 ? 6 : 0;
    result += (source & 0xf0) + (dest & 0xf0);
    const before = result;
    result += correction;
    this.x = this.c = result > 0x9f;
    if (this.c) result -= 0xa0;
    this.v = (~before & result & 0x80) !== 0;
    this.n = (result & 0x80) !== 0;
    result &= 0xff;
    if (result !== 0) this.z = false;
    return result;
  }

  /** dest - source in BCD (SBCD, and NBCD with dest 0), with the undocumented N and V results. */
  private bcdSubtract(source: number, dest: number): number {
    let result = (dest & 0x0f) - (source & 0x0f) - (this.x ? 1 : 0);
    const correction = result > 0x0f || result < 0 ? 6 : 0;
    result += (dest & 0xf0) - (source & 0xf0);
    const before = result;
    if (result > 0xff || result < 0) {
      result += 0xa0;
      this.x = this.c = true;
    } else {
      this.x = this.c = result < correction;
    }
    result = (result - correction) & 0xff;
    this.v = (before & ~result & 0x80) !== 0;
    this.n = (result & 0x80) !== 0;
    if (result !== 0) this.z = false;
    return result;
  }

  mulu(op: number): void {
    const source = this.readEa((op >> 3) & 7, op & 7, 2);
    const dn = (op >> 9) & 7;
    const result = ((this.d[dn] & 0xffff) * source) >>> 0;
    let ones = 0;
    for (let bits = source; bits; bits &= bits - 1) ones++;
    this.cycles += 34 + 2 * ones;
    this.d[dn] = result;
    this.logic(result, 4);
  }

  muls(op: number): void {
    const source = this.readEa((op >> 3) & 7, op & 7, 2);
    const dn = (op >> 9) & 7;
    const result = Math.imul(signed16(this.d[dn]), signed16(source));
    // One step for each change between adjacent bits of the source (with a 0 below bit 0).
    let changes = 0;
    for (let bits = ((source << 1) ^ source) & 0xffff; bits; bits &= bits - 1) changes++;
    this.cycles += 34 + 2 * changes;
    this.d[dn] = result;
    this.logic(result, 4);
  }

  divu(op: number): void {
    const divisor = this.readEa((op >> 3) & 7, op & 7, 2);
    const dn = (op >> 9) & 7;
    const dividend = this.d[dn];
    if (divisor === 0) {
      this.zeroDivide();
      return;
    }
    const quotient = Math.floor(dividend / divisor);
    this.cycles += divuTime(dividend, divisor) - 4;
    this.c = false;
    // On overflow the register is left alone, and so are N and Z.
    if (quotient > 0xffff) {
      this.v = true;
      return;
    }
    const remainder = dividend - quotient * divisor;
    this.d[dn] = ((remainder << 16) | quotient) >>> 0;
    this.v = false;
    this.setNZ(quotient, 2);
  }

  divs(op: number): void {
    const divisor = signed16(this.readEa((op >> 3) & 7, op & 7, 2));
    const dn = (op >> 9) & 7;
    const dividend = this.d[dn] | 0;
    if (divisor === 0) {
      this.zeroDivide();
      return;
    }
    this.cycles += divsTime(dividend, divisor) - 4;
    const quotient = Math.trunc(dividend / divisor);
    this.c = false;
    if (quotient > 0x7fff || quotient < -0x8000) {
      this.v = true;
      return;
    }
    const remainder = dividend - quotient * divisor;
    this.d[dn] = ((remainder << 16) | (quotient & 0xffff)) >>> 0;
    this.v = false;
    this.setNZ(quotient, 2);
  }

  private zeroDivide(): void {
    this.n = false;
    this.z = false;
    this.v = this.c = false;
    this.cycles += 4;
    this.exception(VECTOR_ZERO_DIVIDE, this.pc);
  }

  /** EXG: Dx and Dy, Ax and Ay, or Dx and Ay. */
  exg(op: number): void {
    const rx = (op >> 9) & 7;
    const ry = op & 7;
    const mode = (op >> 3) & 0x1f;
    this.cycles += 2;
    if (mode === 0x08) {
      const t = this.d[rx];
      this.d[rx] = this.d[ry];
      this.d[ry] = t;
    } else if (mode === 0x09) {
      const t = this.a[rx];
      this.a[rx] = this.a[ry];
      this.a[ry] = t;
    } else {
      const t = this.d[rx];
      this.d[rx] = this.a[ry];
      this.a[ry] = t;
    }
  }

  /** ASL, ASR, LSL, LSR, ROXL, ROXR, ROL and ROR on a data register, by 1-8 or by a register (mod 64). */
  shiftRegister(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    const field = (op >> 9) & 7;
    const count = op & 0x20 ? this.d[field] & 63 : field || 8;
    const reg = op & 7;
    this.cycles += (size === 4 ? 4 : 2) + 2 * count;
    this.setD(reg, size, this.shift((op >> 3) & 3, (op & 0x100) !== 0, wrap(this.d[reg], size), count, size));
  }

  /** The same shifts by one place on a word in memory. */
  shiftMemory(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const value = this.readEa(mode, reg, 2);
    this.writeBack(mode, reg, 2, this.shift((op >> 9) & 3, (op & 0x100) !== 0, value, 1, 2));
  }

  private shift(kind: number, left: boolean, value: number, count: number, size: Size): number {
    const msb = MSB[size];
    let result = value;
    let carry = false;
    let overflow = false;
    for (let i = 0; i < count; i++) {
      const top = (result & msb) !== 0;
      const bottom = (result & 1) !== 0;
      if (left) {
        let incoming = 0;
        if (kind === 2) incoming = this.x ? 1 : 0;
        else if (kind === 3) incoming = top ? 1 : 0;
        result = wrap(result * 2 + incoming, size);
        carry = top;
        if (kind === 0 && ((result & msb) !== 0) !== top) overflow = true;
      } else {
        let incoming = false;
        if (kind === 0) incoming = top;
        else if (kind === 2) incoming = this.x;
        else if (kind === 3) incoming = bottom;
        result = wrap(Math.floor(result / 2) + (incoming ? msb : 0), size);
        carry = bottom;
      }
      if (kind !== 3) this.x = carry;
    }
    if (count === 0) carry = kind === 2 ? this.x : false;
    // ASR past the operand's width leaves C and X clear, as the hardware-derived tests record.
    if (kind === 0 && !left && count > size * 8) carry = this.x = false;
    this.c = carry;
    this.v = overflow;
    this.setNZ(result, size);
    return result;
  }

  // --- 68EC020 instructions ---------------------------------------------------------

  /** The 68020 traps MOVE from SR in user mode. */
  moveFromSr020(op: number): void {
    if (!this.privileged()) return;
    this.moveFromSr(op);
  }

  moveFromCcr(op: number): void {
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    if (mode === 0) this.setD(reg, 2, this.sr & 0xff);
    else this.writeEa(mode, reg, 2, this.sr & 0xff);
  }

  /** Bcc, BRA and BSR, with the 68020's 32-bit displacement (an 8-bit one of $FF). */
  branch020(op: number): void {
    if ((op & 0xff) !== 0xff) {
      this.branch(op);
      return;
    }
    const base = this.pc;
    const displacement = this.fetch32() | 0;
    const condition = (op >> 8) & 15;
    this.cycles += 2;
    if (condition === 1) {
      this.push32(this.pc);
      this.jump(base + displacement);
    } else if (this.condition(condition)) {
      this.jump(base + displacement);
    }
  }

  extb(op: number): void {
    const reg = op & 7;
    this.d[reg] = signed8(this.d[reg]);
    this.logic(this.d[reg], 4);
  }

  linkLong(op: number): void {
    const reg = op & 7;
    this.push32(reg === 7 ? this.a[7] - 4 : this.a[reg]);
    this.a[reg] = this.a[7];
    this.a[7] += this.fetch32() | 0;
  }

  rtd(): void {
    const displacement = signed16(this.fetch16());
    const pc = this.pop32();
    this.a[7] += displacement;
    this.jump(pc);
  }

  chkLong(op: number): void {
    const bound = this.readEa((op >> 3) & 7, op & 7, 4) | 0;
    const value = this.d[(op >> 9) & 7] | 0;
    this.cycles += 6;
    this.z = value === 0;
    this.v = this.c = false;
    if (value > bound) {
      this.n = value < 0;
      this.exception(VECTOR_CHK, this.pc);
    } else if (value < 0) {
      this.n = true;
      this.exception(VECTOR_CHK, this.pc);
    }
  }

  /** CHK2 and CMP2: a register against a lower and upper bound in memory (signed if the bounds only make sense that way). */
  chk2(op: number): void {
    const size = SIZE_FIELD[(op >> 9) & 3];
    const extension = this.fetch16();
    const reg = (extension >> 12) & 7;
    const address = this.address((op >> 3) & 7, op & 7, size);
    let lower = this.readSized(address, size);
    let upper = this.readSized(address + size, size);
    let value: number;
    if (extension & 0x8000) {
      value = this.a[reg] | 0;
      lower = sizedSigned(lower, size);
      upper = sizedSigned(upper, size);
    } else {
      value = wrap(this.d[reg], size);
      if (lower > upper) {
        lower = sizedSigned(lower, size);
        upper = sizedSigned(upper, size);
        value = sizedSigned(value, size);
      }
    }
    this.cycles += 8;
    this.z = value === lower || value === upper;
    this.c = lower <= upper ? value < lower || value > upper : value > upper && value < lower;
    if (this.c && extension & 0x0800) this.exception(VECTOR_CHK, this.pc);
  }

  /** CAS: compare Dc with the operand; if they are equal Du goes there, else the operand goes to Dc. */
  cas(op: number): void {
    const size = SIZE_FIELD[((op >> 9) & 3) - 1];
    const extension = this.fetch16();
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const operand = this.readEa(mode, reg, size);
    const dc = extension & 7;
    this.compare(wrap(this.d[dc], size), operand, size);
    this.cycles += 4;
    if (this.z) this.writeBack(mode, reg, size, this.d[(extension >> 6) & 7]);
    else this.setD(dc, size, operand);
  }

  /** CAS2: two compares and swaps, done only if both match. */
  cas2(op: number): void {
    const size: Size = op & 0x200 ? 4 : 2;
    const first = this.fetch16();
    const second = this.fetch16();
    const address1 = first & 0x8000 ? this.a[(first >> 12) & 7] : this.d[(first >> 12) & 7];
    const address2 = second & 0x8000 ? this.a[(second >> 12) & 7] : this.d[(second >> 12) & 7];
    const operand1 = this.readSized(address1, size);
    const operand2 = this.readSized(address2, size);
    const dc1 = first & 7;
    const dc2 = second & 7;
    this.cycles += 8;
    this.compare(wrap(this.d[dc1], size), operand1, size);
    if (this.z) this.compare(wrap(this.d[dc2], size), operand2, size);
    if (this.z) {
      this.writeSized(address1, size, this.d[(first >> 6) & 7]);
      this.writeSized(address2, size, this.d[(second >> 6) & 7]);
    } else {
      this.setD(dc1, size, operand1);
      this.setD(dc2, size, operand2);
    }
  }

  /** TRAPcc: a TRAPV on any condition, with an optional operand word or long that is skipped. */
  trapcc(op: number): void {
    const operand = op & 7;
    if (operand === 2) this.fetch16();
    else if (operand === 3) this.fetch32();
    if (this.condition((op >> 8) & 15)) this.exception(VECTOR_TRAPV, this.pc);
  }

  movec(op: number): void {
    if (!this.privileged()) return;
    const extension = this.fetch16();
    const regs = extension & 0x8000 ? this.a : this.d;
    const reg = (extension >> 12) & 7;
    const control = extension & 0xfff;
    this.cycles += 6;
    if (op & 1) {
      const value = regs[reg];
      if (!this.writeControl(control, value)) this.exception(VECTOR_ILLEGAL, this.instructionPc);
    } else {
      const value = this.readControl(control);
      if (value === null) this.exception(VECTOR_ILLEGAL, this.instructionPc);
      else regs[reg] = value;
    }
  }

  private readControl(control: number): number | null {
    switch (control) {
      case 0x000:
        return this.sfc;
      case 0x001:
        return this.dfc;
      case 0x002:
        return this.cacr;
      case 0x800:
        return this.otherSp;
      case 0x801:
        return this.vbr;
      case 0x802:
        return this.caar;
      case 0x803:
        return this.msp;
      case 0x804:
        return this.a[7];
      default:
        return null;
    }
  }

  private writeControl(control: number, value: number): boolean {
    switch (control) {
      case 0x000:
        this.sfc = value & 7;
        return true;
      case 0x001:
        this.dfc = value & 7;
        return true;
      case 0x002:
        // The cache enable and freeze bits are kept (the 68030's data cache, burst and write-allocate
        // bits too); the clear bits act and read back as 0.
        this.cacr = value & (this.is030 ? 0x3313 : 0x3);
        return true;
      case 0x800:
        this.otherSp = value >>> 0;
        return true;
      case 0x801:
        this.vbr = value >>> 0;
        return true;
      case 0x802:
        this.caar = value >>> 0;
        return true;
      case 0x803:
        this.msp = value >>> 0;
        return true;
      case 0x804:
        this.a[7] = value;
        return true;
      default:
        return false;
    }
  }

  /**
   * The 68030's MMU instructions (coprocessor 0): PMOVE to and from its registers, PFLUSH, PLOAD
   * and PTEST. The registers are kept, but addresses aren't translated: Kickstart switches the MMU
   * off and leaves it off.
   */
  mmu030(op: number): void {
    if (!this.privileged()) return;
    const extension = this.fetch16();
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const kind = extension >> 13;
    if (kind === 1 || kind === 4) {
      // PFLUSH, PLOAD and PTEST have no cache or tables to act on; PTEST finds nothing wrong.
      if (kind === 4) this.mmusr = 0;
      if (mode >= 2) this.address(mode, reg, 4);
      return;
    }
    if (kind !== 0 && kind !== 2 && kind !== 3) {
      this.exception(VECTOR_LINE_F, this.instructionPc);
      return;
    }
    const register = (extension >> 10) & 7;
    const toMemory = (extension & 0x0200) !== 0;
    const root = kind === 2 && (register === 2 || register === 3) ? (register === 2 ? this.srp : this.crp) : null;
    const size: Size = kind === 3 ? 2 : 4;
    if (mode < 2 && (root || mode === 1)) {
      this.exception(VECTOR_LINE_F, this.instructionPc);
      return;
    }
    if (mode === 0) {
      if (toMemory) this.d[reg] = this.mmuRegister(kind, register);
      else this.setMmuRegister(kind, register, this.d[reg]);
      return;
    }
    let address = this.address(mode, reg, size);
    if (root) {
      // The root pointers are 64 bits: (An)+ and -(An) step by 8.
      if (mode === 3) this.a[reg] = (this.a[reg] + 4) >>> 0;
      if (mode === 4) address = this.a[reg] = (this.a[reg] - 4) >>> 0;
      if (toMemory) {
        this.write32(address, root[0]);
        this.write32(address + 4, root[1]);
      } else {
        root[0] = this.read32(address);
        root[1] = this.read32(address + 4);
      }
    } else if (toMemory) {
      this.writeSized(address, size, this.mmuRegister(kind, register));
    } else {
      this.setMmuRegister(kind, register, this.readSized(address, size));
    }
  }

  private mmuRegister(kind: number, register: number): number {
    if (kind === 3) return this.mmusr;
    if (kind === 0) return register === 3 ? this.tt1 : this.tt0;
    return this.tc;
  }

  private setMmuRegister(kind: number, register: number, value: number): void {
    if (kind === 3) this.mmusr = value & 0xffff;
    else if (kind === 0 && register === 3) this.tt1 = value >>> 0;
    else if (kind === 0) this.tt0 = value >>> 0;
    else this.tc = value >>> 0;
  }

  /** Coprocessor 1, the FPU: line F without one. */
  fpuInstruction(op: number): void {
    if (this.fpu) this.fpu.execute(op);
    else this.exception(VECTOR_LINE_F, this.instructionPc);
  }

  /** MOVES: a move in another address space, which the Amiga's memory map doesn't tell apart. */
  moves(op: number): void {
    if (!this.privileged()) return;
    const size = SIZE_FIELD[(op >> 6) & 3];
    const extension = this.fetch16();
    const regs = extension & 0x8000 ? this.a : this.d;
    const reg = (extension >> 12) & 7;
    const mode = (op >> 3) & 7;
    const ea = op & 7;
    if (extension & 0x0800) {
      this.writeEa(mode, ea, size, regs[reg]);
    } else {
      const value = this.readEa(mode, ea, size);
      if (regs === this.a) this.a[reg] = sizedSigned(value, size);
      else this.setD(reg, size, value);
    }
  }

  /** MULU.L and MULS.L: 32 x 32 bits, to 32 bits (V on overflow) or 64 in Dh:Dl. */
  mulLong(op: number): void {
    const extension = this.fetch16();
    const source = this.readEa((op >> 3) & 7, op & 7, 4);
    const dl = (extension >> 12) & 7;
    const signed = (extension & 0x0800) !== 0;
    const wide = (extension & 0x0400) !== 0;
    const a = signed ? BigInt(source | 0) : BigInt(source >>> 0);
    const b = signed ? BigInt(this.d[dl] | 0) : BigInt(this.d[dl] >>> 0);
    const product = a * b;
    const low = Number(BigInt.asUintN(32, product));
    const high = Number(BigInt.asUintN(32, product >> 32n));
    this.cycles += 40;
    this.c = false;
    if (wide) {
      this.d[dl] = low;
      this.d[extension & 7] = high;
      this.n = (high & 0x80000000) !== 0;
      this.z = product === 0n;
      this.v = false;
      return;
    }
    this.d[dl] = low;
    this.n = (low & 0x80000000) !== 0;
    this.z = low === 0;
    this.v = signed ? product !== BigInt(low | 0) : high !== 0;
  }

  /** DIVU.L and DIVS.L: 32 or 64 bits by 32, the quotient in Dq and the remainder in Dr. */
  divLong(op: number): void {
    const extension = this.fetch16();
    const divisorRaw = this.readEa((op >> 3) & 7, op & 7, 4);
    const dq = (extension >> 12) & 7;
    const dr = extension & 7;
    const signed = (extension & 0x0800) !== 0;
    const wide = (extension & 0x0400) !== 0;
    if (divisorRaw === 0) {
      this.zeroDivide();
      return;
    }
    const divisor = signed ? BigInt(divisorRaw | 0) : BigInt(divisorRaw >>> 0);
    let dividend: bigint;
    if (wide) {
      const combined = (BigInt(this.d[dr] >>> 0) << 32n) | BigInt(this.d[dq] >>> 0);
      dividend = signed ? BigInt.asIntN(64, combined) : combined;
    } else {
      dividend = signed ? BigInt(this.d[dq] | 0) : BigInt(this.d[dq] >>> 0);
    }
    const quotient = dividend / divisor;
    const remainder = dividend % divisor;
    this.cycles += 76;
    this.c = false;
    const fits = signed ? quotient >= -0x80000000n && quotient <= 0x7fffffffn : quotient <= 0xffffffffn;
    if (!fits) {
      this.v = true;
      return;
    }
    this.v = false;
    const q = Number(BigInt.asUintN(32, quotient));
    if (dr !== dq) this.d[dr] = Number(BigInt.asUintN(32, remainder));
    this.d[dq] = q;
    this.n = (q & 0x80000000) !== 0;
    this.z = q === 0;
  }

  /** PACK and UNPK: BCD digits between a word's two bytes' low nibbles and a byte, with an adjustment. */
  packUnpack(op: number): void {
    const unpack = (op & 0x1c0) === 0x180;
    const rx = op & 7;
    const ry = (op >> 9) & 7;
    const memory = (op & 0x08) !== 0;
    const adjustment = this.fetch16();
    if (!unpack) {
      let source: number;
      if (memory) {
        this.a[rx] -= 1;
        const low = this.read8(this.a[rx]);
        this.a[rx] -= 1;
        source = (this.read8(this.a[rx]) << 8) | low;
      } else {
        source = this.d[rx] & 0xffff;
      }
      source = (source + adjustment) & 0xffff;
      const packed = ((source >> 4) & 0xf0) | (source & 0x0f);
      if (memory) {
        this.a[ry] -= M68k.step(ry, 1);
        this.write8(this.a[ry], packed);
      } else {
        this.setD(ry, 1, packed);
      }
      return;
    }
    let source: number;
    if (memory) {
      this.a[rx] -= M68k.step(rx, 1);
      source = this.read8(this.a[rx]);
    } else {
      source = this.d[rx] & 0xff;
    }
    const unpacked = ((((source & 0xf0) << 4) | (source & 0x0f)) + adjustment) & 0xffff;
    if (memory) {
      this.a[ry] -= 1;
      this.write8(this.a[ry], unpacked & 0xff);
      this.a[ry] -= 1;
      this.write8(this.a[ry], unpacked >> 8);
    } else {
      this.setD(ry, 2, unpacked);
    }
  }

  /** BFTST, BFEXTU, BFCHG, BFEXTS, BFCLR, BFFFO, BFSET and BFINS: a field of up to 32 bits in a register or memory. */
  bitField(op: number): void {
    const kind = (op >> 8) & 7;
    const extension = this.fetch16();
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    let offset = extension & 0x0800 ? this.d[(extension >> 6) & 7] | 0 : (extension >> 6) & 31;
    let width = extension & 0x0020 ? this.d[extension & 7] & 31 : extension & 31;
    if (width === 0) width = 32;
    const dn = (extension >> 12) & 7;
    const mask = width === 32 ? 0xffffffff : (2 ** width - 1);
    this.cycles += 8;
    let field: number;
    let write: (value: number) => void;
    if (mode === 0) {
      offset &= 31;
      const rotated = ((this.d[reg] << offset) | (offset ? this.d[reg] >>> (32 - offset) : 0)) >>> 0;
      field = Math.floor(rotated / 2 ** (32 - width)) % (mask + 1);
      write = (value) => {
        const shift = 32 - width;
        const fieldMask = (mask * 2 ** shift) >>> 0;
        const placed = ((value * 2 ** shift) >>> 0) & fieldMask;
        const updated = ((rotated & ~fieldMask) | placed) >>> 0;
        this.d[reg] = offset ? ((updated >>> offset) | (updated << (32 - offset))) >>> 0 : updated;
      };
    } else {
      const base = this.address(mode, reg, 1);
      const address = (base + Math.floor(offset / 8)) >>> 0;
      const bitOffset = ((offset % 8) + 8) % 8;
      const bytes = Math.ceil((bitOffset + width) / 8);
      let raw = 0n;
      for (let i = 0; i < bytes; i++) raw = (raw << 8n) | BigInt(this.read8(address + i));
      const totalBits = BigInt(bytes * 8);
      const shift = totalBits - BigInt(bitOffset + width);
      field = Number((raw >> shift) & BigInt(mask));
      write = (value) => {
        const fieldMask = BigInt(mask) << shift;
        const updated = (raw & ~fieldMask) | ((BigInt(value >>> 0) & BigInt(mask)) << shift);
        for (let i = bytes - 1; i >= 0; i--) this.write8(address + i, Number((updated >> BigInt((bytes - 1 - i) * 8)) & 0xffn));
      };
    }
    const top = 2 ** (width - 1);
    this.n = field >= top;
    this.z = field === 0;
    this.v = this.c = false;
    switch (kind) {
      case 0:
        break;
      case 1:
        this.d[dn] = field;
        break;
      case 2:
        write(~field & mask);
        break;
      case 3:
        this.d[dn] = field >= top ? field - 2 * top : field;
        break;
      case 4:
        write(0);
        break;
      case 5: {
        let index = 0;
        while (index < width && !(Math.floor(field / 2 ** (width - 1 - index)) & 1)) index++;
        this.d[dn] = (offset + index) >>> 0;
        break;
      }
      case 6:
        write(mask);
        break;
      default: {
        const value = this.d[dn] % (mask + 1);
        const unsigned = value < 0 ? value + mask + 1 : value;
        this.n = unsigned >= top;
        this.z = unsigned === 0;
        write(unsigned);
      }
    }
  }

  /** BKPT: with no debugger to answer it, an illegal instruction. */
  bkpt(): void {
    this.exception(VECTOR_ILLEGAL, this.instructionPc);
  }

  /** TST and CMPI take any operand on the 68020 (an address register, or the PC-relative and immediate modes). */
  tst020(op: number): void {
    const size = SIZE_FIELD[(op >> 6) & 3];
    this.logic(this.readEa((op >> 3) & 7, op & 7, size), size);
  }
}

/** DIVU's time, from the number of steps its shift-and-subtract loop takes (Jorge Cwik's analysis). */
function divuTime(dividend: number, divisor: number): number {
  if (dividend >>> 16 >= divisor) return 10;
  let cycles = 38;
  const shiftedDivisor = divisor * 0x10000;
  let remainder = dividend;
  for (let i = 0; i < 15; i++) {
    const wasNegative = remainder >= 0x80000000;
    remainder = (remainder * 2) % 0x100000000;
    if (wasNegative) {
      remainder = (remainder - shiftedDivisor + 0x100000000) % 0x100000000;
    } else {
      cycles += 2;
      if (remainder >= shiftedDivisor) {
        remainder -= shiftedDivisor;
        cycles--;
      }
    }
  }
  return cycles * 2;
}

/** DIVS's time: a fixed part, the signs, and the bits of the absolute quotient (Jorge Cwik's analysis). */
function divsTime(dividend: number, divisor: number): number {
  let cycles = 6;
  if (dividend < 0) cycles++;
  const absDividend = Math.abs(dividend);
  const absDivisor = Math.abs(divisor);
  let quotient = Math.floor(absDividend / absDivisor);
  // An overflow (of the absolute value, or of the signed quotient) ends the division early.
  const negativeQuotient = dividend < 0 !== divisor < 0;
  if (quotient > (negativeQuotient ? 0x8000 : 0x7fff)) return (cycles + 2) * 2;
  cycles += 55;
  if (divisor >= 0) cycles += dividend >= 0 ? -1 : 1;
  for (let i = 0; i < 15; i++) {
    if (!(quotient & 0x8000)) cycles++;
    quotient = (quotient << 1) & 0xffff;
  }
  return cycles * 2;
}

// --- Decoding ---------------------------------------------------------------------------

const P = M68k.prototype;

function decodeLine0(op: number, mode: number, reg: number): Handler {
  if (op & 0x100) {
    if (mode === 1) return P.movep;
    const kind = (op >> 6) & 3;
    if (kind === 0 ? isDataEa(mode, reg) : isDataAlterable(mode, reg)) return P.bitOp;
    return P.illegal;
  }
  const kind = (op >> 9) & 7;
  if (kind === 4) {
    const bit = (op >> 6) & 3;
    const valid = bit === 0 ? isDataEa(mode, reg) && !(mode === 7 && reg === 4) : isDataAlterable(mode, reg);
    return valid ? P.bitOp : P.illegal;
  }
  if (kind === 7) return P.illegal;
  const size = (op >> 6) & 3;
  if ((kind === 0 || kind === 1 || kind === 5) && mode === 7 && reg === 4) {
    return size < 2 ? P.immediateToStatus : P.illegal;
  }
  if (size === 3 || !isDataAlterable(mode, reg)) return P.illegal;
  return P.immediate;
}

function decodeMove(op: number, mode: number, reg: number): Handler {
  const destMode = (op >> 6) & 7;
  const destReg = (op >> 9) & 7;
  const byte = op >> 12 === 1;
  if (!isValidEa(mode, reg) || (byte && mode === 1)) return P.illegal;
  if (destMode === 1) return byte ? P.illegal : P.movea;
  return isDataAlterable(destMode, destReg) ? P.move : P.illegal;
}

function decodeLine4(op: number, mode: number, reg: number): Handler {
  if (op & 0x100) {
    const kind = (op >> 6) & 3;
    if (kind === 3) return isControl(mode, reg) ? P.lea : P.illegal;
    if (kind === 2) return isDataEa(mode, reg) ? P.chk : P.illegal;
    return P.illegal;
  }
  const size = (op >> 6) & 3;
  switch ((op >> 8) & 0xf) {
    case 0x0:
      if (!isDataAlterable(mode, reg)) return P.illegal;
      return size === 3 ? P.moveFromSr : P.unary;
    case 0x2:
      return size !== 3 && isDataAlterable(mode, reg) ? P.unary : P.illegal;
    case 0x4:
      if (size === 3) return isDataEa(mode, reg) ? P.moveToCcr : P.illegal;
      return isDataAlterable(mode, reg) ? P.unary : P.illegal;
    case 0x6:
      if (size === 3) return isDataEa(mode, reg) ? P.moveToSr : P.illegal;
      return isDataAlterable(mode, reg) ? P.unary : P.illegal;
    case 0x8:
      if (size === 0) return isDataAlterable(mode, reg) ? P.nbcd : P.illegal;
      if (mode === 0) return size === 1 ? P.swap : P.ext;
      if (size === 1) return isControl(mode, reg) ? P.pea : P.illegal;
      return isControl(mode, reg) && !(mode === 7 && reg >= 2) ? P.movem : mode === 4 ? P.movem : P.illegal;
    case 0xa:
      if (size === 3) {
        if (op === 0x4afc) return P.illegal;
        return isDataAlterable(mode, reg) ? P.tas : P.illegal;
      }
      return isDataAlterable(mode, reg) ? P.tst : P.illegal;
    case 0xc:
      if (size < 2) return P.illegal;
      return isControl(mode, reg) || mode === 3 ? P.movem : P.illegal;
    case 0xe:
      return decodeLine4e(op, mode, reg);
    default:
      return P.illegal;
  }
}

function decodeLine4e(op: number, mode: number, reg: number): Handler {
  if ((op & 0xffc0) === 0x4e80) return isControl(mode, reg) ? P.jsr : P.illegal;
  if ((op & 0xffc0) === 0x4ec0) return isControl(mode, reg) ? P.jmp : P.illegal;
  if ((op & 0xfff0) === 0x4e40) return P.trap;
  if ((op & 0xfff8) === 0x4e50) return P.link;
  if ((op & 0xfff8) === 0x4e58) return P.unlk;
  if ((op & 0xfff0) === 0x4e60) return P.moveUsp;
  switch (op) {
    case 0x4e70:
      return P.resetInstruction;
    case 0x4e71:
      return P.nop;
    case 0x4e72:
      return P.stop;
    case 0x4e73:
      return P.rte;
    case 0x4e75:
      return P.rts;
    case 0x4e76:
      return P.trapv;
    case 0x4e77:
      return P.rtr;
    default:
      return P.illegal;
  }
}

function decodeLine5(op: number, mode: number, reg: number): Handler {
  if (((op >> 6) & 3) === 3) {
    if (mode === 1) return P.dbcc;
    return isDataAlterable(mode, reg) ? P.scc : P.illegal;
  }
  if (!isAlterable(mode, reg) || (mode === 1 && ((op >> 6) & 3) === 0)) return P.illegal;
  return P.quick;
}

/** OR/AND (line 8 and C) and SUB/ADD (line 9 and D): the plain forms after the special ones are taken out. */
function decodeArithmetic(op: number, mode: number, reg: number, logical: boolean): Handler {
  const size = (op >> 6) & 3;
  if (op & 0x100) return isMemoryAlterable(mode, reg) ? P.arithmetic : P.illegal;
  if (logical) return isDataEa(mode, reg) ? P.arithmetic : P.illegal;
  if (!isValidEa(mode, reg) || (size === 0 && mode === 1)) return P.illegal;
  return P.arithmetic;
}

function decodeLine8(op: number, mode: number, reg: number): Handler {
  const opmode = (op >> 6) & 7;
  if (opmode === 3) return isDataEa(mode, reg) ? P.divu : P.illegal;
  if (opmode === 7) return isDataEa(mode, reg) ? P.divs : P.illegal;
  if ((op & 0x1f0) === 0x100) return P.extended;
  return decodeArithmetic(op, mode, reg, true);
}

function decodeAddSub(op: number, mode: number, reg: number): Handler {
  const opmode = (op >> 6) & 7;
  if (opmode === 3 || opmode === 7) return isValidEa(mode, reg) ? P.addressArithmetic : P.illegal;
  if ((op & 0x130) === 0x100) return P.extended;
  return decodeArithmetic(op, mode, reg, false);
}

function decodeLineB(op: number, mode: number, reg: number): Handler {
  const opmode = (op >> 6) & 7;
  if (opmode === 3 || opmode === 7) return isValidEa(mode, reg) ? P.addressArithmetic : P.illegal;
  if (opmode < 3) return isValidEa(mode, reg) && !(opmode === 0 && mode === 1) ? P.cmp : P.illegal;
  if (mode === 1) return P.cmpm;
  return isDataAlterable(mode, reg) ? P.eor : P.illegal;
}

function decodeLineC(op: number, mode: number, reg: number): Handler {
  const opmode = (op >> 6) & 7;
  if (opmode === 3) return isDataEa(mode, reg) ? P.mulu : P.illegal;
  if (opmode === 7) return isDataEa(mode, reg) ? P.muls : P.illegal;
  if ((op & 0x1f0) === 0x100) return P.extended;
  const exg = op & 0x1f8;
  if (exg === 0x140 || exg === 0x148 || exg === 0x188) return P.exg;
  return decodeArithmetic(op, mode, reg, true);
}

function decodeLineE(op: number, mode: number, reg: number): Handler {
  if (((op >> 6) & 3) === 3) {
    if (op & 0x800) return P.illegal;
    return isMemoryAlterable(mode, reg) ? P.shiftMemory : P.illegal;
  }
  return P.shiftRegister;
}

function decode(op: number): Handler {
  const mode = (op >> 3) & 7;
  const reg = op & 7;
  switch (op >> 12) {
    case 0x0:
      return decodeLine0(op, mode, reg);
    case 0x1:
    case 0x2:
    case 0x3:
      return decodeMove(op, mode, reg);
    case 0x4:
      return decodeLine4(op, mode, reg);
    case 0x5:
      return decodeLine5(op, mode, reg);
    case 0x6:
      return P.branch;
    case 0x7:
      return op & 0x100 ? P.illegal : P.moveq;
    case 0x8:
      return decodeLine8(op, mode, reg);
    case 0x9:
    case 0xd:
      return decodeAddSub(op, mode, reg);
    case 0xa:
      return P.lineA;
    case 0xb:
      return decodeLineB(op, mode, reg);
    case 0xc:
      return decodeLineC(op, mode, reg);
    case 0xe:
      return decodeLineE(op, mode, reg);
    default:
      return P.lineF;
  }
}

const OPCODES: Handler[] = Array.from({ length: 0x10000 }, (_, op) => decode(op));

/** The 68EC020's instructions: the 68000's, the new ones, and some 68000 ones that take more operands. */
function decode020(op: number): Handler {
  const mode = (op >> 3) & 7;
  const reg = op & 7;
  const base = OPCODES[op];
  switch (op >> 12) {
    case 0x0: {
      if ((op & 0xf9c0) === 0x00c0 && ((op >> 9) & 3) !== 3) return isControl(mode, reg) ? P.chk2 : P.illegal;
      if ((op & 0xf9c0) === 0x08c0 && ((op >> 9) & 3) !== 0) {
        if ((op & 0xfdff) === 0x0cfc) return P.cas2;
        return isMemoryAlterable(mode, reg) ? P.cas : P.illegal;
      }
      if ((op & 0xff00) === 0x0e00 && ((op >> 6) & 3) !== 3) return isMemoryAlterable(mode, reg) ? P.moves : P.illegal;
      // CMPI takes the PC-relative modes too.
      if ((op & 0xff00) === 0x0c00 && ((op >> 6) & 3) !== 3 && mode === 7 && (reg === 2 || reg === 3)) return P.immediate;
      return base;
    }
    case 0x4: {
      if ((op & 0xffc0) === 0x4c00) return isDataEa(mode, reg) ? P.mulLong : P.illegal;
      if ((op & 0xffc0) === 0x4c40) return isDataEa(mode, reg) ? P.divLong : P.illegal;
      if ((op & 0xfff8) === 0x49c0) return P.extb;
      if ((op & 0xfff8) === 0x4808) return P.linkLong;
      if ((op & 0xfff8) === 0x4848) return P.bkpt;
      if ((op & 0xf1c0) === 0x4100) return isDataEa(mode, reg) ? P.chkLong : P.illegal;
      if (op === 0x4e74) return P.rtd;
      if ((op & 0xfffe) === 0x4e7a) return P.movec;
      if ((op & 0xffc0) === 0x42c0) return isDataAlterable(mode, reg) ? P.moveFromCcr : P.illegal;
      if ((op & 0xffc0) === 0x40c0) return isDataAlterable(mode, reg) ? P.moveFromSr020 : P.illegal;
      if ((op & 0xff00) === 0x4a00 && ((op >> 6) & 3) !== 3) {
        const valid = isValidEa(mode, reg) && !(mode === 1 && ((op >> 6) & 3) === 0);
        return valid ? P.tst020 : P.illegal;
      }
      return base;
    }
    case 0x5:
      if ((op & 0xf0f8) === 0x50f8 && reg >= 2 && reg <= 4) return P.trapcc;
      return base;
    case 0x6:
      return P.branch020;
    case 0x8:
      if ((op & 0xf1f0) === 0x8140 || (op & 0xf1f0) === 0x8180) return P.packUnpack;
      return base;
    case 0xe:
      if ((op & 0xf8c0) === 0xe8c0) {
        const kind = (op >> 8) & 7;
        // BFTST, BFEXTU, BFEXTS and BFFFO only read, so they take the PC-relative modes; the others need an alterable operand.
        const readOnly = kind === 0 || kind === 1 || kind === 3 || kind === 5;
        const valid = mode === 0 || (readOnly ? isControl(mode, reg) : isControl(mode, reg) && isAlterable(mode, reg));
        return valid ? P.bitField : P.illegal;
      }
      return base;
    default:
      return base;
  }
}

const OPCODES_020: Handler[] = Array.from({ length: 0x10000 }, (_, op) => decode020(op));

/** The 68030 adds the MMU instructions (coprocessor 0) to the 68020's. */
function decode030(op: number): Handler {
  if ((op & 0xffc0) === 0xf000) return P.mmu030;
  if ((op & 0xfe00) === 0xf200) return P.fpuInstruction;
  return OPCODES_020[op];
}

const OPCODES_030: Handler[] = Array.from({ length: 0x10000 }, (_, op) => decode030(op));
