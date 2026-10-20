/** A double-density disk turns once in 200 ms at 2 µs per bit: 100,000 bits, 6,250 words of MFM. */
export const TRACK_WORDS = 6250;
export const SECTORS_PER_TRACK = 11;
export const SECTOR_BYTES = 512;
export const TRACK_BYTES = SECTORS_PER_TRACK * SECTOR_BYTES;
export const SYNC_WORD = 0x4489;
/** MFM-encoded zero bits: the gaps between sectors. */
export const GAP_WORD = 0xaaaa;

const DATA_BITS = 0x55555555;
const CLOCK_BITS = 0xaaaaaaaa;

/** Writes MFM words, working out the clock bits between data bits. */
class MfmWriter {
  position = 0;
  private lastBit = 0;

  constructor(readonly words: Uint16Array) {}

  raw(word: number): void {
    this.words[this.position++] = word;
    this.lastBit = word & 1;
  }

  /** Encoded zeros; the first clock bit is dropped after a one. */
  gap(): void {
    this.raw(this.lastBit ? GAP_WORD & 0x7fff : GAP_WORD);
  }

  /** A longword whose data bits are in the even positions (0x55555555); clock bits are 1 between two zeros. */
  long(data: number): void {
    const bits = data & DATA_BITS;
    let clocks = ~((bits << 1) | (bits >>> 1)) & CLOCK_BITS;
    if (this.lastBit) clocks &= 0x7fffffff;
    const mfm = (bits | clocks) >>> 0;
    this.words[this.position++] = mfm >>> 16;
    this.words[this.position++] = mfm & 0xffff;
    this.lastBit = mfm & 1;
  }

  /** A value as its odd bits, then its even bits (AmigaDOS's split encoding). */
  split(value: number): void {
    this.long(value >>> 1);
    this.long(value);
  }
}

const readLong = (bytes: Uint8Array, offset: number) =>
  ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;

/** An AmigaDOS track as MFM: 11 sectors, then a gap to the end of the revolution. */
export function encodeTrack(sectors: Uint8Array, track: number): Uint16Array {
  const words = new Uint16Array(TRACK_WORDS);
  const writer = new MfmWriter(words);
  for (let sector = 0; sector < SECTORS_PER_TRACK; sector++) {
    const data = sectors.subarray(sector * SECTOR_BYTES, (sector + 1) * SECTOR_BYTES);
    writer.gap();
    writer.gap();
    writer.raw(SYNC_WORD);
    writer.raw(SYNC_WORD);
    const info = ((0xff << 24) | (track << 16) | (sector << 8) | (SECTORS_PER_TRACK - sector)) >>> 0;
    writer.split(info);
    // The sector label: 16 zero bytes, odd bits then even bits.
    for (let i = 0; i < 8; i++) writer.long(0);
    const headerChecksum = ((info >>> 1) ^ info) & DATA_BITS;
    writer.split(headerChecksum);
    let dataChecksum = 0;
    for (let i = 0; i < SECTOR_BYTES; i += 4) {
      const value = readLong(data, i);
      dataChecksum ^= (value >>> 1) ^ value;
    }
    writer.split((dataChecksum & DATA_BITS) >>> 0);
    for (let i = 0; i < SECTOR_BYTES; i += 4) writer.long(readLong(data, i) >>> 1);
    for (let i = 0; i < SECTOR_BYTES; i += 4) writer.long(readLong(data, i));
  }
  while (writer.position < TRACK_WORDS) writer.gap();
  return words;
}

/**
 * The AmigaDOS sectors in an MFM track (as written back by a program), into
 * `sectors`. Returns how many it found intact; sectors it can't read are left as they were.
 */
export function decodeTrack(words: Uint16Array, track: number, sectors: Uint8Array): number {
  const length = words.length;
  const word = (i: number) => words[i % length];
  const long = (i: number) => (((word(i) << 16) | word(i + 1)) & DATA_BITS) >>> 0;
  const split = (i: number) => (((long(i) << 1) | long(i + 2)) >>> 0);
  const found = new Set<number>();
  for (let i = 0; i < length; i++) {
    if (word(i) !== SYNC_WORD) continue;
    let at = i + 1;
    if (word(at) === SYNC_WORD) at++;
    const info = split(at);
    const sector = (info >> 8) & 0xff;
    if (info >>> 24 !== 0xff || ((info >> 16) & 0xff) !== track || sector >= SECTORS_PER_TRACK) continue;
    let headerSum = long(at) ^ long(at + 2);
    for (let k = 0; k < 8; k++) headerSum ^= long(at + 4 + k * 2);
    if ((headerSum & DATA_BITS) >>> 0 !== split(at + 20)) continue;
    const dataStart = at + 28;
    let dataSum = 0;
    for (let k = 0; k < 256; k++) dataSum ^= long(dataStart + k * 2);
    if ((dataSum & DATA_BITS) >>> 0 !== split(at + 24)) continue;
    const out = sectors.subarray(sector * SECTOR_BYTES, (sector + 1) * SECTOR_BYTES);
    for (let k = 0; k < 128; k++) {
      const value = ((long(dataStart + k * 2) << 1) | long(dataStart + 256 + k * 2)) >>> 0;
      out[k * 4] = value >>> 24;
      out[k * 4 + 1] = value >>> 16;
      out[k * 4 + 2] = value >>> 8;
      out[k * 4 + 3] = value;
    }
    found.add(sector);
    i = dataStart + 512 - 1;
  }
  return found.size;
}
