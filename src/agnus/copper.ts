import type { ChipRam } from '../memory/chip-ram';

const enum State {
  Stopped,
  /** About to load its program counter from COP1LC or COP2LC (at its next memory cycle). */
  Jump,
  /** Fetching the instruction's first word. */
  Fetch1,
  /** Fetching its second word; the instruction runs once it arrives. */
  Fetch2,
  /** Waiting for the beam (and maybe the blitter). */
  Waiting,
}

const COPCON_CDANG = 0x0002;

export interface CopperHost {
  /** A MOVE: writes a custom register (COPJMP included). */
  writeRegister(reg: number, value: number): void;
  readonly vpos: number;
  readonly hpos: number;
  readonly blitterBusy: boolean;
}

/**
 * The Copper, the display co-processor: it runs a list of MOVE (write a
 * register), WAIT (for a beam position, and unless told otherwise for the
 * blitter) and SKIP instructions, taking even memory cycles. It restarts from
 * COP1LC at every vertical blank.
 */
export class Copper {
  cop1lc = 0;
  cop2lc = 0;
  copcon = 0;
  pc = 0;
  private state = State.Stopped;
  /** Which location register the pending jump loads (1 or 2). */
  private jumpTo = 1;
  private ir1 = 0;
  private ir2 = 0;

  constructor(
    private readonly chip: ChipRam,
    private readonly host: CopperHost,
  ) {}

  reset(): void {
    this.cop1lc = this.cop2lc = this.copcon = this.pc = 0;
    this.state = State.Stopped;
  }

  /**
   * The vertical blank, or a write to COPJMP1/2. The location register is read
   * when the Copper next gets a memory cycle, so a program can change COP1LC
   * while Copper DMA is off and the Copper starts there when it is switched on.
   */
  jump(register: 1 | 2): void {
    this.jumpTo = register;
    this.state = State.Jump;
  }

  /** Whether the Copper wants this (even) memory cycle. */
  get wantsCycle(): boolean {
    return this.state === State.Fetch1 || this.state === State.Fetch2 || this.state === State.Jump;
  }

  get waiting(): boolean {
    return this.state === State.Waiting;
  }

  /** Checks a WAIT against the beam; once it is passed the Copper fetches again. */
  checkWait(): void {
    if (this.beamReached()) this.state = State.Fetch1;
  }

  /** Uses a memory cycle Agnus gave it. */
  cycle(): void {
    if (this.state === State.Jump) {
      this.pc = this.jumpTo === 1 ? this.cop1lc : this.cop2lc;
      this.state = State.Fetch1;
      return;
    }
    if (this.state === State.Fetch1) {
      this.ir1 = this.chip.read16(this.pc);
      this.pc = (this.pc + 2) & 0x1ffffe;
      this.state = State.Fetch2;
      return;
    }
    this.ir2 = this.chip.read16(this.pc);
    this.pc = (this.pc + 2) & 0x1ffffe;
    this.state = State.Fetch1;
    if (!(this.ir1 & 1)) {
      const reg = this.ir1 & 0x1fe;
      // The Copper may never write below $40, and below $80 only with the danger bit set.
      if (reg < 0x40 || (reg < 0x80 && !(this.copcon & COPCON_CDANG))) {
        this.state = State.Stopped;
        return;
      }
      this.host.writeRegister(reg, this.ir2);
    } else if (!(this.ir2 & 1)) {
      this.state = this.beamReached() ? State.Fetch1 : State.Waiting;
    } else if (this.beamReached()) {
      this.pc = (this.pc + 4) & 0x1ffffe;
    }
  }

  /** The WAIT or SKIP position compared with the beam; vertical bit 7 is always compared. */
  private beamReached(): boolean {
    const { ir1, ir2, host } = this;
    if (!(ir2 & 0x8000) && host.blitterBusy) return false;
    const vMask = ((ir2 >> 8) & 0x7f) | 0x80;
    const hMask = ir2 & 0xfe;
    const beamV = host.vpos & 0xff & vMask;
    const waitV = (ir1 >> 8) & vMask;
    if (beamV !== waitV) return beamV > waitV;
    return (host.hpos & hMask) >= (ir1 & hMask);
  }
}
