import type { FloppyDrive } from '../drive/floppy';
import type { ChipRam } from '../memory/chip-ram';
import { Int } from '../custom/registers';

/** A word of MFM passes the head every 32 µs: 113.5 colour clocks, counted here in halves. */
const WORD_HALF_CCKS = 227;
const HALF_WORD = WORD_HALF_CCKS >> 1;
/**
 * Disk DMA counts as recent for half a second (in words passing the head) after its last
 * transfer, which covers the head stepping between tracks.
 */
const RECENT_WORDS = 15625;

const enum Mode {
  Off,
  /** Waiting for DSKSYNC before transferring (ADKCON's WORDSYNC). */
  WaitSync,
  Read,
  Write,
}

const PRB_STEP = 0x01;
const PRB_DIR = 0x02;
const PRB_SIDE = 0x04;
const PRB_SEL0 = 0x08;
const PRB_MOTOR = 0x80;

const PRA_CHANGE = 0x04;
const PRA_PROTECT = 0x08;
const PRA_TRACK0 = 0x10;
const PRA_READY = 0x20;

export interface DiskHost {
  raise(bits: number): void;
  /** DMACON's DMAEN and DSKEN. */
  readonly dmaEnabled: boolean;
  /** ADKCON's WORDSYNC. */
  readonly wordSync: boolean;
  /** The index pulse, to CIA-B's FLAG input. */
  indexPulse(): void;
}

/**
 * Paula's disk controller and the drive control lines: DMA between chip RAM
 * and the selected drive (waiting for the sync word if asked), the DSKSYN
 * and DSKBLK interrupts, DSKBYTR, and the select, motor, step, direction and
 * side lines from CIA-B with the change, protect, track 0 and ready lines
 * back to CIA-A.
 */
export class DiskController {
  dskpt = 0;
  dsklen = 0;
  sync = 0x4489;
  private armed = false;
  /** Words that have passed the head, and the count at the last DMA transfer. */
  private wordTicks = 0;
  private lastTransferTick = -RECENT_WORDS;
  private mode = Mode.Off;
  private remaining = 0;
  private wordTimer = WORD_HALF_CCKS;
  private lastWord = 0;
  private byteReady = false;
  private wordEqual = 0;
  private prb = 0xff;

  constructor(
    private readonly chip: ChipRam,
    readonly drives: FloppyDrive[],
    private readonly host: DiskHost,
  ) {}

  reset(): void {
    this.dskpt = this.dsklen = 0;
    this.armed = false;
    this.mode = Mode.Off;
    this.sync = 0x4489;
    this.prb = 0xff;
    for (const drive of this.drives) {
      drive.motor = false;
      drive.selected = false;
    }
  }

  get dmaActive(): boolean {
    return this.mode !== Mode.Off;
  }

  /** A disk is being read or written: DMA is on, or moved a word within the last half second. */
  get recentlyActive(): boolean {
    return this.mode !== Mode.Off || this.wordTicks - this.lastTransferTick < RECENT_WORDS;
  }

  writePointerHigh(value: number): void {
    this.dskpt = ((value << 16) | (this.dskpt & 0xffff)) & 0x1ffffe;
  }

  writePointerLow(value: number): void {
    this.dskpt = ((this.dskpt & 0xffff0000) | value) & 0x1ffffe;
  }

  /** DSKLEN: DMA starts on the second write in a row with bit 15 set; a write without it stops DMA. */
  writeLength(value: number): void {
    if (!(value & 0x8000)) {
      this.mode = Mode.Off;
      this.armed = false;
    } else if (this.armed) {
      this.armed = false;
      this.remaining = value & 0x3fff;
      this.mode = value & 0x4000 ? Mode.Write : this.host.wordSync ? Mode.WaitSync : Mode.Read;
      if (this.remaining === 0) this.finish();
    } else {
      this.armed = true;
    }
    this.dsklen = value;
  }

  readBytes(): number {
    const byte = this.wordTimer > HALF_WORD ? this.lastWord >> 8 : this.lastWord & 0xff;
    const value =
      (this.byteReady ? 0x8000 : 0) |
      (this.mode !== Mode.Off ? 0x4000 : 0) |
      (this.mode === Mode.Write ? 0x2000 : 0) |
      (this.wordEqual > 0 ? 0x1000 : 0) |
      byte;
    this.byteReady = false;
    return value;
  }

  /** The drive whose head is read or written: selected, motor running, a disk in. */
  private get activeDrive(): FloppyDrive | null {
    for (const drive of this.drives) if (drive.selected && drive.motor && drive.disk) return drive;
    return null;
  }

  /** CIA-B port B changed: drive select (latching the motor line), step, direction and side. */
  writeControl(value: number): void {
    const previous = this.prb;
    this.prb = value;
    const stepped = previous & PRB_STEP && !(value & PRB_STEP);
    const side = value & PRB_SIDE ? 0 : 1;
    this.drives.forEach((drive, i) => {
      if (!drive.connected) return;
      const bit = PRB_SEL0 << i;
      const selected = !(value & bit);
      if (selected && previous & bit) drive.motor = !(value & PRB_MOTOR);
      drive.selected = selected;
      drive.side = side;
      if (selected && stepped) drive.step((value & PRB_DIR) !== 0);
    });
  }

  /** The drive status lines for CIA-A port A (active low), from the selected drives. */
  readStatus(): number {
    let lines = PRA_CHANGE | PRA_PROTECT | PRA_TRACK0 | PRA_READY;
    for (const drive of this.drives) {
      if (!drive.connected || !drive.selected) continue;
      if (drive.changed) lines &= ~PRA_CHANGE;
      if (drive.disk?.writeProtected) lines &= ~PRA_PROTECT;
      if (drive.cylinder === 0) lines &= ~PRA_TRACK0;
      // A double-density drive reports its ID (all ones) on this line while the motor is off.
      lines &= ~PRA_READY;
    }
    return lines;
  }

  /** One colour clock: the disks turn, and a word passes the head every 113.5 of them. */
  tick(): void {
    this.wordTimer -= 2;
    if (this.wordTimer === HALF_WORD || this.wordTimer === HALF_WORD - 1) this.byteReady = true;
    if (this.wordTimer > 0) return;
    this.wordTimer += WORD_HALF_CCKS;
    this.word();
  }

  private word(): void {
    this.wordTicks++;
    if (this.wordEqual > 0) this.wordEqual--;
    const drive = this.activeDrive;
    const track = drive?.track ?? null;
    const at = drive && track ? drive.position % track.length : 0;
    for (const each of this.drives) {
      each.busy = false;
      if (each.turn() && each.selected) this.host.indexPulse();
    }
    if (!drive || !track) return;
    drive.busy = this.mode !== Mode.Off;

    if (this.mode === Mode.Write) {
      if (!this.host.dmaEnabled) return;
      track[at] = this.chip.read16(this.dskpt);
      drive.disk!.markWritten(drive.trackIndex);
      this.transferred();
      return;
    }

    const word = track[at];
    this.lastWord = word;
    this.byteReady = true;
    if (word === this.sync) {
      this.wordEqual = 2;
      this.host.raise(Int.DSKSYN);
      if (this.mode === Mode.WaitSync) {
        if (this.host.dmaEnabled) this.mode = Mode.Read;
        return;
      }
    }
    if (this.mode === Mode.Read && this.host.dmaEnabled) {
      this.chip.write16(this.dskpt, word);
      this.transferred();
    }
  }

  private transferred(): void {
    this.lastTransferTick = this.wordTicks;
    this.dskpt = (this.dskpt + 2) & 0x1ffffe;
    if (--this.remaining <= 0) this.finish();
  }

  private finish(): void {
    this.mode = Mode.Off;
    this.host.raise(Int.DSKBLK);
  }
}
