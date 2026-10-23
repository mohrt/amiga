import { AtaDrive } from './ata';
import type { HardDiskImage } from './image';

/** The drive's registers, a longword apart from $DD2020 (the data register first, the status/command last). */
const IDE_BASE = 0xdd2020;
const IDE_END = 0xdd2040;
/** The alternate status register when read, device control when written. */
const IDE_ALT_STATUS = 0xdd3038;
/** Bit 7 is set while the drive's interrupt is active. */
const IDE_INTERRUPT = 0xdd3020;
const PORT_START = 0xdd2000;
const PORT_END = 0xdd4000;

/**
 * The A4000's IDE port on its main board: the drive's registers laid out as on
 * the A600's Gayle, but from $DD2020, and an interrupt flag at $DD3020. There
 * is no ID register for Kickstart to find; the drive's interrupt reaches Paula
 * as INT2 (PORTS) directly.
 */
export class A4000Ide {
  readonly drive: AtaDrive;

  constructor(image: HardDiskImage, raisePorts: () => void) {
    this.drive = new AtaDrive(image);
    this.drive.onInterrupt = raisePorts;
  }

  reset(): void {
    this.drive.reset();
  }

  tick(): void {
    this.drive.tick();
  }

  handles(address: number): boolean {
    return A4000Ide.handles(address);
  }

  static handles(address: number): boolean {
    return address >= PORT_START && address < PORT_END;
  }

  /** What the port reads as with no drive on it: the status floats high, which Kickstart takes as no drive. */
  static readEmpty(address: number): number {
    return address === IDE_BASE + 7 * 4 + 2 || address === IDE_ALT_STATUS ? 0xff : 0;
  }

  read8(address: number): number {
    if (address >= IDE_BASE && address < IDE_END) return this.drive.readRegister((address - IDE_BASE) >> 2) & 0xff;
    if (address === IDE_ALT_STATUS) return this.drive.readAltStatus();
    if (address === IDE_INTERRUPT) return this.drive.interrupt ? 0x80 : 0;
    return 0;
  }

  read16(address: number): number {
    if (address === IDE_BASE) return this.drive.readRegister(0);
    return (this.read8(address) << 8) | 0xff;
  }

  write8(address: number, value: number): void {
    if (address >= IDE_BASE && address < IDE_END) this.drive.writeRegister((address - IDE_BASE) >> 2, value);
    else if (address === IDE_ALT_STATUS) this.drive.writeDeviceControl(value);
  }

  write16(address: number, value: number): void {
    if (address === IDE_BASE) this.drive.writeRegister(0, value);
    else this.write8(address, value >> 8);
  }
}
