import type { FloppyDrive } from '../drive/floppy';
import type { ChipRam } from '../memory/chip-ram';
import { INTERRUPT_LEVELS, Int, setClear } from '../custom/registers';
import { PaulaAudio } from './audio';
import { DiskController } from './disk';

const ADKCON_WORDSYNC = 0x0400;

export interface PaulaHost {
  /** Whether DMA is on for audio channel n (DMAEN and AUDnEN). */
  audioDma(channel: number): boolean;
  /** Whether disk DMA is on (DMAEN and DSKEN). */
  readonly diskDma: boolean;
  /** The disk index pulse, to CIA-B's FLAG input. */
  indexPulse(): void;
  /** The INTREQ bits whose interrupt lines are held active from outside (the CIAs' IRQ outputs). */
  heldInterrupts(): number;
}

/**
 * The Paula chip: the interrupt controller (INTENA and INTREQ, turned into
 * the CPU's six interrupt levels), the four sound channels, the disk
 * controller and ADKCON. The serial port only reports an empty transmitter.
 */
export class Paula {
  intena = 0;
  intreq = 0;
  adkcon = 0;
  /** The interrupt level Paula puts out to the CPU (which sees it a few cycles later). */
  level = 0;
  /** INTENA and INTREQ writes and some requests take effect in the next cycle: values to apply then, or -1. */
  private pendingIntena = -1;
  private pendingIntreq = -1;
  private pendingRequests = 0;
  readonly audio: PaulaAudio;
  readonly floppy: DiskController;

  constructor(
    chip: ChipRam,
    drives: FloppyDrive[],
    private readonly host: PaulaHost,
  ) {
    this.audio = new PaulaAudio(chip, (channel) => this.raiseNextCycle(Int.AUD0 << channel), (channel) => host.audioDma(channel));
    const paula = this;
    this.floppy = new DiskController(chip, drives, {
      raise: (bits) => paula.raise(bits),
      get dmaEnabled() {
        return host.diskDma;
      },
      get wordSync() {
        return (paula.adkcon & ADKCON_WORDSYNC) !== 0;
      },
      indexPulse: () => host.indexPulse(),
    });
  }

  reset(): void {
    this.intena = this.intreq = this.adkcon = 0;
    this.pendingIntena = this.pendingIntreq = -1;
    this.pendingRequests = 0;
    this.audio.reset();
    this.floppy.reset();
    this.update();
  }

  /** INTENA takes the write in the next cycle. */
  writeIntena(value: number): void {
    this.applyPending();
    this.pendingIntena = value;
  }

  /** INTREQ takes the write in the next cycle. */
  writeIntreq(value: number): void {
    this.applyPending();
    this.pendingIntreq = value;
  }

  /** A request that reaches INTREQ in the next cycle (the blitter's). */
  raiseNextCycle(bits: number): void {
    this.pendingRequests |= bits;
  }

  /** The end of a cycle: the writes and requests made in it take effect. */
  applyPending(): void {
    if (this.pendingIntena >= 0) {
      this.intena = setClear(this.intena, this.pendingIntena);
      this.pendingIntena = -1;
      this.update();
    }
    if (this.pendingIntreq >= 0) {
      // INT2 (PORTS) and INT6 (EXTER) are level inputs: their requests can't be cleared while a CIA still holds its IRQ line active.
      this.intreq = setClear(this.intreq, this.pendingIntreq) | this.host.heldInterrupts();
      this.pendingIntreq = -1;
      this.update();
    }
    if (this.pendingRequests) {
      const bits = this.pendingRequests;
      this.pendingRequests = 0;
      this.raise(bits);
    }
  }

  writeAdkcon(value: number): void {
    this.adkcon = setClear(this.adkcon, value);
    this.audio.setModulation(this.adkcon);
  }

  raise(bits: number): void {
    if ((this.intreq & bits) === bits) return;
    this.intreq |= bits;
    this.update();
  }

  /** Sending a serial byte: there is nothing on the port, so it goes at once. */
  writeSerial(): void {
    this.raise(Int.TBE);
  }

  private update(): void {
    let level = 0;
    if (this.intena & Int.INTEN) {
      const active = this.intreq & this.intena & 0x3fff;
      for (let bit = 13; bit >= 0; bit--) {
        if (active & (1 << bit)) {
          level = INTERRUPT_LEVELS[bit];
          break;
        }
      }
    }
    this.level = level;
  }
}
