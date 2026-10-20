import type { FloppyDisk } from './adf';
import { MAX_TRACKS } from './adf';

const MAX_CYLINDER = MAX_TRACKS / 2 - 1;

/**
 * A 3.5" double-density drive: the motor, the head stepping between
 * cylinders, the two heads, the disk-change latch (set while no disk is in,
 * cleared by a step with one in) and the disk turning under the head.
 */
export class FloppyDrive {
  disk: FloppyDisk | null = null;
  cylinder = 0;
  /** 0 for the lower head, 1 for the upper. */
  side = 0;
  motor = false;
  selected = false;
  /** The disk-change latch (/CHNG active). */
  changed = true;
  /** The word under the head. */
  position = 0;
  /** Set while the drive's motor turns and its head reads or writes (for the activity light). */
  busy = false;

  constructor(public connected: boolean) {}

  get trackIndex(): number {
    return this.cylinder * 2 + this.side;
  }

  insert(disk: FloppyDisk): void {
    this.disk = disk;
    this.changed = true;
  }

  eject(): void {
    this.disk = null;
    this.changed = true;
  }

  step(outward: boolean): void {
    this.cylinder = Math.max(0, Math.min(MAX_CYLINDER, this.cylinder + (outward ? -1 : 1)));
    if (this.disk) this.changed = false;
  }

  /** The track under the head (null without a disk). */
  get track(): Uint16Array | null {
    return this.disk ? this.disk.track(this.trackIndex) : null;
  }

  /** Moves the disk on by a word; returns true when the index hole passes (once a revolution). */
  turn(): boolean {
    if (!this.motor || !this.disk) return false;
    const length = this.disk.track(this.trackIndex).length;
    if (++this.position < length) return false;
    this.position = 0;
    return true;
  }
}
