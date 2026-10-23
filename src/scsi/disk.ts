import type { HardDiskImage } from '../ide/image';

const SECTOR_BYTES = 512;
/** The activity light stays on this long after the drive was used (in lines, about a fifth of a second). */
const ACTIVITY_LINES = 3000;

/** SCSI status bytes. */
export const STATUS_GOOD = 0x00;
const STATUS_CHECK_CONDITION = 0x02;
/** Sense keys and additional sense codes for the errors reported here. */
const SENSE_ILLEGAL_REQUEST = 0x05;
const ASC_INVALID_COMMAND = 0x20;
const ASC_LBA_OUT_OF_RANGE = 0x21;
const ASC_INVALID_LUN = 0x25;

/** What a command does after its CDB: send data to the host, take some from it, or neither. */
export interface ScsiCommand {
  /** Data for the host (data in). */
  dataIn?: Uint8Array;
  /** Bytes the host is to send (data out), and what to do with them. */
  dataOutLength?: number;
  onDataOut?: (data: Uint8Array) => void;
  /** The status byte once the data has moved. */
  status: number;
}

/** The length of a CDB, from its group (the top three bits of the operation code). */
export function cdbLength(opcode: number): number {
  const group = opcode >> 5;
  if (group === 0) return 6;
  if (group === 1 || group === 2) return 10;
  if (group === 5) return 12;
  return 6;
}

const ascii = (text: string, length: number) => [...text.padEnd(length)].slice(0, length).map((char) => char.charCodeAt(0));

/**
 * A SCSI hard disk on the A3000's controller, holding the same kind of image
 * as the IDE drive: TEST UNIT READY, REQUEST SENSE, INQUIRY, READ CAPACITY,
 * READ and WRITE (6 and 10), MODE SENSE with the geometry pages HDToolBox reads,
 * and the commands that need nothing doing (START/STOP, VERIFY, MODE SELECT...).
 * Only LUN 0 is there.
 */
export class ScsiDisk {
  /** Lines the activity light stays on. */
  activity = 0;
  private sense = new Uint8Array(18);

  constructor(readonly image: HardDiskImage) {}

  /** Runs a command from its CDB, for logical unit `lun`. */
  execute(cdb: Uint8Array, lun: number): ScsiCommand {
    const opcode = cdb[0];
    if (lun !== 0 && opcode !== 0x03) {
      if (opcode === 0x12) return { dataIn: this.inquiry(cdb[4], true), status: STATUS_GOOD };
      return this.fail(ASC_INVALID_LUN);
    }
    switch (opcode) {
      case 0x00: // TEST UNIT READY
      case 0x01: // REZERO UNIT
      case 0x04: // FORMAT UNIT
      case 0x0b: // SEEK (6)
      case 0x16: // RESERVE
      case 0x17: // RELEASE
      case 0x1b: // START STOP UNIT
      case 0x1e: // PREVENT ALLOW MEDIUM REMOVAL
      case 0x2b: // SEEK (10)
      case 0x2f: // VERIFY (10)
      case 0x35: // SYNCHRONIZE CACHE
        return this.good();
      case 0x03: {
        // REQUEST SENSE: the last error's, then none.
        const sense = this.sense.slice(0, Math.min(cdb[4] || 4, this.sense.length));
        if (sense.length) sense[0] = 0x70;
        this.sense.fill(0);
        return { dataIn: sense, status: STATUS_GOOD };
      }
      case 0x12: // INQUIRY
        return { dataIn: this.inquiry(cdb[4], false), status: STATUS_GOOD };
      case 0x25: {
        // READ CAPACITY: the last block and the block size.
        const data = new Uint8Array(8);
        const view = new DataView(data.buffer);
        view.setUint32(0, this.image.sectorCount - 1);
        view.setUint32(4, SECTOR_BYTES);
        return { dataIn: data, status: STATUS_GOOD };
      }
      case 0x1a: // MODE SENSE (6)
        return { dataIn: this.modeSense(cdb[2] & 0x3f, cdb[4]), status: STATUS_GOOD };
      case 0x15: // MODE SELECT (6): the parameters are taken and forgotten.
        return { dataOutLength: cdb[4], onDataOut: () => {}, status: STATUS_GOOD };
      case 0x08: // READ (6)
        return this.read(((cdb[1] & 0x1f) << 16) | (cdb[2] << 8) | cdb[3], cdb[4] || 256);
      case 0x28: // READ (10)
        return this.read(lba10(cdb), (cdb[7] << 8) | cdb[8]);
      case 0x0a: // WRITE (6)
        return this.write(((cdb[1] & 0x1f) << 16) | (cdb[2] << 8) | cdb[3], cdb[4] || 256);
      case 0x2a: // WRITE (10)
        return this.write(lba10(cdb), (cdb[7] << 8) | cdb[8]);
      default:
        return this.fail(ASC_INVALID_COMMAND);
    }
  }

  tick(): void {
    if (this.activity > 0) this.activity--;
  }

  private good(): ScsiCommand {
    return { status: STATUS_GOOD };
  }

  private fail(asc: number): ScsiCommand {
    this.sense.fill(0);
    this.sense[2] = SENSE_ILLEGAL_REQUEST;
    this.sense[7] = 10;
    this.sense[12] = asc;
    return { status: STATUS_CHECK_CONDITION };
  }

  private inRange(lba: number, count: number): boolean {
    return lba + count <= this.image.sectorCount;
  }

  private read(lba: number, count: number): ScsiCommand {
    if (!this.inRange(lba, count)) return this.fail(ASC_LBA_OUT_OF_RANGE);
    const data = new Uint8Array(count * SECTOR_BYTES);
    for (let i = 0; i < count; i++) this.image.read(lba + i, data, i * SECTOR_BYTES);
    this.activity = ACTIVITY_LINES;
    return { dataIn: data, status: STATUS_GOOD };
  }

  private write(lba: number, count: number): ScsiCommand {
    if (!this.inRange(lba, count)) return this.fail(ASC_LBA_OUT_OF_RANGE);
    return {
      dataOutLength: count * SECTOR_BYTES,
      onDataOut: (data) => {
        for (let i = 0; i < count; i++) this.image.write(lba + i, data, i * SECTOR_BYTES);
        this.activity = ACTIVITY_LINES;
      },
      status: STATUS_GOOD,
    };
  }

  private inquiry(length: number, noUnit: boolean): Uint8Array {
    const data = new Uint8Array(36);
    // A direct-access device (or none at this LUN), SCSI-2, with 31 more bytes.
    data[0] = noUnit ? 0x7f : 0x00;
    data[2] = 0x02;
    data[3] = 0x02;
    data[4] = 31;
    data.set(ascii('AMIGA', 8), 8);
    data.set(ascii('HARD DISK', 16), 16);
    data.set(ascii('1.0', 4), 32);
    return data.slice(0, length || 36);
  }

  /** MODE SENSE: the header and block descriptor, with the format (3) and geometry (4) pages. */
  private modeSense(page: number, length: number): Uint8Array {
    const { cylinders, heads, sectors } = this.image.geometry;
    const pages: number[][] = [];
    if (page === 3 || page === 0x3f) {
      const format = new Array(24).fill(0);
      format[0] = 0x03;
      format[1] = 22;
      format[10] = sectors >> 8;
      format[11] = sectors & 0xff;
      format[12] = SECTOR_BYTES >> 8;
      pages.push(format);
    }
    if (page === 4 || page === 0x3f) {
      const geometry = new Array(24).fill(0);
      geometry[0] = 0x04;
      geometry[1] = 22;
      geometry[2] = cylinders >> 16;
      geometry[3] = (cylinders >> 8) & 0xff;
      geometry[4] = cylinders & 0xff;
      geometry[5] = heads;
      pages.push(geometry);
    }
    const blocks = this.image.sectorCount;
    const descriptor = [0, (blocks >> 16) & 0xff, (blocks >> 8) & 0xff, blocks & 0xff, 0, 0, SECTOR_BYTES >> 8, 0];
    const body = [...descriptor, ...pages.flat()];
    const data = new Uint8Array([body.length + 3, 0, 0, descriptor.length, ...body]);
    return data.slice(0, Math.min(length || data.length, data.length));
  }
}

function lba10(cdb: Uint8Array): number {
  return ((cdb[2] << 24) | (cdb[3] << 16) | (cdb[4] << 8) | cdb[5]) >>> 0;
}
