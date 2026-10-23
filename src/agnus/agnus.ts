import type { Denise } from '../denise/denise';
import type { ChipRam } from '../memory/chip-ram';
import { Dma, Reg } from '../custom/registers';
import { Blitter, type BlitterBus } from './blitter';
import { Copper } from './copper';
import { DdfSequencer, FETCH_MODULO } from './ddf';

export type VideoStandard = 'pal' | 'ntsc';

/** Colour clocks per second: half the CPU clock. */
export const CCK_HZ: Record<VideoStandard, number> = { pal: 3546895, ntsc: 3579545 };
/** Colour clocks in a line (NTSC lines alternate 227 and 228). */
const LINE_CCKS = 227;
/** Lines in a long frame; short (interlaced) frames have one fewer. */
const FRAME_LINES: Record<VideoStandard, number> = { pal: 313, ntsc: 263 };
/** Sprite DMA starts on the first line after the vertical blank. */
const SPRITE_START_LINE = 25;
/**
 * Denise's lines start here, at the end of horizontal blanking's first part: a
 * TV line runs on into the start of the next Agnus line, so a display window
 * past lores $1C6 shows, and a colour change at the start of a line appears at
 * the right edge of the line before, as on the hardware.
 */
const DENISE_LINE_START = 0x10;
/** The picture's first line (each frame shows from here down). */
const FIRST_PICTURE_LINE = 0x1c;
export const PICTURE_LINES: Record<VideoStandard, number> = { pal: 284, ntsc: 234 };

// What uses each memory cycle of a line.
const SLOT_FREE = 0;
const SLOT_REFRESH = 1;
const SLOT_DISK = 2;
const SLOT_AUDIO = 3;
const SLOT_SPRITE = 0x10;
/** AGA FMODE bit 15: sprite scan doubling. */
const FMODE_SSCAN2 = 0x8000;
const SLOT_SPRITE_SECOND = 0x18;
const SLOT_BITPLANE = 0x20;
/** A bitplane fetch that adds the plane's modulo after it (the last fetch unit's). */
const SLOT_MODULO = 0x08;
/** The last refresh cycle: bitplane fetches stop short of it. */
const REFRESH_END = 0xe2;

/** Who has the bus in the current cycle. */
const enum Bus {
  Free,
  /** Refresh, disk, audio, sprite or bitplane DMA. */
  Dma,
  Copper,
  Blitter,
  Cpu,
  /** Cycle $E0 when the Copper wanted it: nobody gets it. */
  Blocked,
}
/** How far ahead of the current cycle VHPOSR and VPOSR read the beam (as vAmiga measured it). */
const BEAM_READ_AHEAD = 5;
/** The Copper can't have this cycle (on NTSC's long lines, the one after). */
const COPPER_BLOCKED_CYCLE = 0xe0;


const enum SpriteState {
  Idle,
  /** Fetching POS and CTL this line. */
  Control,
  /** Waiting for its first line. */
  Waiting,
  /** Fetching DATA and DATB each line. */
  Data,
}

const POINTER_MASK = 0x1ffffe;
const signed16 = (value: number) => ((value & 0xffff) ^ 0x8000) - 0x8000;

export interface AgnusHost {
  /** A Copper MOVE. */
  writeRegister(reg: number, value: number): void;
  /** The start of each line (horizontal sync) and frame (vertical blank). */
  onLine(vpos: number): void;
  onFrame(): void;
  /** Whether disk and audio DMA use their cycles this line. */
  readonly diskDma: boolean;
  audioDma(channel: number): boolean;
  /** Every colour clock, for the chips that count them (sound, disk, the CIAs' E clock). */
  tick(): void;
  /** A register write made with `delayWrite` takes effect. */
  applyDelayedWrite(reg: number, value: number, part: number): void;
}

/**
 * The Agnus chip: the beam counter, DMA control and the allocation of each
 * line's memory cycles (refresh, disk, audio, sprites, bitplanes, then the
 * Copper on even cycles, the blitter, and the CPU in whatever is left),
 * bitplane and sprite DMA, and the Copper and blitter. Time runs in colour
 * clocks, one memory cycle each.
 */
export class Agnus {
  standard: VideoStandard = 'pal';
  /** Colour clocks since power on. */
  clock = 0;
  hpos = 0;
  vpos = 0;
  /** Long frame (interlace alternates long and short frames). */
  lof = true;
  /** NTSC's long line (228 colour clocks). */
  private lol = false;
  lineLength = LINE_CCKS;
  /** The length of the line before, which Denise's current line started in. */
  private previousLineLength = LINE_CCKS;
  frames = 0;
  dmacon = 0;
  diwstrt = 0;
  diwstop = 0;
  /** Agnus's copy of BPLCON0 (the planes and resolution it fetches for). */
  bplcon0 = 0;
  /** Super Agnus (ECS): its ID, DDF logic and DIWHIGH. */
  ecs = false;
  /** Alice (AGA): eight planes and FMODE's 32 and 64-bit fetches. */
  aga = false;
  /** AGA's FMODE: the bitplane fetch width (bits 0-1) and the sprites' (bits 2-3). */
  fmode = 0;
  /** ECS: the high bits of the vertical window (V8-V10 of start and stop), until DIWSTRT or DIWSTOP is written again. */
  private diwhigh = -1;
  readonly ddf = new DdfSequencer();
  readonly bplpt = new Uint32Array(8);
  bpl1mod = 0;
  bpl2mod = 0;
  readonly sprpt = new Uint32Array(8);
  /** A wide sprite fetch's words after the first. */
  private readonly spriteRest: number[] = [];
  private readonly spriteState = new Uint8Array(8);
  private readonly spriteStart = new Uint16Array(8);
  private readonly spriteStop = new Uint16Array(8);
  readonly copper: Copper;
  readonly blitter: Blitter;
  /** The owner of each memory cycle of the current line. */
  private readonly slots = new Uint8Array(232);
  /** The slots before a DMACON change, for the cycles it doesn't reach yet. */
  private readonly previousSlots = new Uint8Array(232);
  /** The bitplane fetches of the current line (from the DDF sequencer). */
  private readonly fetches = new Uint8Array(232);
  /** Register writes that take effect a few cycles later: the cycle, the register, the value and the part (flattened). */
  private pendingWrites: number[] = [];
  /**
   * The vertical display window, a flip-flop (bitplane DMA and display on): set at the start of
   * line VSTART, cleared at line VSTOP and at the frame's last line, and otherwise kept.
   */
  verticalWindow = false;
  /** Who has the bus in the current cycle, once its DMA has been worked out. */
  private busOwner = Bus.Free;
  /** Whether the current cycle's DMA has been worked out (the CPU gets the bus after that). */
  private cycleProcessed = false;
  /** The CPU has waited two cycles: the blitter lets it have the next one, unless BLTPRI. */
  private cpuWaiting = false;
  private readonly blitterBus: BlitterBus;
  /** Called when a blit finishes. */
  onBlitDone: () => void = () => {};

  constructor(
    private readonly chip: ChipRam,
    private readonly denise: Denise,
    private readonly host: AgnusHost,
  ) {
    const agnus = this;
    this.copper = new Copper(chip, {
      writeRegister: (reg, value) => host.writeRegister(reg, value),
      get vpos() {
        return agnus.vpos;
      },
      get hpos() {
        return agnus.hpos;
      },
      get clock() {
        return agnus.clock;
      },
      get blitterRunning() {
        return agnus.blitter.running;
      },
      busFree: () => this.copperBusFree(),
      busFreeOrBlitter: () => this.busOwner === Bus.Free || this.busOwner === Bus.Blitter,
      takeBus: () => (this.busOwner = Bus.Copper),
    });
    this.blitter = new Blitter(chip);
    this.blitterBus = {
      free: () =>
        this.busOwner === Bus.Free && this.dmaOn && (this.dmacon & Dma.BLTEN) !== 0 && !(this.cpuWaiting && !(this.dmacon & Dma.BLTPRI)),
      take: () => (this.busOwner = Bus.Blitter),
    };
    this.blitter.onDone = () => {
      this.copper.blitterDone();
      this.onBlitDone();
    };
    denise.lineStartX = DENISE_LINE_START * 4;
    denise.beamX = () => (this.hpos >= DENISE_LINE_START ? this.hpos : this.hpos + this.previousLineLength) * 4;
  }

  get frameLines(): number {
    return FRAME_LINES[this.standard] - (this.lof ? 0 : 1);
  }

  reset(): void {
    this.hpos = this.vpos = 0;
    this.lof = true;
    this.dmacon = 0;
    this.diwstrt = this.diwstop = this.bplcon0 = this.fmode = this.ddf.fmode = 0;
    this.diwhigh = -1;
    this.ddf.reset();
    this.pendingWrites = [];
    this.bplpt.fill(0);
    this.bpl1mod = this.bpl2mod = 0;
    this.sprpt.fill(0);
    this.spriteState.fill(SpriteState.Idle);
    this.copper.reset();
    this.blitter.reset();
    this.busOwner = Bus.Free;
    this.cycleProcessed = this.cpuWaiting = false;
    this.denise.outputLines = PICTURE_LINES[this.standard];
    this.startLine();
    this.denise.startLine(this.vpos - FIRST_PICTURE_LINE, this.lof);
  }

  private get dmaOn(): boolean {
    return (this.dmacon & Dma.DMAEN) !== 0;
  }

  /** Chooses the original Agnus or Super Agnus (on a power on). */
  setChipset(ecs: boolean, aga = false): void {
    this.ecs = ecs || aga;
    this.aga = aga;
    this.ddf.ecs = this.ecs;
    this.ddf.aga = aga;
    this.blitter.ecs = this.ecs;
  }

  /**
   * The modulo a plane's pointer adds: BPL1MOD for the odd planes and BPL2MOD for the even ones,
   * or with AGA's BSCAN2 (FMODE bit 14) by the line's parity from the window's top, for scan doubling.
   */
  private bitplaneModulo(plane: number): number {
    if (this.aga && this.fmode & 0x4000) return ((this.diwstrt >> 8) ^ (this.vpos ^ 1)) & 1 ? this.bpl1mod : this.bpl2mod;
    return plane & 1 ? this.bpl2mod : this.bpl1mod;
  }

  /** Words a bitplane fetch reads: 1, or AGA's 2 or 4. */
  get fetchWords(): number {
    if (!this.aga) return 1;
    const fm = this.fmode & 3;
    return fm === 0 ? 1 : fm === 3 ? 4 : 2;
  }

  get vposr(): number {
    const id = (this.standard === 'ntsc' ? 0x10 : 0x00) | (this.aga ? 0x23 : this.ecs ? 0x20 : 0);
    return (this.lof ? 0x8000 : 0) | (id << 8) | (this.lol ? 0x80 : 0) | ((this.readBeam()[0] >> 8) & 1);
  }

  get vhposr(): number {
    const [v, h] = this.readBeam();
    return ((v & 0xff) << 8) | (h & 0xff);
  }

  /** The beam position the CPU reads: the counters run ahead of the cycle being worked on. */
  private readBeam(): [number, number] {
    let h = this.hpos + BEAM_READ_AHEAD;
    let v = this.vpos;
    if (h >= this.lineLength) {
      h -= this.lineLength;
      if (++v >= this.frameLines) v = 0;
    }
    // In the line's first two cycles the vertical counter hasn't moved on yet.
    return [h <= 1 ? this.vpos : v, h];
  }

  writeVposw(value: number): void {
    this.lof = (value & 0x8000) !== 0;
  }

  get dmaconr(): number {
    return (this.dmacon & 0x07ff) | (this.blitter.busy ? Dma.BBUSY : 0) | (this.blitter.zero ? Dma.BZERO : 0);
  }

  writeDmacon(value: number): void {
    const before = this.dmacon;
    this.dmacon = (value & 0x8000 ? this.dmacon | value : this.dmacon & ~value) & 0x07ff;
    if (this.dmacon & ~before & Dma.COPEN) this.copper.enabled();
    const bitplanes = (dmacon: number) => (dmacon & (Dma.DMAEN | Dma.BPLEN)) === (Dma.DMAEN | Dma.BPLEN);
    if (bitplanes(before) !== bitplanes(this.dmacon)) this.ddf.setDma(bitplanes(this.dmacon), this.hpos);
    // Disk and sprite DMA switched on or off take effect two cycles on.
    const das = Dma.DMAEN | Dma.DSKEN | Dma.SPREN;
    this.buildSlots((before ^ this.dmacon) & das ? this.hpos + 2 : 0);
  }

  /** Agnus's part of BPLCON0: a change of planes or resolution changes the fetches from here on. */
  writeBplcon0(value: number): void {
    const changed = (this.bplcon0 ^ value) & 0xf050;
    this.bplcon0 = value;
    if (changed) {
      this.ddf.writeBplcon0(value, this.hpos);
      this.buildSlots();
    }
  }

  /** A register write that takes effect `delay` cycles from now; `part` says which chip's part (for the host). */
  delayWrite(delay: number, reg: number, value: number, part = 0): void {
    this.pendingWrites.push(this.clock + delay, reg, value, part);
  }

  /** The registers Agnus keeps: display window and fetch, pointers and modulos, the Copper's and the blitter's. */
  writeRegister(reg: number, value: number): void {
    if (reg >= Reg.BPL1PT && reg <= (this.aga ? Reg.BPL8PT_END : Reg.BPL6PT_END)) {
      const plane = (reg - Reg.BPL1PT) >> 2;
      this.bplpt[plane] = reg & 2 ? ((this.bplpt[plane] & 0xffff0000) | value) & POINTER_MASK : ((value << 16) | (this.bplpt[plane] & 0xffff)) & POINTER_MASK;
      return;
    }
    if (reg >= Reg.SPR0PT && reg <= Reg.SPR7PT_END) {
      const n = (reg - Reg.SPR0PT) >> 2;
      this.sprpt[n] = reg & 2 ? ((this.sprpt[n] & 0xffff0000) | value) & POINTER_MASK : ((value << 16) | (this.sprpt[n] & 0xffff)) & POINTER_MASK;
      return;
    }
    if (reg >= Reg.BLTCON0 && reg <= Reg.BLTADAT) {
      this.blitter.write(reg, value);
      return;
    }
    switch (reg) {
      case Reg.DIWSTRT:
        this.diwstrt = value;
        this.diwhigh = -1;
        this.checkVerticalWindow();
        break;
      case Reg.DIWSTOP:
        this.diwstop = value;
        this.diwhigh = -1;
        this.checkVerticalWindow();
        break;
      case Reg.FMODE:
        if (!this.aga) break;
        this.fmode = value;
        this.ddf.fmode = value;
        this.denise.writeSscan2((value & FMODE_SSCAN2) !== 0);
        this.buildSlots();
        break;
      case Reg.DIWHIGH:
        if (!this.ecs) break;
        this.diwhigh = value;
        this.checkVerticalWindow();
        break;
      case Reg.DDFSTRT:
        this.ddf.writeDdfStart(value, this.hpos);
        this.buildSlots();
        break;
      case Reg.DDFSTOP:
        this.ddf.writeDdfStop(value, this.hpos);
        this.buildSlots();
        break;
      case Reg.BPL1MOD:
        this.bpl1mod = signed16(value & 0xfffe);
        break;
      case Reg.BPL2MOD:
        this.bpl2mod = signed16(value & 0xfffe);
        break;
      case Reg.COP1LCH:
        this.copper.writeLocation(1, true, value);
        break;
      case Reg.COP1LCL:
        this.copper.writeLocation(1, false, value);
        break;
      case Reg.COP2LCH:
        this.copper.writeLocation(2, true, value);
        break;
      case Reg.COP2LCL:
        this.copper.writeLocation(2, false, value);
        break;
      case Reg.COPJMP1:
        this.copper.jump(1);
        break;
      case Reg.COPJMP2:
        this.copper.jump(2);
        break;
      case Reg.COPCON:
        this.copper.copcon = value;
        break;
    }
  }

  /** Agnus watches writes to SPRxPOS and SPRxCTL for the sprite's first and last lines. */
  noteSpritePosition(n: number, pos: number, ctl: number): void {
    this.spriteStart[n] = ((ctl & 0x04) << 6) | (pos >> 8);
    this.spriteStop[n] = ((ctl & 0x02) << 7) | (ctl >> 8);
  }

  /** Something that decides the line's DMA changed (BPLCON0's planes and resolution, disk DMA starting). */
  rebuildSlots(): void {
    this.buildSlots();
  }

  // --- Lines and cycles ----------------------------------------------------------------

  private get verticalStart(): number {
    return (this.diwstrt >> 8) | (this.diwhigh >= 0 ? (this.diwhigh & 7) << 8 : 0);
  }

  /** VSTOP's bit 8 is the inverse of its bit 7, unless ECS's DIWHIGH gives the high bits. */
  private get verticalStop(): number {
    if (this.diwhigh >= 0) return (this.diwstop >> 8) | (((this.diwhigh >> 8) & 7) << 8);
    return (this.diwstop >> 8) | (this.diwstop & 0x8000 ? 0 : 0x100);
  }

  /** A DIWSTRT or DIWSTOP write in the line it names switches the window on or off for the rest of the line. */
  private checkVerticalWindow(): void {
    const vpos = this.vpos;
    let open = this.verticalWindow;
    if (vpos === this.verticalStop) open = false;
    else if (vpos === this.verticalStart) open = true;
    if (open === this.verticalWindow) return;
    this.verticalWindow = open;
    this.ddf.setVerticalWindow(open, this.hpos);
    this.buildSlots();
  }

  private startLine(): void {
    const vpos = this.vpos;
    if (vpos === this.verticalStop || vpos === FRAME_LINES[this.standard] - 1) this.verticalWindow = false;
    else if (vpos === this.verticalStart) this.verticalWindow = true;
    this.updateSprites();
    this.ddf.startLine(this.verticalWindow);
    this.ddf.setLineStart((this.dmacon & (Dma.DMAEN | Dma.BPLEN)) === (Dma.DMAEN | Dma.BPLEN), this.bplcon0);
    this.buildSlots();
    this.host.onLine(vpos);
    if (vpos === 0) {
      this.copper.verticalBlank(this.dmaOn && (this.dmacon & Dma.COPEN) !== 0);
      this.host.onFrame();
    }
  }

  private updateSprites(): void {
    const vpos = this.vpos;
    if (vpos < SPRITE_START_LINE) return;
    for (let n = 0; n < 8; n++) {
      if (vpos === SPRITE_START_LINE) {
        this.spriteState[n] = SpriteState.Control;
        continue;
      }
      if (this.spriteState[n] === SpriteState.Waiting && vpos === this.spriteStart[n]) this.spriteState[n] = SpriteState.Data;
      if (this.spriteState[n] === SpriteState.Data && vpos === this.spriteStop[n]) this.spriteState[n] = SpriteState.Control;
    }
  }

  /**
   * Works out which DMA uses each memory cycle of the line. Disk and sprite DMA keep their cycles
   * before `from` (a change of DMACON takes effect a little after it is made).
   */
  private buildSlots(from = 0): void {
    const slots = this.slots;
    if (from > 0) this.previousSlots.set(slots);
    slots.fill(SLOT_FREE);
    slots[0x01] = slots[0x03] = slots[0x05] = slots[REFRESH_END] = SLOT_REFRESH;
    if (!this.dmaOn) {
      this.ddf.compute(this.fetches);
      this.keepEarlierSlots(from);
      return;
    }
    if (this.host.diskDma) slots[0x07] = slots[0x09] = slots[0x0b] = SLOT_DISK;
    for (let channel = 0; channel < 4; channel++) if (this.host.audioDma(channel)) slots[0x0d + channel * 2] = SLOT_AUDIO;
    if (this.dmacon & Dma.SPREN) {
      for (let n = 0; n < 8; n++) {
        const state = this.spriteState[n];
        if (state !== SpriteState.Control && state !== SpriteState.Data) continue;
        slots[0x15 + n * 4] = SLOT_SPRITE + n;
        slots[0x17 + n * 4] = SLOT_SPRITE_SECOND + n;
      }
    }
    this.ddf.compute(this.fetches);
    const fetches = this.fetches;
    // Bitplanes take the sprites' cycles when they start early; refresh keeps its cycle at $E2.
    for (let cycle = 0; cycle < REFRESH_END; cycle++) {
      const fetch = fetches[cycle];
      if (fetch) slots[cycle] = SLOT_BITPLANE + ((fetch & 0x0f) - 1) + (fetch & FETCH_MODULO ? SLOT_MODULO : 0);
    }
    this.keepEarlierSlots(from);
  }

  /** Puts back the disk and sprite cycles before `from` as they were. */
  private keepEarlierSlots(from: number): void {
    const { slots, previousSlots } = this;
    const das = (slot: number) => slot === SLOT_DISK || (slot >= SLOT_SPRITE && slot < SLOT_BITPLANE);
    for (let cycle = 0; cycle < from && cycle < slots.length; cycle++) {
      if (das(previousSlots[cycle]) || das(slots[cycle])) slots[cycle] = previousSlots[cycle];
    }
  }

  /** The Copper may have the bus if nothing else has it and Copper DMA is on, except in cycle $E0. */
  private copperBusFree(): boolean {
    if (this.busOwner !== Bus.Free || !this.dmaOn || !(this.dmacon & Dma.COPEN)) return false;
    if (this.hpos === COPPER_BLOCKED_CYCLE + (this.lol ? 1 : 0)) {
      this.busOwner = Bus.Blocked;
      return false;
    }
    return true;
  }

  /**
   * The CPU wants the chip bus in the current cycle. The cycle's DMA, the Copper and the blitter
   * go first; the CPU waits until a cycle is left free. After two cycles of waiting the blitter
   * lets it have the next (unless BLTPRI). Returns the cycles waited.
   */
  cpuAccess(): number {
    this.processCycle();
    let waited = 0;
    while (this.busOwner !== Bus.Free) {
      this.finishCycle();
      this.processCycle();
      if (++waited === 2) this.cpuWaiting = true;
    }
    this.cpuWaiting = false;
    this.busOwner = Bus.Cpu;
    return waited;
  }

  /** Runs the chips up to colour clock `target`. */
  runTo(target: number): void {
    while (this.clock < target) this.step();
  }

  /** One colour clock: this cycle's DMA, then the beam moving on. */
  step(): void {
    this.processCycle();
    this.finishCycle();
  }

  /** Works out the current cycle's DMA: the fixed slots, then the Copper, then the blitter. */
  private processCycle(): void {
    if (this.cycleProcessed) return;
    this.cycleProcessed = true;
    if (this.pendingWrites.length) this.applyPendingWrites();
    const h = this.hpos;
    const owner = this.slots[h];
    this.busOwner = owner === SLOT_FREE ? Bus.Free : Bus.Dma;
    if (owner >= SLOT_BITPLANE) {
      const plane = owner & 7;
      const words = this.fetchWords;
      let pointer = this.bplpt[plane];
      // A wide fetch reads its words at the pointer with the word's address bits set (so a pointer
      // off the fetch's alignment repeats words); FMODE 2 reads one word twice.
      const fm = this.aga ? this.fmode & 3 : 0;
      for (let w = 0; w < words; w++) this.denise.bplDat[plane * 4 + w] = this.chip.read16(fm === 2 ? pointer : pointer | (w * 2));
      pointer += words * 2;
      if (owner & SLOT_MODULO) pointer += this.bitplaneModulo(plane);
      this.bplpt[plane] = pointer & POINTER_MASK;
      if (plane === 0) this.denise.drawWord(h, words);
    } else if (owner >= SLOT_SPRITE) {
      this.spriteFetch(owner);
    }
    // A blit started by the Copper in this cycle takes its first step in the next.
    const blitting = this.blitter.active;
    this.copper.step();
    if (blitting) this.blitter.step(this.blitterBus);
  }

  /** Applies the register writes due in this cycle, in the order they were made. */
  private applyPendingWrites(): void {
    const pending = this.pendingWrites;
    const kept: number[] = [];
    const due: number[] = [];
    for (let i = 0; i < pending.length; i += 4) (pending[i] <= this.clock ? due : kept).push(pending[i], pending[i + 1], pending[i + 2], pending[i + 3]);
    this.pendingWrites = kept;
    for (let i = 0; i < due.length; i += 4) this.host.applyDelayedWrite(due[i + 1], due[i + 2], due[i + 3]);
  }

  /** The end of the current cycle: Denise's line start, the chips that count cycles, and the beam. */
  private finishCycle(): void {
    const h = this.hpos;
    if (h === DENISE_LINE_START) {
      this.denise.finishLine((this.previousLineLength + DENISE_LINE_START) * 4);
      if (this.vpos === 0) this.denise.verticalSync();
      this.denise.startLine(this.vpos - FIRST_PICTURE_LINE, this.lof);
    }
    this.host.tick();
    this.cycleProcessed = false;
    this.clock++;
    if (++this.hpos >= this.lineLength) this.endLine();
  }

  private spriteFetch(owner: number): void {
    const second = owner >= SLOT_SPRITE_SECOND;
    const n = owner & 7;
    // AGA's SSCAN2 doubles the lines of the sprites with SPRxPOS bit 7 set: every second line,
    // counted from the sprite's top, fetches nothing and Denise shows the last line again.
    const scanDoubled = this.fmode & FMODE_SSCAN2 && this.denise.sprPos[n] & 0x80;
    if (scanDoubled && this.spriteState[n] !== SpriteState.Control && (this.vpos & 1) !== (this.spriteStart[n] & 1)) return;
    const pointer = this.sprpt[n];
    const word = this.chip.read16(pointer);
    // AGA's FMODE bits 2-3 widen sprite fetches as bits 0-1 do bitplane ones (see the bitplane fetch).
    const fm = this.aga ? (this.fmode >> 2) & 3 : 0;
    const words = fm === 0 ? 1 : fm === 3 ? 4 : 2;
    this.sprpt[n] = (pointer + words * 2) & POINTER_MASK;
    const rest = this.spriteRest;
    rest.length = words - 1;
    for (let w = 1; w < words; w++) rest[w - 1] = fm === 2 ? word : this.chip.read16(pointer | (w * 2));
    const denise = this.denise;
    if (this.spriteState[n] === SpriteState.Control) {
      if (!second) {
        denise.writeSprPos(n, word);
        return;
      }
      denise.writeSprCtl(n, word);
      this.noteSpritePosition(n, denise.sprPos[n], word);
      this.spriteState[n] = this.spriteStart[n] === 0 && this.spriteStop[n] === 0 ? SpriteState.Idle : SpriteState.Waiting;
    } else if (second) {
      denise.writeSprDataB(n, word, rest);
    } else {
      denise.writeSprDataA(n, word, rest);
    }
  }

  private endLine(): void {
    this.previousLineLength = this.lineLength;
    this.hpos = 0;
    if (this.standard === 'ntsc') {
      this.lol = !this.lol;
      this.lineLength = LINE_CCKS + (this.lol ? 1 : 0);
    } else {
      this.lineLength = LINE_CCKS;
    }
    if (++this.vpos >= this.frameLines) {
      this.vpos = 0;
      this.frames++;
      this.lof = this.denise.interlaced ? !this.lof : true;
    }
    this.startLine();
  }

  setStandard(standard: VideoStandard): void {
    this.standard = standard;
    this.denise.outputLines = PICTURE_LINES[standard];
  }
}
