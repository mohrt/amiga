import type { DmaMemory } from '../scsi/sdmac';

/** Akiko answers in the first $8000 bytes from $B80000 (its 64 registers repeat). */
const PORT_START = 0xb80000;
const PORT_END = 0xb88000;
const REG_MASK = 0x3f;

/** Interrupt request and enable bits. */
const INT_SUBCODE = 0x80000000;
const INT_DRIVE_TRANSMIT = 0x40000000;
const INT_DRIVE_RECEIVE = 0x20000000;
const INT_RX_DMA_DONE = 0x10000000;
const INT_TX_DMA_DONE = 0x08000000;
const INT_PBX = 0x04000000;
/** Flags: subcode, the command (TX) and result (RX) DMA, sector DMA (PBX), the data transfer, NTSC. */
const FLAG_SUBCODE = 0x80000000;
const FLAG_TXD = 0x40000000;
const FLAG_RXD = 0x20000000;
const FLAG_PBX = 0x08000000;
const FLAG_ENABLE = 0x04000000;

/** Drive statuses: an error, playing, and the door (1 is shut). */
const STATUS_ERROR = 0x80;
const STATUS_PLAYING = 0x08;
const DOOR_CLOSED = 0x01;
const ERROR_BAD_COMMAND = 0x80;
const ERROR_CHECKSUM = 0x88;
const ERROR_NO_DISC = 0xf8;
const FIRMWARE = 'CHINON O-658-2 24';
/** The bytes each drive command takes after its first, by its low four bits (-1: no such command). */
const COMMAND_LENGTHS = [1, 2, 1, 1, 12, 2, 1, 1, 4, 1, 2, -1, -1, -1, -1, -1];
/** Lines a command takes, and a DMA waits after its index is set. */
const COMMAND_LINES = 1;
const DMA_DELAY_LINES = 3;
/** Each TOC entry is sent three times, one a CD frame. */
const TOC_REPEAT = 3;
const SECTOR_BYTES = 2352;

/** A CD in the drive: its table of contents and its sectors as the drive reads them (2352 bytes, raw). */
export interface CdDisc {
  /** TOC entries as the drive sends them: 13 bytes each (control/ADR, track, point, the MSFs). */
  readonly toc: Uint8Array[];
  readonly sectorCount: number;
  readSector(lsn: number, into: Uint8Array): boolean;
}

const bcd = (value: number) => ((Math.floor(value / 10) % 10) << 4) | value % 10;
const fromBcd = (value: number) => (value >> 4) * 10 + (value & 15);
/** A sector number from minutes, seconds and frames in BCD (the first 150 are the lead-in). */
const msfToLsn = (bytes: Uint8Array, at: number) => (fromBcd(bytes[at]) * 60 + fromBcd(bytes[at + 1])) * 75 + fromBcd(bytes[at + 2]) - 150;

/**
 * The CD32's Akiko chip at $B80000: its ID ($C0CACAFE), the CD drive's
 * controller, the chunky-to-planar converter and the NVRAM's I2C lines.
 *
 * The drive takes commands from a ring in chip RAM (TX) and puts its results
 * in another (RX), each byte a DMA; every command and result ends with a
 * checksum. Data sectors come by DMA into the 16 buffers PBX marks free. The
 * chip interrupts on INT2 (PORTS) for what INTENA lets through.
 */
export class Akiko {
  private currentDisc: CdDisc | null = null;
  /** The disc went in or out since the drive last said so. */
  private mediaChanged = false;
  private intreq = INT_SUBCODE;
  private intena = 0;
  private flags = 0;
  private pbx = 0;
  private addressData = 0;
  private addressMisc = 0;
  private txIndex = 0;
  private rxIndex = 0;
  private txCompare = 0;
  private rxCompare = 0;
  private txDelay = 0;
  private rxDelay = 0;
  private subcodeOffset = 0xc2;

  /** The drive: the command being put together, and the result being sent back. */
  private readonly commandBuffer = new Uint8Array(32);
  private commandLength = 0;
  private commandActive = 0;
  private checksumError = false;
  private unknownCommand = false;
  private readonly result = new Uint8Array(32);
  private resultLength = 0;
  private resultOffset = 0;
  private lastRx = 0;
  /** 0 until the drive has said it is there, 1 once it has, 2 after the first status command. */
  private initialized = 0;
  private tocCounter = -1;
  private playing = false;
  private paused = false;
  /** The sectors being read: from where, how many so far, and the lines until the next. */
  private dataOffset = -1;
  private sectorCounter = 0;
  private frameLines = 0;
  private seekFrames = 0;

  /** The chunky-to-planar buffers: eight longs in, eight out. */
  private readonly c2pIn = new Uint32Array(8);
  private readonly c2pOut = new Uint32Array(8);
  private c2pWrite = 0;
  private c2pRead = -1;

  /** The NVRAM's I2C clock and data lines (bits 7 and 6) and which of them the CPU drives. */
  private i2cDirection = 0;
  private i2cLines = 0xc0;

  constructor(private readonly memory: DmaMemory, private readonly linesPerFrame: () => number) {}

  static handles(address: number): boolean {
    return address >= PORT_START && address < PORT_END;
  }

  get disc(): CdDisc | null {
    return this.currentDisc;
  }

  /** Puts a disc in the drive (or takes it out); the drive tells the CD32 once it is running. */
  set disc(disc: CdDisc | null) {
    this.currentDisc = disc;
    this.mediaChanged = true;
  }

  get interrupting(): boolean {
    return (this.intreq & this.intena) !== 0;
  }

  reset(): void {
    this.intreq = INT_SUBCODE;
    this.intena = this.flags = this.pbx = 0;
    this.txIndex = this.rxIndex = this.txCompare = this.rxCompare = 0;
    this.subcodeOffset = 0xc2;
    this.commandLength = this.commandActive = 0;
    this.resultLength = this.resultOffset = 0;
    this.initialized = 0;
    this.tocCounter = -1;
    this.playing = this.paused = false;
    this.dataOffset = -1;
    this.c2pWrite = 0;
    this.c2pRead = -1;
    this.i2cDirection = 0;
    this.mediaChanged = this.currentDisc !== null;
  }

  // --- Registers ---------------------------------------------------------------------

  read8(address: number): number {
    const reg = address & REG_MASK;
    let value = 0;
    switch (reg) {
      case 0x00:
        return 0xc0;
      case 0x01:
      case 0x02:
        return 0xca;
      case 0x03:
        return 0xfe;
      case 0x30:
        // No EEPROM answers yet, so the lines read as their pull-ups leave them (or as driven).
        return this.i2cDirection ? (this.i2cLines & this.i2cDirection) | (0xc0 & ~this.i2cDirection) : 0xc0;
      case 0x32:
        return this.i2cDirection;
      case 0x38:
      case 0x39:
      case 0x3a:
      case 0x3b:
        return this.readC2p(reg - 0x38);
      case 0x04:
      case 0x05:
      case 0x06:
      case 0x07:
        value = byteOf(this.intreq, reg - 0x04);
        break;
      case 0x08:
      case 0x09:
      case 0x0a:
      case 0x0b:
      case 0x0c:
      case 0x0d:
      case 0x0e:
      case 0x0f:
        value = byteOf(this.intena, reg & 3);
        break;
      case 0x10:
      case 0x14:
      case 0x18:
      case 0x1c:
        value = this.subcodeOffset;
        break;
      case 0x11:
      case 0x15:
      case 0x19:
      case 0x1d:
        value = this.txIndex;
        break;
      case 0x12:
      case 0x16:
      case 0x1a:
      case 0x1e:
        value = this.rxIndex;
        break;
      case 0x20:
      case 0x21:
        value = byteOf(this.pbx, reg - 0x20 + 2);
        break;
      case 0x24:
      case 0x25:
      case 0x26:
      case 0x27:
        value = byteOf(this.flags, reg - 0x24);
        break;
      case 0x28:
        if (!(this.flags & FLAG_RXD) && this.resultOffset < this.resultLength) {
          this.lastRx = this.result[this.resultOffset++];
          if (this.resultOffset === this.resultLength) {
            this.intreq &= ~INT_DRIVE_RECEIVE;
            this.resultLength = 0;
            this.intreq |= INT_DRIVE_TRANSMIT;
          }
        } else {
          this.intreq &= ~INT_DRIVE_RECEIVE;
        }
        value = this.lastRx;
        break;
    }
    this.step();
    return value;
  }

  read16(address: number): number {
    return (this.read8(address) << 8) | this.read8(address + 1);
  }

  write8(address: number, value: number): void {
    const reg = address & REG_MASK;
    value &= 0xff;
    switch (reg) {
      case 0x30:
        this.i2cLines = value & 0xc0;
        return;
      case 0x32:
        this.i2cDirection = value & 0xc0;
        return;
      case 0x38:
      case 0x39:
      case 0x3a:
      case 0x3b:
        this.writeC2p(reg - 0x38, value);
        return;
      case 0x08:
      case 0x09:
      case 0x0a:
      case 0x0b:
        this.intena = withByte(this.intena, reg - 0x08, value) & 0xff000000;
        break;
      case 0x10:
      case 0x11:
      case 0x12:
      case 0x13:
        this.addressData = withByte(this.addressData, reg - 0x10, value) & 0x00fff000;
        break;
      case 0x14:
      case 0x15:
      case 0x16:
      case 0x17:
        this.addressMisc = withByte(this.addressMisc, reg - 0x14, value) & 0x00fffc00;
        break;
      case 0x18:
        this.intreq &= ~INT_SUBCODE;
        break;
      case 0x1d:
        this.intreq &= ~INT_TX_DMA_DONE;
        this.txCompare = value;
        this.txDelay = DMA_DELAY_LINES;
        break;
      case 0x1f:
        this.intreq &= ~INT_RX_DMA_DONE;
        this.rxCompare = value;
        this.rxDelay = DMA_DELAY_LINES;
        break;
      case 0x20:
      case 0x21: {
        // Setting a bit frees that sector buffer; the bits only clear as sectors arrive.
        const pbx = (withByte(this.pbx, reg - 0x20 + 2, value) | this.pbx) & 0xffff;
        this.pbx = this.flags & FLAG_PBX ? pbx : 0;
        this.intreq &= ~INT_PBX;
        break;
      }
      case 0x24:
      case 0x25:
      case 0x26:
      case 0x27: {
        const before = this.flags;
        this.flags = withByte(this.flags, reg - 0x24, value) & 0xff800000;
        if (this.flags & FLAG_ENABLE && !(before & FLAG_ENABLE)) this.sectorCounter = 0;
        if (!(this.flags & FLAG_PBX)) this.pbx = 0;
        break;
      }
      case 0x28:
        if (!(this.flags & FLAG_TXD)) {
          this.intreq &= ~INT_DRIVE_TRANSMIT;
          if (this.canTakeCommand()) {
            this.addCommandByte(value);
            if (this.canTakeCommand()) this.intreq |= INT_DRIVE_TRANSMIT;
          }
        }
        break;
    }
    this.step();
  }

  write16(address: number, value: number): void {
    this.write8(address, value >> 8);
    this.write8(address + 1, value);
  }

  // --- The drive ---------------------------------------------------------------------

  /** Once a line: the DMA delays, a CD frame's work (75 a second), and the command and result DMA. */
  tick(): void {
    if (this.txDelay > 0) this.txDelay--;
    if (this.rxDelay > 0) this.rxDelay--;
    if (--this.frameLines <= 0) {
      this.frameLines += Math.max(1, Math.round((this.linesPerFrame() * 50) / 75));
      this.cdFrame();
    }
    this.step();
  }

  private cdFrame(): void {
    if (this.seekFrames > 0) this.seekFrames--;
    else this.readSector();
    if (this.resultLength) return;
    if (!this.initialized) {
      // The disc is reported once the CD32 has asked for the drive's status: cd.device reads the
      // TOC on the change, which it can only do once the drive has answered.
      this.initialized = 1;
      return;
    }
    if (this.initialized < 2) return;
    if (this.mediaChanged) {
      this.mediaChanged = false;
      this.sendResult(this.mediaStatus());
      return;
    }
    if (this.tocCounter >= 0 && !this.commandActive) this.sendResult(this.tocEntry());
  }

  private step(): void {
    this.returnResult();
    this.takeCommandByte();
    if (this.commandActive > 0 && --this.commandActive === 0) this.runCommand();
  }

  private canTakeCommand(): boolean {
    return this.initialized > 0 && !this.commandActive && !this.resultLength;
  }

  /** TX DMA: the next command byte from the ring at the misc address + $200. */
  private takeCommandByte(): void {
    if (!(this.flags & FLAG_TXD) || this.flags & FLAG_ENABLE) return;
    if (this.txIndex === this.txCompare || this.txDelay > 0 || !this.canTakeCommand()) return;
    this.addCommandByte(this.memory.read8(this.addressMisc + 0x200 + this.txIndex));
    this.txIndex = (this.txIndex + 1) & 0xff;
    if (this.txIndex === this.txCompare) this.raise(INT_TX_DMA_DONE);
  }

  private addCommandByte(byte: number): void {
    this.commandBuffer[this.commandLength++] = byte;
    const length = COMMAND_LENGTHS[this.commandBuffer[0] & 0x0f];
    this.checksumError = this.unknownCommand = false;
    if (length < 0) {
      this.unknownCommand = true;
      this.commandActive = COMMAND_LINES;
      return;
    }
    if (this.commandLength < length + 1) return;
    let sum = 0;
    for (let i = 0; i <= length; i++) sum += this.commandBuffer[i];
    this.checksumError = (sum & 0xff) !== 0xff;
    this.commandActive = COMMAND_LINES;
    this.commandLength = length;
  }

  private runCommand(): void {
    const command = this.commandBuffer[0];
    this.commandLength = 0;
    this.result.fill(0);
    if (this.checksumError || this.unknownCommand) {
      this.result[0] = (command & 0xf0) | 5;
      this.result[1] = (this.checksumError ? ERROR_CHECKSUM : ERROR_BAD_COMMAND) | DOOR_CLOSED;
      this.sendResult(2);
      return;
    }
    this.result[0] = command;
    let length = 0;
    switch (command & 0x0f) {
      case 0:
        length = 1;
        break;
      case 1: // stop
      case 2: // pause
      case 3: // unpause
        length = this.playCommand(command & 0x0f);
        break;
      case 4:
        length = this.multi();
        break;
      case 5: // LED: a result only if asked for
        if (this.commandBuffer[1] & 0x80) {
          this.result[1] = this.commandBuffer[1] & 1;
          length = 2;
        }
        break;
      case 6: // subcode Q: none to give
        length = 15;
        break;
      case 7: {
        // Status: the door, and the firmware's name.
        this.result[1] = DOOR_CLOSED;
        for (let i = 0; i < FIRMWARE.length; i++) this.result[2 + i] = FIRMWARE.charCodeAt(i);
        this.initialized = 2;
        length = 20;
        break;
      }
    }
    if (length === 0) this.raise(INT_DRIVE_TRANSMIT);
    else this.sendResult(length);
  }

  private noDisc(): boolean {
    if (this.disc) return false;
    this.result[1] = ERROR_NO_DISC | DOOR_CLOSED;
    return true;
  }

  private playCommand(kind: number): number {
    if (kind === 2) this.tocCounter = -1;
    if (this.noDisc()) return 2;
    if (kind === 1) {
      this.playing = false;
      this.result[1] = 0;
      return 2;
    }
    this.paused = kind === 2;
    this.result[1] = (this.playing && !this.paused ? STATUS_PLAYING : 0) | DOOR_CLOSED;
    return 2;
  }

  /** Seek, play audio or read data, from one MSF to another. */
  private multi(): number {
    const from = msfToLsn(this.commandBuffer, 1);
    this.playing = this.paused = false;
    this.result[1] = 0;
    if (!this.disc) {
      this.result[1] = 1;
      return 2;
    }
    if (this.commandBuffer[7] & 0x80) {
      this.dataOffset = from;
      this.sectorCounter = 0;
      this.seekFrames = 1;
      this.result[1] |= 0x02;
    } else if (from < 0) {
      // A play from before the first track asks for the TOC.
      this.tocCounter = 0;
    } else {
      // Audio isn't played yet: the drive says it has started, and stays silent.
      this.result[1] = 0x42;
      this.playing = true;
    }
    return 2;
  }

  private mediaStatus(): number {
    this.result[0] = 0x0a;
    this.result[1] = this.disc ? 0x01 : 0x00;
    return 2;
  }

  private tocEntry(): number {
    this.result.fill(0);
    this.result[0] = 6;
    const toc = this.disc?.toc ?? [];
    if (!toc.length) {
      this.result[1] = STATUS_ERROR | DOOR_CLOSED;
      this.tocCounter = -1;
      return 15;
    }
    this.result[1] = 0x0a;
    this.result.set(toc[Math.floor(this.tocCounter / TOC_REPEAT)], 2);
    this.result[6] = bcd(99);
    this.result[7] = bcd(24 + Math.floor(this.tocCounter / 75));
    this.result[8] = bcd(this.tocCounter % 75);
    this.tocCounter++;
    if (this.tocCounter / TOC_REPEAT >= toc.length) this.tocCounter = -1;
    return 15;
  }

  /** Puts a result together (with its checksum) to go back by RX DMA or through $B80028. */
  private sendResult(length: number): void {
    if (this.resultLength || length <= 0) return;
    let sum = 0xff;
    for (let i = 0; i < length; i++) sum -= this.result[i];
    this.result[length] = sum & 0xff;
    this.resultLength = length + 1;
    this.resultOffset = 0;
    this.raise(INT_DRIVE_RECEIVE);
  }

  /** RX DMA: the result into the ring at the misc address, until the index meets the compare. */
  private returnResult(): void {
    if (!this.resultLength || !(this.flags & FLAG_RXD) || this.rxIndex === this.rxCompare || this.rxDelay > 0) return;
    while (this.resultOffset < this.resultLength) {
      this.lastRx = this.result[this.resultOffset++];
      this.memory.write8(this.addressMisc + this.rxIndex, this.lastRx);
      this.rxIndex = (this.rxIndex + 1) & 0xff;
      if (this.rxIndex === this.rxCompare) {
        this.raise(INT_RX_DMA_DONE);
        break;
      }
    }
    if (this.resultOffset === this.resultLength) {
      this.resultLength = this.resultOffset = 0;
      this.intreq &= ~INT_DRIVE_RECEIVE;
      this.raise(INT_DRIVE_TRANSMIT);
    }
  }

  /** A data sector into the highest free buffer (4K each from the data address). */
  private readSector(): void {
    if (!(this.flags & FLAG_ENABLE) || !(this.flags & FLAG_PBX) || !this.pbx || this.dataOffset < 0 || !this.disc) return;
    let buffer = 15;
    while (buffer >= 0 && !(this.pbx & (1 << buffer))) buffer--;
    const sector = new Uint8Array(SECTOR_BYTES);
    if (!this.disc.readSector(this.dataOffset + this.sectorCounter, sector)) return;
    // The sync bytes' place holds the sector counter.
    sector[0] = sector[1] = sector[2] = 0;
    sector[3] = this.sectorCounter & 31;
    const base = this.addressData + buffer * 4096;
    for (let i = 0; i < SECTOR_BYTES; i++) this.memory.write8(base + i, sector[i]);
    for (let i = 0; i < 146; i++) this.memory.write8(base + 0xc00 + i, 0);
    this.pbx &= ~(1 << buffer);
    this.raise(INT_PBX);
    this.sectorCounter++;
    if (this.flags & FLAG_SUBCODE) this.raise(INT_SUBCODE);
  }

  private raise(bits: number): void {
    this.intreq = (this.intreq | bits) >>> 0;
  }

  // --- Chunky to planar --------------------------------------------------------------

  /** A long's bytes arrive high first (the CPU writes its high word, then its low one); the last completes it. */
  private writeC2p(offset: number, value: number): void {
    if (offset === 0) this.c2pIn[this.c2pWrite] = 0;
    this.c2pIn[this.c2pWrite] = (this.c2pIn[this.c2pWrite] | (value << (8 * (3 - offset)))) >>> 0;
    if (offset === 3) this.c2pWrite = (this.c2pWrite + 1) & 7;
    this.c2pRead = -1;
  }

  private readC2p(offset: number): number {
    if (this.c2pRead < 0) {
      this.convert();
      this.c2pRead = 0;
    }
    this.c2pWrite = 0;
    const value = (this.c2pOut[this.c2pRead] >>> (8 * (3 - offset))) & 0xff;
    if (offset === 3) this.c2pRead = (this.c2pRead + 1) & 7;
    return value;
  }

  /** Eight longs of chunky pixels (32 of 8 bits) to eight longs of planes (one per bitplane). */
  private convert(): void {
    this.c2pOut.fill(0);
    for (let bit = 0; bit < 32; bit++) {
      for (let pixelLong = 0; pixelLong < 8; pixelLong++) {
        if (!(this.c2pIn[pixelLong] & (1 << bit))) continue;
        const plane = bit & 7;
        const position = (bit >> 3) + ((7 - pixelLong) << 2);
        this.c2pOut[plane] |= 1 << position;
      }
    }
  }
}

function byteOf(value: number, index: number): number {
  return (value >>> (8 * (3 - index))) & 0xff;
}

function withByte(value: number, index: number, byte: number): number {
  const shift = 8 * (3 - index);
  return ((value & ~(0xff << shift)) | (byte << shift)) >>> 0;
}
