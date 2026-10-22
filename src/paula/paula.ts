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
  /** The CPU's interrupt level changed. */
  setInterruptLevel(level: number): void;
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
  readonly audio: PaulaAudio;
  readonly floppy: DiskController;

  constructor(
    chip: ChipRam,
    drives: FloppyDrive[],
    private readonly host: PaulaHost,
  ) {
    this.audio = new PaulaAudio(chip, (channel) => this.raise(Int.AUD0 << channel), (channel) => host.audioDma(channel));
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
    this.audio.reset();
    this.floppy.reset();
    this.update();
  }

  writeIntena(value: number): void {
    this.intena = setClear(this.intena, value);
    this.update();
  }

  /** INT2 (PORTS) and INT6 (EXTER) are level inputs: their requests can't be cleared while a CIA still holds its IRQ line active. */
  writeIntreq(value: number): void {
    this.intreq = setClear(this.intreq, value) | this.host.heldInterrupts();
    this.update();
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
    this.host.setInterruptLevel(level);
  }
}
