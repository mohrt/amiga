/** The hardware start and stop of bitplane fetching ($18 and $D8), whatever DDFSTRT and DDFSTOP say. */
const HARDWARE_START = 0x18;
const HARDWARE_STOP = 0xd8;
/** Past the last cycle of the longest (NTSC) line: the line's end. */
const LINE_END = 228;

// Things that happen at a position in the line, which can come together.
const SIG_SHW = 0x01;
const SIG_RHW = 0x02;
const SIG_BPHSTART = 0x04;
const SIG_BPHSTOP = 0x08;
const SIG_CON = 0x10;
const SIG_BMAPEN_SET = 0x20;
const SIG_BMAPEN_CLR = 0x40;
const SIG_VFLOP_SET = 0x80;
const SIG_VFLOP_CLR = 0x100;
const SIG_DONE = 0x200;

/** In each slot of the fetch table: the plane fetched (1-6), with this bit if its modulo is added after it. */
export const FETCH_MODULO = 0x80;

/**
 * Planes (1-based) fetched in the first eight cycles of a fetch unit, one pass over them or several:
 * all eight (lores, and AGA's wider fetches; the original chips have six, so 7 and 8 are free
 * cycles), four in two passes (hires), and two in four passes (super-hires).
 */
const EIGHT_PLANES = [8, 4, 6, 2, 7, 3, 5, 1];
const FOUR_PLANES = [4, 2, 3, 1, 4, 2, 3, 1];
const TWO_PLANES = [2, 1, 2, 1, 2, 1, 2, 1];

/** The OCS fetch logic's state, carried from one line to the next. */
interface DdfState {
  /** The vertical display window flip-flop. */
  bpv: boolean;
  /** Bitplane DMA on (DMAEN and BPLEN). */
  bmapen: boolean;
  /** The hardware start has been passed. */
  shw: boolean;
  /** The hardware stop has been passed. */
  rhw: boolean;
  bphstart: boolean;
  bphstop: boolean;
  /** Fetching. */
  bprun: boolean;
  /** The fetch unit under way is the last (it adds the modulos). */
  lastFu: boolean;
  /** A stop is pending: the next fetch unit is the last. */
  stopreq: boolean;
  bplcon0: number;
  /** Which pair of cycles of the fetch unit comes next (0-3). */
  cnt: number;
}

const initialState = (): DdfState => ({
  bpv: false,
  bmapen: false,
  shw: false,
  rhw: false,
  bphstart: false,
  bphstop: false,
  bprun: false,
  lastFu: false,
  stopreq: false,
  bplcon0: 0,
  cnt: 0,
});

/**
 * Bitplane fetching on the original (OCS) Agnus: which cycles of a line fetch which plane. It runs
 * in fetch units of eight cycles from DDFSTRT (or the hardware start) while the vertical display
 * window is open, bitplane DMA is on and BPLCON0 has planes; once DDFSTOP (or the hardware stop)
 * is passed, one more unit is fetched, adding each plane's modulo. Changes during a line are
 * signals at a position, and the line's fetch table is worked out again from its start with them,
 * as vAmiga does it (its model was checked against real machines).
 */
export class DdfSequencer {
  /** Super Agnus (ECS): its start and stop logic differs, and DDFSTRT/DDFSTOP take one more bit. */
  ecs = false;
  /** Alice (AGA): eight planes, and FMODE's wider fetches with longer fetch units. */
  aga = false;
  fmode = 0;
  ddfstrt = 0;
  ddfstop = 0;
  /** The state at the start of the line, and at its end. */
  private initial = initialState();
  private state = initialState();
  /** This line's signals: positions, and what happens at each. */
  private positions: number[] = [];
  private signals: number[] = [];
  /** BPLCON0 for each SIG_CON signal, in order. */
  private values: number[] = [];

  reset(): void {
    this.ddfstrt = this.ddfstop = 0;
    this.initial = initialState();
    this.state = initialState();
    this.startLine(false);
  }

  /** The start of a line, with the vertical window flip-flop for it. */
  startLine(bpv: boolean): void {
    this.initial = { ...this.state, bpv };
    this.positions = [];
    this.signals = [];
    this.values = [];
    this.add(HARDWARE_START, SIG_SHW);
    this.add(this.ddfstrt, SIG_BPHSTART);
    this.add(this.ddfstop, SIG_BPHSTOP);
    this.add(HARDWARE_STOP, SIG_RHW);
    this.add(LINE_END, SIG_DONE);
  }

  /** At the start of the line: whether bitplane DMA is on, and BPLCON0. */
  setLineStart(bmapen: boolean, bplcon0: number): void {
    this.initial.bmapen = bmapen;
    this.initial.bplcon0 = bplcon0;
  }

  private get mask(): number {
    return this.ecs ? 0xfe : 0xfc;
  }

  writeDdfStart(value: number, hpos: number): void {
    this.ddfstrt = value & this.mask;
    this.remove(hpos, SIG_BPHSTART);
    if (this.ddfstrt > hpos) this.add(this.ddfstrt, SIG_BPHSTART);
  }

  writeDdfStop(value: number, hpos: number): void {
    this.ddfstop = value & this.mask;
    this.remove(hpos + 1, SIG_BPHSTOP);
    if (this.ddfstop > hpos) this.add(this.ddfstop, SIG_BPHSTOP);
  }

  /** BPLCON0's planes or resolution changed. */
  writeBplcon0(value: number, hpos: number): void {
    this.add(hpos, SIG_CON, value);
  }

  /** Bitplane DMA switched on or off: it takes effect three cycles later. */
  setDma(on: boolean, hpos: number): void {
    this.add(hpos + 3, on ? SIG_BMAPEN_SET : SIG_BMAPEN_CLR);
  }

  /** The vertical window opened or closed during the line: two cycles later. */
  setVerticalWindow(open: boolean, hpos: number): void {
    this.add(hpos + 2, open ? SIG_VFLOP_SET : SIG_VFLOP_CLR);
  }

  /** Works out the line's fetch table (plane per cycle, with FETCH_MODULO) from its start. */
  compute(table: Uint8Array): void {
    const state = { ...this.initial };
    if (!state.bpv) {
      state.bprun = false;
      state.cnt = 0;
    }
    let cycle = 0;
    let valueIndex = 0;
    for (let i = 0; i < this.positions.length; i++) {
      const trigger = this.positions[i];
      this.fill(table, cycle, trigger, state);
      const signal = this.signals[i];
      if (signal & SIG_CON) state.bplcon0 = this.values[valueIndex++];
      if (this.ecs) this.processEcs(signal, state);
      else this.process(signal, state);
      cycle = trigger;
      if (signal & SIG_DONE) break;
    }
    table.fill(0, cycle);
    this.state = state;
  }

  private fill(table: Uint8Array, from: number, to: number, state: DdfState): void {
    const { unit, planes, size } = this.fetchUnit(state.bplcon0);
    // The last unit adds each plane's modulo at its last fetch in the unit.
    const lastPass = unit === TWO_PLANES ? 6 : unit === FOUR_PLANES ? 4 : 0;
    const countMask = size * 4 - 1;
    for (let j = from; j < to && j < table.length; j++) {
      const counter = (state.cnt << 1) | (j & 1);
      if (counter === 0) {
        if (state.lastFu) {
          state.bprun = false;
          state.lastFu = false;
          state.bphstop = false;
          if (!this.ecs) state.shw = false;
        }
        if (state.stopreq) {
          state.stopreq = false;
          state.lastFu = true;
        }
      }
      if (state.bprun) {
        const plane = counter < 8 ? unit[counter] : 0;
        const modulo = state.lastFu && counter >= lastPass;
        table[j] = plane > 0 && plane <= planes ? plane | (modulo ? FETCH_MODULO : 0) : 0;
        if (j & 1) state.cnt = (state.cnt + 1) & countMask;
      } else {
        table[j] = 0;
        state.cnt = 0;
      }
    }
  }

  /**
   * The fetch unit for BPLCON0 (and AGA's FMODE): which planes go in its first eight cycles, how
   * many planes are fetched (the invalid counts fetch fewer or none), and how many times eight
   * cycles it lasts.
   */
  private fetchUnit(bplcon0: number): { unit: number[]; planes: number; size: number } {
    const shres = this.ecs && (bplcon0 & 0x0040) !== 0;
    const hires = !shres && (bplcon0 & 0x8000) !== 0;
    const fm = this.aga ? this.fmode & 3 : 0;
    if (this.aga) {
      const bpu = ((bplcon0 >> 12) & 7) | ((bplcon0 >> 1) & 8);
      const valid = bpu <= 8 ? bpu : 0;
      // More planes than the mode can fetch fetches none.
      if (shres) {
        const unit = fm === 0 ? TWO_PLANES : fm === 3 ? EIGHT_PLANES : FOUR_PLANES;
        return { unit, planes: valid > (fm === 0 ? 2 : fm === 3 ? 8 : 4) ? 0 : valid, size: 1 };
      }
      if (hires) return { unit: fm === 0 ? FOUR_PLANES : EIGHT_PLANES, planes: fm === 0 && valid > 4 ? 0 : valid, size: fm === 3 ? 2 : 1 };
      return { unit: EIGHT_PLANES, planes: valid, size: fm === 3 ? 4 : fm === 0 ? 1 : 2 };
    }
    const bpu = (bplcon0 >> 12) & 7;
    if (shres) return { unit: TWO_PLANES, planes: bpu <= 2 ? bpu : 0, size: 1 };
    if (hires) return { unit: FOUR_PLANES, planes: bpu <= 4 ? bpu : 0, size: 1 };
    // Seven planes fetches four in lores.
    return { unit: EIGHT_PLANES, planes: bpu === 7 ? 4 : Math.min(bpu, 6), size: 1 };
  }

  private process(signal: number, state: DdfState): void {
    if (signal & SIG_BMAPEN_CLR) {
      state.bmapen = false;
      state.bprun = false;
      state.cnt = 0;
    } else if (signal & SIG_BMAPEN_SET) {
      state.bmapen = true;
    }
    if (signal & SIG_VFLOP_SET) {
      state.bpv = true;
    } else if (signal & SIG_VFLOP_CLR) {
      state.bpv = false;
      state.bprun = false;
      state.cnt = 0;
    }
    if (signal & SIG_SHW) {
      state.shw = true;
    } else if (signal & SIG_RHW) {
      state.rhw = state.rhw || state.bprun;
      state.stopreq = state.stopreq || state.bprun;
    }
    const start = (signal & SIG_BPHSTART) !== 0;
    const stop = (signal & SIG_BPHSTOP) !== 0;
    if (start && stop) {
      if (state.bprun) {
        state.bphstart = false;
        state.bphstop = true;
        state.stopreq = true;
      } else {
        state.bphstart = state.bphstart || state.shw;
        state.bprun = state.shw && state.bpv && state.bmapen;
      }
    } else if (start) {
      state.bphstart = state.bphstart || (state.shw && state.bmapen);
      state.bprun = (state.bprun || state.shw) && state.bpv && state.bmapen;
    } else if (stop) {
      if (state.bprun) {
        state.bphstart = false;
        state.bphstop = true;
        state.stopreq = true;
      }
    }
    if (signal & SIG_DONE) {
      state.rhw = false;
      state.stopreq = false;
    }
  }

  /** Super Agnus's logic: the hardware start lets a pending DDFSTRT run, and DMA coming on can start fetching. */
  private processEcs(signal: number, state: DdfState): void {
    if (signal & SIG_VFLOP_SET) {
      state.bpv = true;
    } else if (signal & SIG_VFLOP_CLR) {
      state.bpv = false;
      state.bprun = false;
      state.cnt = 0;
    }
    if (signal & SIG_SHW) {
      state.shw = true;
      state.bprun = state.bprun || (state.bphstart && !(signal & SIG_BPHSTOP));
    } else if (signal & SIG_RHW) {
      state.rhw = true;
      state.stopreq = state.stopreq || state.bprun;
    }
    const start = (signal & SIG_BPHSTART) !== 0;
    const stop = (signal & SIG_BPHSTOP) !== 0;
    if (start && stop) {
      if (signal & SIG_SHW) {
        state.bphstart = true;
        state.bprun = (state.bprun || state.shw) && state.bpv && state.bmapen;
      } else if (signal & SIG_RHW) {
        state.bphstop = state.bphstop || state.bprun;
        state.stopreq = state.stopreq || state.bprun;
        state.bphstart = true;
      } else {
        state.bphstop = state.bphstop || state.bprun;
        state.stopreq = state.stopreq || state.bprun;
        state.bphstart = state.bpv;
        state.bprun = (state.bprun || state.shw) && state.bpv && state.bmapen;
      }
    } else if (start) {
      state.bphstart = true;
      state.bprun = (state.bprun || state.shw) && state.bpv && state.bmapen;
    } else if (stop) {
      state.bphstart = false;
      state.bphstop = state.bphstop || state.bprun;
      state.stopreq = state.stopreq || state.bprun;
    }
    if (signal & SIG_BMAPEN_CLR) {
      state.bmapen = false;
      state.bprun = false;
      state.cnt = 0;
    } else if (signal & SIG_BMAPEN_SET) {
      state.bmapen = true;
      state.bprun = (state.bprun || state.shw) && state.bpv && state.bphstart;
    }
    if (signal & SIG_DONE) {
      state.rhw = false;
      state.shw = false;
      state.bphstop = false;
      // AGA's longer fetch units stop hard at the end of the line.
      if (this.aga && this.fetchUnit(state.bplcon0).size > 1) {
        state.bprun = false;
        state.lastFu = false;
        state.stopreq = false;
        state.cnt = 0;
      }
    }
  }

  /**
   * Adds a signal (a position past the line's end is dropped). It joins others at the same
   * position, except that a BPLCON0 change goes first, with its own value.
   */
  private add(position: number, signal: number, value = 0): void {
    if (position > LINE_END) return;
    let i = this.positions.length;
    while (i > 0 && (this.positions[i - 1] > position || (signal & SIG_CON && this.positions[i - 1] === position))) i--;
    if (i > 0 && this.positions[i - 1] === position && !(signal & SIG_CON) && !(this.signals[i - 1] & SIG_CON)) {
      this.signals[i - 1] |= signal;
      return;
    }
    this.positions.splice(i, 0, position);
    this.signals.splice(i, 0, signal);
    if (signal & SIG_CON) {
      const before = this.signals.slice(0, i).filter((s) => s & SIG_CON).length;
      this.values.splice(before, 0, value);
    }
  }

  /** Takes a signal off from `position` on (where it hasn't been reached yet). */
  private remove(position: number, signal: number): void {
    for (let i = 0; i < this.positions.length; i++) {
      if (this.positions[i] >= position) this.signals[i] &= ~signal;
    }
  }
}
