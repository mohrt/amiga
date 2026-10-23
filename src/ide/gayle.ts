import { AtaDrive } from './ata';
import type { HardDiskImage } from './image';

/** Gayle's ID, $D0 on an A600 and $D1 on an A1200 (AA Gayle); Kickstart reads it a bit at a time from bit 7 of $DE1000. */
const GAYLE_ID = 0xd0;
const AA_GAYLE_ID = 0xd1;
const IDE_BASE = 0xda2000;
const IDE_END = 0xda3000;
/** The alternate status register when read, device control when written. */
const IDE_ALT_STATUS = 0xda3018;
const REG_STATUS = 0xda8000;
const REG_IRQ = 0xda9000;
const REG_INTENA = 0xdaa000;
const REG_CONFIG = 0xdab000;
/** The IDE bit in Gayle's status, interrupt-change and enable registers. */
const GAYLE_IDE = 0x80;

/**
 * The A600's Gayle chip, as far as its IDE port goes: the ID register
 * Kickstart looks for at $DE1000, the drive's registers at $DA2000, and the
 * status, interrupt-change, interrupt-enable and configuration registers at
 * $DA8000-$DAB000. The drive's interrupt reaches Paula as INT2 (PORTS). No
 * PCMCIA card is ever in.
 */
export class Gayle {
  readonly drive: AtaDrive;
  private idBit = 0;
  private irq = 0;
  private intena = 0;
  private config = 0;
  /** The A1200's AA Gayle rather than the A600's. */
  aga = false;

  constructor(
    image: HardDiskImage,
    /** Raises Paula's PORTS interrupt. */
    private readonly raisePorts: () => void,
  ) {
    this.drive = new AtaDrive(image);
    this.drive.onInterrupt = () => {
      this.irq |= GAYLE_IDE;
      if (this.intena & GAYLE_IDE) this.raisePorts();
    };
  }

  reset(): void {
    this.idBit = 0;
    this.irq = this.intena = this.config = 0;
    this.drive.reset();
  }

  tick(): void {
    this.drive.tick();
  }

  /** Whether an address belongs to Gayle. */
  static handles(address: number): boolean {
    return (address >= 0xda0000 && address < 0xdb0000) || (address >= 0xde1000 && address < 0xde2000);
  }

  read8(address: number): number {
    if (address >= 0xde1000 && address < 0xde2000) {
      const id = this.aga ? AA_GAYLE_ID : GAYLE_ID;
      const bit = this.idBit < 8 ? (id >> (7 - this.idBit)) & 1 : 0;
      this.idBit++;
      return bit << 7;
    }
    if (address >= IDE_BASE && address < IDE_END) return this.drive.readRegister((address - IDE_BASE) >> 2) & 0xff;
    if (address === IDE_ALT_STATUS) return this.drive.readAltStatus();
    switch (address & 0xfff000) {
      case REG_STATUS:
        return this.drive.interrupt ? GAYLE_IDE : 0;
      case REG_IRQ:
        return this.irq;
      case REG_INTENA:
        return this.intena;
      case REG_CONFIG:
        return this.config;
    }
    return 0;
  }

  read16(address: number): number {
    if (address === IDE_BASE) return this.drive.readRegister(0);
    return (this.read8(address) << 8) | 0xff;
  }

  write8(address: number, value: number): void {
    if (address >= 0xde1000 && address < 0xde2000) {
      this.idBit = 0;
      return;
    }
    if (address >= IDE_BASE && address < IDE_END) {
      this.drive.writeRegister((address - IDE_BASE) >> 2, value);
      return;
    }
    if (address === IDE_ALT_STATUS) {
      this.drive.writeDeviceControl(value);
      return;
    }
    switch (address & 0xfff000) {
      case REG_IRQ:
        // Writing zeros clears the change flags.
        this.irq &= value;
        break;
      case REG_INTENA:
        this.intena = value;
        break;
      case REG_CONFIG:
        this.config = value;
        break;
    }
  }

  write16(address: number, value: number): void {
    if (address === IDE_BASE) this.drive.writeRegister(0, value);
    else this.write8(address, value >> 8);
  }
}
