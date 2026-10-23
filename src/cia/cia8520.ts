const REG_PRA = 0x0;
const REG_PRB = 0x1;
const REG_DDRA = 0x2;
const REG_DDRB = 0x3;
const REG_TA_LO = 0x4;
const REG_TA_HI = 0x5;
const REG_TB_LO = 0x6;
const REG_TB_HI = 0x7;
const REG_TOD_LO = 0x8;
const REG_TOD_MID = 0x9;
const REG_TOD_HI = 0xa;
const REG_SDR = 0xc;
const REG_ICR = 0xd;
const REG_CRA = 0xe;
const REG_CRB = 0xf;

const ICR_TIMER_A = 0x01;
const ICR_TIMER_B = 0x02;
const ICR_ALARM = 0x04;
const ICR_SERIAL = 0x08;
const ICR_FLAG = 0x10;
const ICR_SET = 0x80;

const CR_START = 0x01;
const CR_ONE_SHOT = 0x08;
const CR_FORCE_LOAD = 0x10;
const CRA_COUNT_CNT = 0x20;
const CRA_SERIAL_OUT = 0x40;
const CRB_INPUT_MODE = 0x60;
const CRB_COUNT_TIMER_A = 0x40;
const CRB_ALARM = 0x80;

/** An output shift of the serial port takes 8 bits at two timer A underflows each. */
const SERIAL_OUT_UNDERFLOWS = 16;

class Timer {
  counter = 0xffff;
  latch = 0xffff;
  control = 0;

  get running(): boolean {
    return (this.control & CR_START) !== 0;
  }

  setLatchLow(value: number): void {
    this.latch = (this.latch & 0xff00) | value;
  }

  /** The 8520 loads a stopped timer on a high-byte write, and starts it there too in one-shot mode. */
  setLatchHigh(value: number): void {
    this.latch = (this.latch & 0x00ff) | (value << 8);
    if (this.control & CR_ONE_SHOT) {
      this.counter = this.latch;
      this.control |= CR_START;
    } else if (!this.running) {
      this.counter = this.latch;
    }
  }

  writeControl(value: number): void {
    if (value & CR_FORCE_LOAD) this.counter = this.latch;
    this.control = value & ~CR_FORCE_LOAD;
  }

  /** Counts down by `ticks` and returns how many times the timer underflowed. */
  countDown(ticks: number): number {
    this.counter -= ticks;
    if (this.counter >= 0) return 0;

    const overshoot = -this.counter - 1;
    if (this.control & CR_ONE_SHOT) {
      this.control &= ~CR_START;
      this.counter = this.latch;
      return 1;
    }
    const period = this.latch + 1;
    this.counter = this.latch - (overshoot % period);
    return 1 + Math.floor(overshoot / period);
  }
}

export interface CiaPorts {
  /** External pin levels for port A; lines not pulled low should read 1. */
  readPortA?: () => number;
  readPortB?: () => number;
  /** Called after a write that may have changed the port outputs. */
  onOutputChange?: () => void;
  /** The serial port switched direction (the keyboard's handshake is a switch to output and back). */
  onSerialDirection?: (output: boolean) => void;
}

/**
 * MOS 8520 Complex Interface Adapter, the Amiga's version of the C64's 6526:
 * two timers (in one-shot mode a load also starts them), a 24-bit binary
 * event counter in place of the time-of-day clock, with its alarm, the serial
 * port (the keyboard sends its key codes through CIA-A's), the FLAG input and
 * the two parallel ports. Timers count E-clock ticks (a tenth of the CPU clock).
 */
export class Cia8520 {
  /** The interrupt output; held until the ICR is read. */
  interrupt = false;
  /** Called when the interrupt output goes active. */
  onInterrupt: () => void = () => {};

  private pra = 0;
  private prb = 0;
  private ddra = 0;
  private ddrb = 0;
  private readonly timerA = new Timer();
  private readonly timerB = new Timer();
  private icrFlags = 0;
  private icrMask = 0;
  private sdr = 0;
  /** Timer A underflows left until a byte written to the serial port has gone out. */
  private serialOutLeft = 0;
  private tod = 0;
  private todLatch = 0;
  /** Reading the high byte freezes what the counter reads until the low byte is read. */
  private todLatched = false;
  /** Writing the high byte stops the counter until the low byte is written. */
  private todStopped = false;
  private alarm = 0;

  constructor(private readonly ports: CiaPorts = {}) {}

  reset(): void {
    this.pra = this.prb = this.ddra = this.ddrb = 0;
    this.timerA.counter = this.timerA.latch = 0xffff;
    this.timerB.counter = this.timerB.latch = 0xffff;
    this.timerA.control = this.timerB.control = 0;
    this.icrFlags = this.icrMask = 0;
    this.sdr = this.serialOutLeft = 0;
    this.tod = this.todLatch = this.alarm = 0;
    this.todLatched = this.todStopped = false;
    this.interrupt = false;
    this.ports.onOutputChange?.();
  }

  /** Port A levels as driven by the CIA (input lines float high). */
  get portADirection(): number {
    return this.ddra;
  }

  get portAOutput(): number {
    return (this.pra | ~this.ddra) & 0xff;
  }

  get portBOutput(): number {
    return (this.prb | ~this.ddrb) & 0xff;
  }

  get serialIsOutput(): boolean {
    return (this.timerA.control & CRA_SERIAL_OUT) !== 0;
  }

  /** Runs the timers for `ticks` E-clock cycles. */
  tick(ticks: number): void {
    let timerAUnderflows = 0;
    if (this.timerA.running && !(this.timerA.control & CRA_COUNT_CNT)) {
      timerAUnderflows = this.timerA.countDown(ticks);
      if (timerAUnderflows) {
        this.raise(ICR_TIMER_A);
        if (this.serialOutLeft > 0) {
          this.serialOutLeft -= timerAUnderflows;
          if (this.serialOutLeft <= 0) {
            this.serialOutLeft = 0;
            this.raise(ICR_SERIAL);
          }
        }
      }
    }

    if (this.timerB.running) {
      const mode = this.timerB.control & CRB_INPUT_MODE;
      let count = 0;
      if (mode === 0) count = ticks;
      else if (mode === CRB_COUNT_TIMER_A) count = timerAUnderflows;
      if (count && this.timerB.countDown(count)) this.raise(ICR_TIMER_B);
    }
  }

  /** A pulse on the TOD pin: vertical sync for CIA-A, horizontal sync for CIA-B. */
  countEvent(): void {
    if (this.todStopped) return;
    this.tod = (this.tod + 1) & 0xffffff;
    if (this.tod === this.alarm) this.raise(ICR_ALARM);
  }

  /** A byte shifted in on the serial port (from the keyboard, on CIA-A). */
  receiveSerial(value: number): void {
    this.sdr = value & 0xff;
    this.raise(ICR_SERIAL);
  }

  /** A falling edge on the FLAG pin (the disk index pulse, on CIA-B). */
  pulseFlag(): void {
    this.raise(ICR_FLAG);
  }

  read(register: number): number {
    switch (register & 0xf) {
      case REG_PRA:
        return this.portAOutput & (this.ports.readPortA?.() ?? 0xff);
      case REG_PRB:
        return this.portBOutput & (this.ports.readPortB?.() ?? 0xff);
      case REG_DDRA:
        return this.ddra;
      case REG_DDRB:
        return this.ddrb;
      case REG_TA_LO:
        return this.timerA.counter & 0xff;
      case REG_TA_HI:
        return this.timerA.counter >> 8;
      case REG_TB_LO:
        return this.timerB.counter & 0xff;
      case REG_TB_HI:
        return this.timerB.counter >> 8;
      case REG_TOD_LO: {
        const value = (this.todLatched ? this.todLatch : this.tod) & 0xff;
        this.todLatched = false;
        return value;
      }
      case REG_TOD_MID:
        return ((this.todLatched ? this.todLatch : this.tod) >> 8) & 0xff;
      case REG_TOD_HI:
        if (!this.todLatched) {
          this.todLatch = this.tod;
          this.todLatched = true;
        }
        return this.todLatch >> 16;
      case REG_SDR:
        return this.sdr;
      case REG_ICR: {
        const value = this.icrFlags | (this.interrupt ? ICR_SET : 0);
        this.icrFlags = 0;
        this.interrupt = false;
        return value;
      }
      case REG_CRA:
        return this.timerA.control;
      case REG_CRB:
        return this.timerB.control;
      default:
        return 0xff;
    }
  }

  write(register: number, value: number): void {
    value &= 0xff;
    switch (register & 0xf) {
      case REG_PRA:
        this.pra = value;
        this.ports.onOutputChange?.();
        break;
      case REG_PRB:
        this.prb = value;
        this.ports.onOutputChange?.();
        break;
      case REG_DDRA:
        this.ddra = value;
        this.ports.onOutputChange?.();
        break;
      case REG_DDRB:
        this.ddrb = value;
        this.ports.onOutputChange?.();
        break;
      case REG_TA_LO:
        this.timerA.setLatchLow(value);
        break;
      case REG_TA_HI:
        this.timerA.setLatchHigh(value);
        break;
      case REG_TB_LO:
        this.timerB.setLatchLow(value);
        break;
      case REG_TB_HI:
        this.timerB.setLatchHigh(value);
        break;
      case REG_TOD_LO:
        this.writeTod(0, value);
        if (!(this.timerB.control & CRB_ALARM)) this.todStopped = false;
        break;
      case REG_TOD_MID:
        this.writeTod(8, value);
        break;
      case REG_TOD_HI:
        this.writeTod(16, value);
        if (!(this.timerB.control & CRB_ALARM)) this.todStopped = true;
        break;
      case REG_SDR:
        this.sdr = value;
        if (this.serialIsOutput) this.serialOutLeft = SERIAL_OUT_UNDERFLOWS;
        break;
      case REG_ICR:
        if (value & ICR_SET) this.icrMask |= value & 0x1f;
        else this.icrMask &= ~value & 0x1f;
        this.updateInterrupt();
        break;
      case REG_CRA: {
        const wasOutput = this.serialIsOutput;
        this.timerA.writeControl(value);
        if (this.serialIsOutput !== wasOutput) this.ports.onSerialDirection?.(this.serialIsOutput);
        break;
      }
      case REG_CRB:
        this.timerB.writeControl(value);
        break;
    }
  }

  private writeTod(shift: number, value: number): void {
    const mask = ~(0xff << shift) & 0xffffff;
    if (this.timerB.control & CRB_ALARM) this.alarm = (this.alarm & mask) | (value << shift);
    else this.tod = (this.tod & mask) | (value << shift);
  }

  private raise(flag: number): void {
    this.icrFlags |= flag;
    this.updateInterrupt();
  }

  private updateInterrupt(): void {
    if (this.interrupt || !(this.icrFlags & this.icrMask)) return;
    this.interrupt = true;
    this.onInterrupt();
  }
}
