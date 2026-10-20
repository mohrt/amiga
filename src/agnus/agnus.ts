import type { Denise } from '../denise/denise';
import type { ChipRam } from '../memory/chip-ram';
import { Dma, Reg } from '../custom/registers';
import { Blitter } from './blitter';
import { Copper } from './copper';

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
const SLOT_SPRITE_SECOND = 0x18;
const SLOT_BITPLANE = 0x20;

/** Planes (0-5) in the eight cycles of a lores fetch unit; plane 1 (0 here) comes last. */
const LORES_ORDER = [-1, 3, 5, 1, -1, 2, 4, 0];
const HIRES_ORDER = [3, 1, 2, 0];

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
  ddfstrt = 0;
  ddfstop = 0;
  readonly bplpt = new Uint32Array(6);
  bpl1mod = 0;
  bpl2mod = 0;
  readonly sprpt = new Uint32Array(8);
  private readonly spriteState = new Uint8Array(8);
  private readonly spriteStart = new Uint16Array(8);
  private readonly spriteStop = new Uint16Array(8);
  readonly copper: Copper;
  readonly blitter: Blitter;
  /** The owner of each memory cycle of the current line. */
  private readonly slots = new Uint8Array(232);
  private lastBitplaneSlot = -1;
  private modulosAdded = false;
  /** Whether this line is inside the display window's height (bitplane DMA and display on). */
  verticalWindow = false;
  /** The memory cycle the CPU has claimed (the copper and blitter don't get it). */
  cpuSlot = -1;
  /** How many cycles in a row the CPU has waited for the bus (the blitter lets it in after three, unless BLTPRI). */
  cpuWaits = 0;

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
      get blitterBusy() {
        return agnus.blitter.busy;
      },
    });
    this.blitter = new Blitter(chip);
    denise.beamX = () => (this.hpos >= DENISE_LINE_START ? this.hpos : this.hpos + this.previousLineLength) * 4 + 2;
  }

  get frameLines(): number {
    return FRAME_LINES[this.standard] - (this.lof ? 0 : 1);
  }

  reset(): void {
    this.hpos = this.vpos = 0;
    this.lof = true;
    this.dmacon = 0;
    this.diwstrt = this.diwstop = this.ddfstrt = this.ddfstop = 0;
    this.bplpt.fill(0);
    this.bpl1mod = this.bpl2mod = 0;
    this.sprpt.fill(0);
    this.spriteState.fill(SpriteState.Idle);
    this.copper.reset();
    this.blitter.reset();
    this.cpuSlot = -1;
    this.denise.outputLines = PICTURE_LINES[this.standard];
    this.startLine();
    this.denise.startLine(this.vpos - FIRST_PICTURE_LINE, this.verticalWindow, this.lof);
  }

  private get dmaOn(): boolean {
    return (this.dmacon & Dma.DMAEN) !== 0;
  }

  get vposr(): number {
    const id = this.standard === 'ntsc' ? 0x10 : 0x00;
    return (this.lof ? 0x8000 : 0) | (id << 8) | ((this.vpos >> 8) & 1);
  }

  get vhposr(): number {
    return ((this.vpos & 0xff) << 8) | (this.hpos & 0xff);
  }

  writeVposw(value: number): void {
    this.lof = (value & 0x8000) !== 0;
  }

  get dmaconr(): number {
    return (this.dmacon & 0x07ff) | (this.blitter.busy ? Dma.BBUSY : 0) | (this.blitter.zero ? Dma.BZERO : 0);
  }

  writeDmacon(value: number): void {
    this.dmacon = (value & 0x8000 ? this.dmacon | value : this.dmacon & ~value) & 0x07ff;
    this.buildSlots();
  }

  /** The registers Agnus keeps: display window and fetch, pointers and modulos, the Copper's and the blitter's. */
  writeRegister(reg: number, value: number): void {
    if (reg >= Reg.BPL1PT && reg <= Reg.BPL6PT_END) {
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
        this.denise.writeDiw(this.diwstrt, this.diwstop);
        break;
      case Reg.DIWSTOP:
        this.diwstop = value;
        this.denise.writeDiw(this.diwstrt, this.diwstop);
        break;
      case Reg.DDFSTRT:
        this.ddfstrt = value & 0xfc;
        this.buildSlots();
        break;
      case Reg.DDFSTOP:
        this.ddfstop = value & 0xfc;
        this.buildSlots();
        break;
      case Reg.BPL1MOD:
        this.bpl1mod = signed16(value & 0xfffe);
        break;
      case Reg.BPL2MOD:
        this.bpl2mod = signed16(value & 0xfffe);
        break;
      case Reg.COP1LCH:
        this.copper.cop1lc = ((value << 16) | (this.copper.cop1lc & 0xffff)) & POINTER_MASK;
        break;
      case Reg.COP1LCL:
        this.copper.cop1lc = ((this.copper.cop1lc & 0xffff0000) | value) & POINTER_MASK;
        break;
      case Reg.COP2LCH:
        this.copper.cop2lc = ((value << 16) | (this.copper.cop2lc & 0xffff)) & POINTER_MASK;
        break;
      case Reg.COP2LCL:
        this.copper.cop2lc = ((this.copper.cop2lc & 0xffff0000) | value) & POINTER_MASK;
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

  private startLine(): void {
    const vpos = this.vpos;
    const vStart = this.diwstrt >> 8;
    const vStop = (this.diwstop >> 8) | (this.diwstop & 0x8000 ? 0 : 0x100);
    this.verticalWindow = vpos >= vStart && vpos < vStop;
    this.updateSprites();
    this.modulosAdded = false;
    this.buildSlots();
    this.host.onLine(vpos);
    if (vpos === 0) {
      this.copper.jump(1);
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

  /** Works out which DMA uses each memory cycle of the line. */
  private buildSlots(): void {
    const slots = this.slots;
    slots.fill(SLOT_FREE);
    slots[0x01] = slots[0x03] = slots[0x05] = slots[0xe2] = SLOT_REFRESH;
    this.lastBitplaneSlot = -1;
    if (!this.dmaOn) return;
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
    const planes = Math.min(6, (this.denise.bplcon0 >> 12) & 7);
    if (!(this.dmacon & Dma.BPLEN) || !this.verticalWindow || planes === 0) return;
    const hires = (this.denise.bplcon0 & 0x8000) !== 0;
    const start = Math.max(0x18, this.ddfstrt);
    let stop = Math.min(0xd8, this.ddfstop);
    if (stop < start) stop = 0xd8;
    // Fetching goes in blocks of 8 cycles from DDFSTRT (two passes over the planes in hires),
    // and ends with the block after the first one to reach DDFSTOP.
    const blocks = Math.ceil((stop - start) / 8) + 1;
    for (let block = 0; block < blocks; block++) {
      for (let offset = 0; offset < 8; offset++) {
        const plane = hires ? HIRES_ORDER[offset & 3] : LORES_ORDER[offset];
        const slot = start + block * 8 + offset;
        if (plane < 0 || plane >= planes || slot >= 0xe2) continue;
        slots[slot] = SLOT_BITPLANE + plane;
        this.lastBitplaneSlot = slot;
      }
    }
  }

  /** Whether the CPU has to wait for the chip bus this cycle. */
  cpuBlocked(): boolean {
    if (this.slots[this.hpos] !== SLOT_FREE) return true;
    if (!this.dmaOn) return false;
    if (!(this.hpos & 1) && this.dmacon & Dma.COPEN && this.copper.wantsCycle) return true;
    if (this.blitter.busy && this.dmacon & Dma.BLTEN) return this.dmacon & Dma.BLTPRI ? true : this.cpuWaits < 3;
    return false;
  }

  /** Runs the chips up to colour clock `target`. */
  runTo(target: number): void {
    while (this.clock < target) this.step();
  }

  /** One colour clock: this cycle's DMA, the Copper's wait, and the beam moving on. */
  step(): void {
    const h = this.hpos;
    const owner = this.slots[h];
    if (owner >= SLOT_BITPLANE) {
      const plane = owner - SLOT_BITPLANE;
      this.denise.bplDat[plane] = this.chip.read16(this.bplpt[plane]);
      this.bplpt[plane] = (this.bplpt[plane] + 2) & POINTER_MASK;
      if (plane === 0) this.denise.drawWord(h);
    } else if (owner >= SLOT_SPRITE) {
      this.spriteFetch(owner);
    } else if (owner === SLOT_FREE && this.dmaOn && this.cpuSlot !== this.clock) {
      if (!(h & 1) && this.dmacon & Dma.COPEN && this.copper.wantsCycle) this.copper.cycle();
      else if (this.blitter.busy && this.dmacon & Dma.BLTEN) this.blitter.cycle();
    }
    if (h === this.lastBitplaneSlot && !this.modulosAdded) this.addModulos();
    if (h === DENISE_LINE_START) {
      this.denise.finishLine((this.previousLineLength + DENISE_LINE_START) * 4);
      this.denise.startLine(this.vpos - FIRST_PICTURE_LINE, this.verticalWindow, this.lof);
    }
    if (this.copper.waiting && !(h & 1)) this.copper.checkWait();
    this.host.tick();

    this.clock++;
    if (++this.hpos >= this.lineLength) this.endLine();
  }

  private spriteFetch(owner: number): void {
    const second = owner >= SLOT_SPRITE_SECOND;
    const n = owner & 7;
    const word = this.chip.read16(this.sprpt[n]);
    this.sprpt[n] = (this.sprpt[n] + 2) & POINTER_MASK;
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
      denise.writeSprDataB(n, word);
    } else {
      denise.writeSprDataA(n, word);
    }
  }

  private addModulos(): void {
    this.modulosAdded = true;
    const planes = Math.min(6, (this.denise.bplcon0 >> 12) & 7);
    for (let p = 0; p < planes; p++) this.bplpt[p] = (this.bplpt[p] + (p & 1 ? this.bpl2mod : this.bpl1mod)) & POINTER_MASK;
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
