import { SECTOR_BYTES, type HardDiskImage } from './image';

// Task file registers, by their number.
export const AtaReg = {
  DATA: 0,
  ERROR: 1, // FEATURE when written
  COUNT: 2,
  SECTOR: 3,
  CYL_LOW: 4,
  CYL_HIGH: 5,
  SELECT: 6,
  STATUS: 7, // COMMAND when written
} as const;

export const Status = {
  BSY: 0x80,
  DRDY: 0x40,
  DSC: 0x10,
  DRQ: 0x08,
  ERR: 0x01,
} as const;

const ERROR_ABORT = 0x04;
const ERROR_ID_NOT_FOUND = 0x10;
const SELECT_LBA = 0x40;
const SELECT_SLAVE = 0x10;
const DEVCTRL_NIEN = 0x02;
const DEVCTRL_SRST = 0x04;
const MAX_MULTIPLE = 16;
/** Commands finish this many lines (64 µs each) after they're given, so the driver is waiting when the interrupt comes. */
const COMMAND_LINES = 2;
/** The activity light stays on this long after the drive was used (in lines, about a fifth of a second). */
const ACTIVITY_LINES = 3000;

const enum Transfer {
  None,
  Read,
  Write,
}

/** Puts an ATA string (two characters per word, the first in the high byte) into words. */
function putString(words: Uint16Array, first: number, length: number, text: string): void {
  const padded = text.padEnd(length * 2, ' ');
  for (let i = 0; i < length; i++) words[first + i] = (padded.charCodeAt(i * 2) << 8) | padded.charCodeAt(i * 2 + 1);
}

/**
 * An IDE (ATA) hard drive, as the master on an A600's IDE port: the task file
 * registers, CHS and LBA addressing, reads and writes of one or several
 * sectors (with READ/WRITE MULTIPLE), IDENTIFY, and its interrupt line. Data
 * moves a word at a time through the data register; sector bytes arrive in the
 * order the disk image holds them, as UAE's hard disk images expect.
 */
export class AtaDrive {
  error = 1;
  feature = 0;
  count = 1;
  sector = 1;
  cylLow = 0;
  cylHigh = 0;
  select = 0xa0;
  status: number = Status.DRDY | Status.DSC;
  devctrl = 0;
  /** The interrupt line (INTRQ); cleared by reading the status register. */
  interrupt = false;
  /** Sectors per block for READ/WRITE MULTIPLE (0 until set). */
  multiple = 0;
  /** The geometry CHS addresses are translated with (INITIALIZE DEVICE PARAMETERS can change it). */
  logicalHeads: number;
  logicalSectors: number;
  /** Lines the activity light stays on. */
  activity = 0;
  private transfer = Transfer.None;
  /** Sectors left in the command, the next one's address, and the size of each block (one or MULTIPLE). */
  private remaining = 0;
  private lba = 0;
  private blockSectors = 1;
  private readonly buffer = new Uint8Array(SECTOR_BYTES * MAX_MULTIPLE);
  private bufferLength = 0;
  private bufferPos = 0;
  /** Lines until the pending step (a command's start, or the next block) happens. */
  private pending = 0;
  private pendingStep: (() => void) | null = null;
  /** Called when the interrupt line goes active. */
  onInterrupt: () => void = () => {};

  constructor(readonly image: HardDiskImage) {
    this.logicalHeads = image.geometry.heads;
    this.logicalSectors = image.geometry.sectors;
  }

  reset(): void {
    this.error = 1;
    this.count = this.sector = 1;
    this.cylLow = this.cylHigh = 0;
    this.select = 0xa0;
    this.status = Status.DRDY | Status.DSC;
    this.devctrl = 0;
    this.interrupt = false;
    this.multiple = 0;
    this.transfer = Transfer.None;
    this.pendingStep = null;
    this.logicalHeads = this.image.geometry.heads;
    this.logicalSectors = this.image.geometry.sectors;
  }

  private get slaveSelected(): boolean {
    return (this.select & SELECT_SLAVE) !== 0;
  }

  // --- Registers ---------------------------------------------------------------------

  readRegister(reg: number): number {
    // There is no slave drive: with it selected, the registers read as nothing.
    if (this.slaveSelected && reg !== AtaReg.DATA) return 0;
    switch (reg) {
      case AtaReg.DATA:
        return this.readData();
      case AtaReg.ERROR:
        return this.error;
      case AtaReg.COUNT:
        return this.count;
      case AtaReg.SECTOR:
        return this.sector;
      case AtaReg.CYL_LOW:
        return this.cylLow;
      case AtaReg.CYL_HIGH:
        return this.cylHigh;
      case AtaReg.SELECT:
        return this.select;
      default:
        this.interrupt = false;
        return this.status;
    }
  }

  /** The alternate status register: the status, without acknowledging the interrupt. */
  readAltStatus(): number {
    return this.slaveSelected ? 0 : this.status;
  }

  writeRegister(reg: number, value: number): void {
    value &= reg === AtaReg.DATA ? 0xffff : 0xff;
    switch (reg) {
      case AtaReg.DATA:
        this.writeData(value);
        break;
      case AtaReg.ERROR:
        this.feature = value;
        break;
      case AtaReg.COUNT:
        this.count = value;
        break;
      case AtaReg.SECTOR:
        this.sector = value;
        break;
      case AtaReg.CYL_LOW:
        this.cylLow = value;
        break;
      case AtaReg.CYL_HIGH:
        this.cylHigh = value;
        break;
      case AtaReg.SELECT:
        this.select = value | 0xa0;
        break;
      default:
        if (!this.slaveSelected) this.command(value);
    }
  }

  writeDeviceControl(value: number): void {
    const wasReset = (this.devctrl & DEVCTRL_SRST) !== 0;
    this.devctrl = value;
    if (value & DEVCTRL_SRST) {
      this.status = Status.BSY;
      this.transfer = Transfer.None;
      this.pendingStep = null;
    } else if (wasReset) {
      this.reset();
    }
  }

  /** Once a line: the pending step of a command, and the activity light. */
  tick(): void {
    if (this.activity > 0) this.activity--;
    if (!this.pendingStep || --this.pending > 0) return;
    const step = this.pendingStep;
    this.pendingStep = null;
    step();
  }

  private later(step: () => void): void {
    this.status = (this.status | Status.BSY) & ~Status.DRQ;
    this.pending = COMMAND_LINES;
    this.pendingStep = step;
    this.activity = ACTIVITY_LINES;
  }

  private raiseInterrupt(): void {
    if (this.devctrl & DEVCTRL_NIEN) return;
    this.interrupt = true;
    this.onInterrupt();
  }

  private finish(error = 0): void {
    this.transfer = Transfer.None;
    this.error = error;
    this.status = Status.DRDY | Status.DSC | (error ? Status.ERR : 0);
    this.raiseInterrupt();
  }

  // --- Addresses -----------------------------------------------------------------------

  private currentLba(): number {
    if (this.select & SELECT_LBA) return ((this.select & 0x0f) << 24) | (this.cylHigh << 16) | (this.cylLow << 8) | this.sector;
    const cylinder = (this.cylHigh << 8) | this.cylLow;
    const head = this.select & 0x0f;
    return (cylinder * this.logicalHeads + head) * this.logicalSectors + this.sector - 1;
  }

  /** Leaves the task file pointing at `lba`, as drives do after a transfer. */
  private setAddress(lba: number): void {
    if (this.select & SELECT_LBA) {
      this.sector = lba & 0xff;
      this.cylLow = (lba >> 8) & 0xff;
      this.cylHigh = (lba >> 16) & 0xff;
      this.select = (this.select & 0xf0) | ((lba >> 24) & 0x0f);
      return;
    }
    const perCylinder = this.logicalHeads * this.logicalSectors;
    const cylinder = Math.floor(lba / perCylinder);
    const rest = lba % perCylinder;
    this.cylLow = cylinder & 0xff;
    this.cylHigh = (cylinder >> 8) & 0xff;
    this.select = (this.select & 0xf0) | Math.floor(rest / this.logicalSectors);
    this.sector = (rest % this.logicalSectors) + 1;
  }

  // --- Commands --------------------------------------------------------------------------

  private command(code: number): void {
    this.error = 0;
    const sectors = this.count || 256;
    switch (code) {
      case 0xec: // IDENTIFY DEVICE
        this.later(() => this.identify());
        return;
      case 0x20: // READ SECTORS
      case 0x21:
        this.startTransfer(Transfer.Read, sectors, 1);
        return;
      case 0xc4: // READ MULTIPLE
        if (!this.multiple) break;
        this.startTransfer(Transfer.Read, sectors, this.multiple);
        return;
      case 0x30: // WRITE SECTORS
      case 0x31:
        this.startTransfer(Transfer.Write, sectors, 1);
        return;
      case 0xc5: // WRITE MULTIPLE
        if (!this.multiple) break;
        this.startTransfer(Transfer.Write, sectors, this.multiple);
        return;
      case 0xc6: // SET MULTIPLE MODE
        if (this.count && this.count <= MAX_MULTIPLE && !(this.count & (this.count - 1))) {
          this.multiple = this.count;
          this.later(() => this.finish());
          return;
        }
        break;
      case 0x91: // INITIALIZE DEVICE PARAMETERS
        this.logicalHeads = (this.select & 0x0f) + 1;
        this.logicalSectors = this.count || this.image.geometry.sectors;
        this.later(() => this.finish());
        return;
      case 0x40: // READ VERIFY SECTORS
      case 0x41: {
        const end = this.currentLba() + sectors;
        this.later(() => this.finish(end > this.image.sectorCount ? ERROR_ID_NOT_FOUND : 0));
        return;
      }
      case 0x90: // EXECUTE DEVICE DIAGNOSTIC: 1 means no error
        this.later(() => {
          this.finish();
          this.error = 1;
        });
        return;
      case 0xe5: // CHECK POWER MODE: active
      case 0x98:
        this.later(() => {
          this.count = 0xff;
          this.finish();
        });
        return;
      default:
        // Recalibrate, seek, set features, flush cache and the power commands just succeed.
        if ((code & 0xf0) === 0x10 || (code & 0xf0) === 0x70 || [0xef, 0xe7, 0xe0, 0xe1, 0xe2, 0xe3, 0xe6, 0x94, 0x95, 0x96, 0x97, 0x99].includes(code)) {
          this.later(() => this.finish());
          return;
        }
    }
    this.later(() => this.finish(ERROR_ABORT));
  }

  private identify(): void {
    const { geometry } = this.image;
    const total = this.image.sectorCount;
    const current = this.logicalHeads * this.logicalSectors * geometry.cylinders;
    const words = new Uint16Array(256);
    words[0] = 0x0040;
    words[1] = geometry.cylinders;
    words[3] = geometry.heads;
    words[6] = geometry.sectors;
    putString(words, 10, 10, 'A500EMU0001');
    putString(words, 23, 4, '1.0');
    putString(words, 27, 20, 'AMIGA500 IDE DISK');
    words[47] = 0x8000 | MAX_MULTIPLE;
    words[49] = 0x0200;
    words[53] = 0x0001;
    words[54] = geometry.cylinders;
    words[55] = this.logicalHeads;
    words[56] = this.logicalSectors;
    words[57] = current & 0xffff;
    words[58] = current >>> 16;
    words[59] = this.multiple ? 0x100 | this.multiple : 0;
    words[60] = total & 0xffff;
    words[61] = total >>> 16;
    // The A600's IDE data lines reach the CPU byte-swapped, so IDENTIFY's words arrive swapped
    // (Kickstart's driver swaps them back), while sector data arrives in disk order.
    for (let i = 0; i < 256; i++) {
      this.buffer[i * 2] = words[i] & 0xff;
      this.buffer[i * 2 + 1] = words[i] >> 8;
    }
    this.bufferLength = SECTOR_BYTES;
    this.bufferPos = 0;
    this.transfer = Transfer.Read;
    this.remaining = 0;
    this.status = Status.DRDY | Status.DSC | Status.DRQ;
    this.raiseInterrupt();
  }

  private startTransfer(kind: Transfer, sectors: number, blockSectors: number): void {
    this.lba = this.currentLba();
    if (this.lba + sectors > this.image.sectorCount) {
      this.later(() => this.finish(ERROR_ID_NOT_FOUND));
      return;
    }
    this.transfer = kind;
    this.remaining = sectors;
    this.blockSectors = blockSectors;
    this.activity = ACTIVITY_LINES;
    if (kind === Transfer.Read) {
      this.later(() => this.nextReadBlock());
    } else {
      // The first block of a write is asked for at once, without an interrupt.
      this.prepareBlock();
      this.status = Status.DRDY | Status.DSC | Status.DRQ;
    }
  }

  /** Sizes the buffer for the next block. */
  private prepareBlock(): void {
    const count = Math.min(this.blockSectors, this.remaining);
    this.bufferLength = count * SECTOR_BYTES;
    this.bufferPos = 0;
  }

  private nextReadBlock(): void {
    this.prepareBlock();
    for (let i = 0; i < this.bufferLength / SECTOR_BYTES; i++) this.image.read(this.lba + i, this.buffer, i * SECTOR_BYTES);
    this.status = Status.DRDY | Status.DSC | Status.DRQ;
    this.raiseInterrupt();
  }

  private readData(): number {
    if (this.transfer !== Transfer.Read || !(this.status & Status.DRQ)) return 0xffff;
    const word = (this.buffer[this.bufferPos] << 8) | this.buffer[this.bufferPos + 1];
    this.bufferPos += 2;
    if (this.bufferPos < this.bufferLength) return word;
    // The block has been read.
    if (this.remaining === 0) {
      // IDENTIFY's single block.
      this.transfer = Transfer.None;
      this.status = Status.DRDY | Status.DSC;
      return word;
    }
    const done = this.bufferLength / SECTOR_BYTES;
    this.lba += done;
    this.remaining -= done;
    this.setAddress(this.lba);
    if (this.remaining > 0) {
      this.later(() => this.nextReadBlock());
    } else {
      this.transfer = Transfer.None;
      this.status = Status.DRDY | Status.DSC;
    }
    return word;
  }

  private writeData(value: number): void {
    if (this.transfer !== Transfer.Write || !(this.status & Status.DRQ)) return;
    this.buffer[this.bufferPos] = value >> 8;
    this.buffer[this.bufferPos + 1] = value & 0xff;
    this.bufferPos += 2;
    if (this.bufferPos < this.bufferLength) return;
    const done = this.bufferLength / SECTOR_BYTES;
    for (let i = 0; i < done; i++) this.image.write(this.lba + i, this.buffer, i * SECTOR_BYTES);
    this.lba += done;
    this.remaining -= done;
    this.setAddress(this.lba);
    if (this.remaining > 0) {
      this.later(() => {
        this.prepareBlock();
        this.status = Status.DRDY | Status.DSC | Status.DRQ;
        this.raiseInterrupt();
      });
    } else {
      this.later(() => this.finish());
    }
  }
}
