import type { ChipRam } from '../memory/chip-ram';

const enum State {
  /** Halted by an illegal MOVE, until the next jump or vertical blank. */
  Stopped,
  /** After a jump: waits for a free even cycle, then fetches two cycles later. */
  RequestDma,
  /** Fetching the instruction's first word. */
  Fetch,
  /** Fetching a MOVE's second word, and writing the register. */
  Move,
  /** Fetching a WAIT's or SKIP's second word. */
  WaitOrSkip,
  /** The two cycles a WAIT takes after its fetches. */
  Wait1,
  Wait2,
  /** The two cycles a SKIP takes after its fetches. */
  Skip1,
  Skip2,
  /** Waiting for the comparator to match the beam. */
  BeamWait,
  /** Waiting for the blitter to finish (a WAIT without BFD). */
  BlitterWait,
  /** The blitter has finished: the Copper looks at the beam again. */
  BlitterDone,
  /** A MOVE to COPJMP1/2: two cycles, then the jump. */
  Jump1,
  Jump2,
  /** The vertical blank: the Copper restarts from COP1LC. */
  VerticalBlank,
}

const COPCON_CDANG = 0x0002;
const BFD = 0x8000;
const COPJMP1 = 0x088;
const COPJMP2 = 0x08a;
/** The beam position the comparator wraps at: it compares two cycles ahead, and from $E0 compares the line's start. */
const WRAP = 0xe0;
const NEVER = Number.MAX_SAFE_INTEGER;

export interface CopperHost {
  /** A MOVE: writes a custom register. */
  writeRegister(reg: number, value: number): void;
  readonly vpos: number;
  readonly hpos: number;
  readonly clock: number;
  /** Whether the blitter is running (a WAIT without BFD waits for it). */
  readonly blitterRunning: boolean;
  /** Whether the Copper may use this cycle: no other DMA has it, and Copper DMA is on. */
  busFree(): boolean;
  /** Whether no other DMA than the blitter has this cycle. */
  busFreeOrBlitter(): boolean;
  /** Takes this cycle's bus. */
  takeBus(): void;
}

/**
 * The Copper, the display co-processor: it runs a list of MOVE (write a register), WAIT (for a
 * beam position, and unless told otherwise for the blitter) and SKIP instructions, a step every
 * two cycles. A step that finds the bus taken is retried in the next cycle, so the Copper can
 * end up in odd cycles; it only wakes up in even ones. Its comparator looks two cycles ahead of
 * the beam. It restarts from COP1LC at every vertical blank.
 */
export class Copper {
  cop1lc = 0;
  cop2lc = 0;
  copcon = 0;
  pc = 0;
  private state = State.Stopped;
  /** The colour clock of the Copper's next step. */
  private due = NEVER;
  /** The list (1 or 2) the Copper runs, and the one a COPJMP from the Copper goes to. */
  private list = 1;
  private jumpTo = 1;
  private ir1 = 0;
  private ir2 = 0;
  /** A SKIP matched: the next MOVE is fetched but not done. */
  private skip = false;
  /** Whether the Copper ran in this frame (until then, writing the list's location also moves it there). */
  private activeInFrame = false;

  constructor(
    private readonly chip: ChipRam,
    private readonly host: CopperHost,
  ) {}

  reset(): void {
    this.cop1lc = this.cop2lc = this.copcon = this.pc = 0;
    this.state = State.Stopped;
    this.due = NEVER;
    this.list = this.jumpTo = 1;
    this.skip = this.activeInFrame = false;
  }

  /** A CPU write to COPJMP1/2: the Copper continues from that list (fetching from the next free even cycle). */
  jump(list: 1 | 2): void {
    this.switchTo(list);
    this.go(State.RequestDma, 0);
  }

  /** The vertical blank. */
  verticalBlank(copperDma: boolean): void {
    this.activeInFrame = copperDma;
    this.go(State.VerticalBlank, 0);
  }

  /** Copper DMA was switched on. */
  enabled(): void {
    this.activeInFrame = true;
  }

  writeLocation(list: 1 | 2, high: boolean, value: number): void {
    const old = list === 1 ? this.cop1lc : this.cop2lc;
    const next = (high ? (value << 16) | (old & 0xffff) : (old & 0xffff0000) | (value & 0xfffe)) & 0x1ffffe;
    if (list === 1) this.cop1lc = next;
    else this.cop2lc = next;
    if (!this.activeInFrame && this.list === list) this.pc = next;
  }

  /** The blitter finished: a Copper waiting for it carries on from the next even cycle. */
  blitterDone(): void {
    if (this.state !== State.BlitterWait) return;
    if (this.host.hpos & 1) {
      this.go(State.BlitterDone, 1);
    } else {
      this.state = State.BlitterDone;
      this.due = this.host.clock;
      this.step();
    }
  }

  /** Runs the Copper's step for this cycle, if one is due. */
  step(): void {
    const host = this.host;
    if (this.state === State.BeamWait) {
      if (this.comparator()) this.wakeUp();
      return;
    }
    if (host.clock < this.due) return;
    switch (this.state) {
      case State.RequestDma:
        if (!host.busFree() || host.hpos & 1) return this.retry();
        return this.go(State.Fetch);
      case State.Fetch:
        if (!host.busFree()) return this.retry();
        if (this.isSkip()) this.skip = this.comparator();
        this.ir1 = this.read();
        return this.go(this.ir1 & 1 ? State.WaitOrSkip : State.Move);
      case State.Move:
        return this.move();
      case State.WaitOrSkip:
        if (!host.busFree()) return this.retry();
        this.ir2 = this.read();
        return this.go(this.ir2 & 1 ? State.Skip1 : State.Wait1);
      case State.Wait1:
        if (!host.busFree()) return this.retry();
        return this.go(State.Wait2);
      case State.Wait2:
        this.skip = false;
        if (!(this.ir2 & BFD) && host.blitterRunning) return this.go(State.BlitterWait, NEVER);
        if (!host.busFree()) return this.retry();
        return this.waitForBeam();
      case State.BlitterDone:
        if (!host.busFreeOrBlitter()) return this.retry();
        return this.waitForBeam();
      case State.Skip1:
        if (!host.busFree()) return this.retry();
        return this.go(State.Skip2);
      case State.Skip2:
        if (!host.busFree()) return this.retry();
        return this.go(State.Fetch);
      case State.Jump1:
        // The bus isn't needed in this cycle, but it is taken; in $E0 the next step comes a cycle later.
        host.takeBus();
        return this.go(State.Jump2, host.hpos === WRAP ? 3 : 2);
      case State.Jump2:
        if (!host.busFree()) return this.retry();
        this.switchTo(this.jumpTo);
        return this.go(State.Fetch);
      case State.VerticalBlank:
        if (this.activeInFrame) {
          if (!host.busFree()) return this.retry();
          host.takeBus();
        }
        this.switchTo(1);
        return this.go(State.Fetch);
    }
  }

  private move(): void {
    const host = this.host;
    if (!host.busFree()) return this.retry();
    this.ir2 = this.read();
    const reg = this.ir1 & 0x1fe;
    // The Copper may never write below $40, and below $80 only with the danger bit set.
    if (reg < 0x40 || (reg < 0x80 && !(this.copcon & COPCON_CDANG))) {
      this.go(State.Stopped, NEVER);
      return;
    }
    this.go(State.Fetch);
    if (this.skip) {
      this.skip = false;
      return;
    }
    if (reg === COPJMP1 || reg === COPJMP2) {
      this.jumpTo = reg === COPJMP1 ? 1 : 2;
      this.go(State.Jump1);
      return;
    }
    host.writeRegister(reg, this.ir2);
  }

  /** After a WAIT's cycles: on at once if the beam is already there, else when it gets there. */
  private waitForBeam(): void {
    if (this.comparator()) this.go(State.Fetch);
    else this.go(State.BeamWait, NEVER);
  }

  /** The comparator matched while waiting: the Copper wakes in a free even cycle, if it still matches then. */
  private wakeUp(): void {
    const host = this.host;
    if (!(this.ir2 & BFD) && host.blitterRunning) {
      this.go(State.BlitterWait, NEVER);
      return;
    }
    if (!host.busFree() || host.hpos & 1) return;
    this.go(State.Fetch);
  }

  private isSkip(): boolean {
    return (this.ir1 & 1) === 1 && (this.ir2 & 1) === 1;
  }

  private read(): number {
    this.host.takeBus();
    const word = this.chip.read16(this.pc);
    this.pc = (this.pc + 2) & 0x1ffffe;
    return word;
  }

  private switchTo(list: number): void {
    this.list = list;
    this.pc = list === 1 ? this.cop1lc : this.cop2lc;
  }

  private go(state: State, delay = 2): void {
    this.state = state;
    this.due = delay === NEVER ? NEVER : this.host.clock + delay;
  }

  private retry(): void {
    this.due = this.host.clock + 1;
  }

  /**
   * The WAIT or SKIP position compared with the beam two cycles ahead (from $E0, the start of the
   * line); vertical bit 7 is always compared. A SKIP without BFD also needs the blitter finished.
   */
  private comparator(): boolean {
    const { ir1, ir2, host } = this;
    if (this.isSkip() && !(ir2 & BFD) && host.blitterRunning) return false;
    const vMask = ((ir2 >> 8) & 0x7f) | 0x80;
    const hMask = ir2 & 0xfe;
    const beamV = host.vpos & 0xff & vMask;
    const waitV = (ir1 >> 8) & vMask;
    if (beamV !== waitV) return beamV > waitV;
    const h = host.hpos < WRAP ? host.hpos + 2 : host.hpos - WRAP;
    return (h & hMask) >= (ir1 & hMask);
  }
}
