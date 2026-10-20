export const SECTOR_BYTES = 512;
/** Images are kept (and saved) in pieces this big, so a change only rewrites the pieces it touched. */
export const CHUNK_BYTES = 1 << 20;
const SECTORS_PER_CHUNK = CHUNK_BYTES / SECTOR_BYTES;

export interface Geometry {
  cylinders: number;
  heads: number;
  sectors: number;
}

/** New disks get 16 heads of 63 sectors, the usual IDE translation. */
const HEADS = 16;
const SECTORS = 63;

const RDSK = 0x5244534b;

/** The geometry that fits a size; sectors beyond whole cylinders stay reachable by LBA. */
export function geometryFor(bytes: number): Geometry {
  const cylinders = Math.max(1, Math.floor(bytes / (HEADS * SECTORS * SECTOR_BYTES)));
  return { cylinders: Math.min(cylinders, 65535), heads: HEADS, sectors: SECTORS };
}

/** The geometry a Rigid Disk Block (in one of the first 16 sectors) records, or null without one. */
export function rdbGeometry(bytes: Uint8Array): Geometry | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let block = 0; block < 16 && (block + 1) * SECTOR_BYTES <= bytes.length; block++) {
    const at = block * SECTOR_BYTES;
    if (view.getUint32(at) !== RDSK) continue;
    const cylinders = view.getUint32(at + 64);
    const sectors = view.getUint32(at + 68);
    const heads = view.getUint32(at + 72);
    if (cylinders && sectors && heads && heads <= 16 && sectors <= 255) return { cylinders, heads, sectors };
  }
  return null;
}

/** Whether an image starts with a file system rather than a Rigid Disk Block (a partition-only hardfile). */
export function isPartitionOnly(bytes: Uint8Array): boolean {
  return bytes[0] === 0x44 && bytes[1] === 0x4f && bytes[2] === 0x53 && rdbGeometry(bytes) === null;
}

/** A hard disk's contents: whole 512-byte sectors, with the 1 MB pieces changed since the last save noted. */
export class HardDiskImage {
  readonly dirty = new Set<number>();
  readonly geometry: Geometry;

  constructor(
    readonly bytes: Uint8Array,
    geometry?: Geometry,
  ) {
    this.geometry = geometry ?? rdbGeometry(bytes) ?? geometryFor(bytes.length);
  }

  static blank(megabytes: number): HardDiskImage {
    const geometry = geometryFor(megabytes * 1024 * 1024);
    return new HardDiskImage(new Uint8Array(geometry.cylinders * geometry.heads * geometry.sectors * SECTOR_BYTES), geometry);
  }

  /** An .hdf file as a disk (rounded down to whole sectors). */
  static fromHdf(bytes: Uint8Array): HardDiskImage {
    const whole = bytes.length - (bytes.length % SECTOR_BYTES);
    if (whole < 64 * SECTOR_BYTES) throw new Error('That file is too small to be a hard disk image.');
    return new HardDiskImage(whole === bytes.length ? bytes : bytes.slice(0, whole));
  }

  get sectorCount(): number {
    return this.bytes.length / SECTOR_BYTES;
  }

  read(lba: number, into: Uint8Array, offset = 0): void {
    const at = lba * SECTOR_BYTES;
    into.set(this.bytes.subarray(at, at + SECTOR_BYTES), offset);
  }

  write(lba: number, from: Uint8Array, offset = 0): void {
    this.bytes.set(from.subarray(offset, offset + SECTOR_BYTES), lba * SECTOR_BYTES);
    this.dirty.add(Math.floor(lba / SECTORS_PER_CHUNK));
  }
}
