import { decodeTrack, encodeTrack, TRACK_BYTES, TRACK_WORDS } from './mfm';

/** A double-density disk: 80 cylinders of two tracks of 11 sectors of 512 bytes. */
export const ADF_SIZE = 901120;
const HD_ADF_SIZE = ADF_SIZE * 2;
export const TRACKS = 160;
/** Drives step a few cylinders past 79; those tracks are blank. */
export const MAX_TRACKS = 168;

const EXTENDED_MAGIC = 'UAE-1ADF';

const startsWith = (data: Uint8Array, text: string) => [...text].every((char, i) => data[i] === char.charCodeAt(0));

/**
 * A floppy in a drive, as MFM tracks. AmigaDOS tracks are encoded from the
 * .adf when first read; tracks a program writes are kept as written, and
 * decoded back into the .adf by `syncSectors`. Extended ADFs (UAE-1ADF) can
 * also hold raw MFM tracks, as copy-protected disks need.
 */
export class FloppyDisk {
  /** The AmigaDOS sectors (null for tracks only held as raw MFM). */
  readonly sectors: Uint8Array;
  private readonly tracks: (Uint16Array | null)[] = new Array(MAX_TRACKS).fill(null);
  /** Tracks with sectors that came only as raw MFM, which can't be saved as an .adf. */
  private readonly rawTracks = new Set<number>();
  private readonly written = new Set<number>();
  /** Tracks written since the last `syncSectors`. */
  dirty = false;
  writeProtected = false;

  private constructor(
    readonly name: string,
    sectors: Uint8Array,
  ) {
    this.sectors = sectors;
  }

  static fromAdf(bytes: Uint8Array, name: string): FloppyDisk {
    if (bytes.length === HD_ADF_SIZE) throw new Error(`${name} is a high-density disk, which an Amiga 500's drive can't read.`);
    if (startsWith(bytes, EXTENDED_MAGIC)) return FloppyDisk.fromExtended(bytes, name);
    if (bytes.length !== ADF_SIZE) {
      throw new Error(`${name} is ${bytes.length.toLocaleString('en')} bytes; an .adf disk image is 901,120.`);
    }
    return new FloppyDisk(name, bytes.slice());
  }

  /** A blank, unformatted disk the size of an .adf (all sectors zero), for games that want their own save disk. */
  static blank(name: string): FloppyDisk {
    return new FloppyDisk(name, new Uint8Array(ADF_SIZE));
  }

  private static fromExtended(bytes: Uint8Array, name: string): FloppyDisk {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = Math.min(view.getUint16(10), MAX_TRACKS);
    const disk = new FloppyDisk(name, new Uint8Array(ADF_SIZE));
    let data = 12 + count * 12;
    for (let track = 0; track < count; track++) {
      const entry = 12 + track * 12;
      const type = view.getUint16(entry + 2);
      const length = view.getUint32(entry + 4);
      const bits = view.getUint32(entry + 8);
      if (data + length > bytes.length) throw new Error(`${name} looks damaged: track ${track} is cut short.`);
      if (type === 0 && track < TRACKS) {
        disk.sectors.set(bytes.subarray(data, data + Math.min(length, TRACK_BYTES)), track * TRACK_BYTES);
      } else if (type === 1) {
        const wordCount = Math.max(1, Math.floor(bits / 16));
        const words = new Uint16Array(wordCount);
        for (let i = 0; i < wordCount && data + i * 2 + 1 < bytes.length; i++) words[i] = view.getUint16(data + i * 2);
        disk.tracks[track] = words;
        disk.rawTracks.add(track);
      }
      data += length;
    }
    return disk;
  }

  /** The MFM words of track `index` (cylinder × 2 + side). */
  track(index: number): Uint16Array {
    let words = this.tracks[index];
    if (!words) {
      words =
        index < TRACKS ? encodeTrack(this.sectors.subarray(index * TRACK_BYTES, (index + 1) * TRACK_BYTES), index) : new Uint16Array(TRACK_WORDS);
      this.tracks[index] = words;
    }
    return words;
  }

  /** A program wrote to the track (its words were changed in place). */
  markWritten(index: number): void {
    this.written.add(index);
    this.dirty = true;
  }

  /** Whether the disk can be kept as an .adf: false once it has tracks that aren't AmigaDOS. */
  get savableAsAdf(): boolean {
    return [...this.written].every((track) => !this.rawTracks.has(track) && track < TRACKS);
  }

  /** Decodes written tracks into the sectors; returns whether any sector came out readable. */
  syncSectors(): boolean {
    let changed = false;
    for (const track of this.written) {
      if (track >= TRACKS || this.rawTracks.has(track)) continue;
      const words = this.tracks[track];
      if (words && decodeTrack(words, track, this.sectors.subarray(track * TRACK_BYTES, (track + 1) * TRACK_BYTES)) > 0) changed = true;
    }
    this.dirty = false;
    return changed;
  }

  /** The disk as an .adf file (after any writes). */
  toAdf(): Uint8Array {
    this.syncSectors();
    return this.sectors.slice();
  }
}
