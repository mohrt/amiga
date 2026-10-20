import { Amiga } from './amiga';
import type { Screen } from './render/screen';

/** Longest gap we catch up on, so a backgrounded tab doesn't run a burst of frames. */
const MAX_CATCH_UP_MS = 100;
/** While warping, each animation frame emulates for this long. */
const WARP_BUDGET_MS = 12;

/** Glues the Amiga to the screen and the speakers, and runs it in step with real time. */
export class Emulator {
  readonly amiga = new Amiga();
  /** Run flat out while a disk is being read (its motor is on). */
  warpWhileLoading = true;
  private clockDebt = 0;
  private warping = false;

  constructor(screen: Screen) {
    this.amiga.onFrame = (framebuffer, rows) => screen.capture(framebuffer, rows);
  }

  /**
   * A disk is being read or written: a drive's motor is on and disk DMA has just been moving
   * words. Many games leave the motor on once they have taken over the machine, so the motor
   * alone doesn't say a disk is being read.
   */
  get loading(): boolean {
    const { amiga } = this;
    return amiga.paula.floppy.recentlyActive && amiga.drives.some((drive) => drive.motor && drive.disk !== null);
  }

  get warped(): boolean {
    return this.warping;
  }

  /** Forgets time owed, e.g. after a pause, so the machine doesn't race to catch up. */
  resetTiming(): void {
    this.clockDebt = 0;
  }

  /** Runs the Amiga for `elapsedMs` of real time, or as much as fits in a frame while warping. */
  run(elapsedMs: number): void {
    const amiga = this.amiga;
    this.warping = this.warpWhileLoading && this.loading;
    if (this.warping) {
      const stopAt = performance.now() + WARP_BUDGET_MS;
      while (performance.now() < stopAt && this.loading) amiga.runFrame();
      this.clockDebt = 0;
      return;
    }
    this.clockDebt += (Math.min(elapsedMs, MAX_CATCH_UP_MS) * amiga.clockHz) / 1000;
    const start = amiga.agnus.clock;
    amiga.run(Math.floor(this.clockDebt));
    this.clockDebt -= amiga.agnus.clock - start;
  }

  takeAudioSamples(): Float32Array {
    return this.amiga.paula.audio.takeSamples();
  }
}
