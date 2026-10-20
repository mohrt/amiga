import { HardDiskImage, SECTOR_BYTES } from '../../src/ide/image';

const LONGS = SECTOR_BYTES / 4;
const RESERVED_BLOCKS = 2;
const FIRST_CYLINDER = 2;

const id = (text: string) => [...text].reduce((value, char) => (value << 8) | char.charCodeAt(0), 0) >>> 0;

/** A block's longs, with the checksum at `checksumAt` making the first `summed` longs add up to zero. */
function block(bytes: Uint8Array, at: number, longs: number[], checksumAt: number, summed = LONGS): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset + at * SECTOR_BYTES, SECTOR_BYTES);
  longs.forEach((value, i) => view.setUint32(i * 4, value >>> 0));
  let sum = 0;
  for (let i = 0; i < summed; i++) sum = (sum + view.getUint32(i * 4)) >>> 0;
  view.setUint32(checksumAt * 4, -sum >>> 0);
}

function bstr(longs: number[], first: number, text: string): void {
  const bytes = [text.length, ...[...text].map((char) => char.charCodeAt(0))];
  bytes.forEach((byte, i) => (longs[first + (i >> 2)] |= byte << (24 - (i & 3) * 8)));
}

/**
 * A hard disk as HDToolBox and Format would leave it: a Rigid Disk Block, one
 * bootable DH0 partition from cylinder 2, and an empty Fast File System volume
 * on it. Returns the disk and where the volume's root block is.
 */
export function formattedHardDisk(megabytes: number, volume = 'Work'): { image: HardDiskImage; rootLba: number } {
  const image = HardDiskImage.blank(megabytes);
  const { cylinders, heads, sectors } = image.geometry;
  const cylinderBlocks = heads * sectors;
  const { bytes } = image;

  const rdsk = new Array<number>(LONGS).fill(0);
  rdsk.splice(0, 40, id('RDSK'), 64, 0, 7, SECTOR_BYTES, 0x07, -1, 1, -1, -1, -1, -1, -1, -1, -1, -1);
  Object.assign(rdsk, { 16: cylinders, 17: sectors, 18: heads, 19: 1, 20: cylinders, 24: cylinders, 25: cylinders, 26: 3 });
  Object.assign(rdsk, { 32: 0, 33: FIRST_CYLINDER * cylinderBlocks - 1, 34: FIRST_CYLINDER, 35: cylinders - 1, 36: cylinderBlocks, 38: 1 });
  block(bytes, 0, rdsk, 2, 64);

  const part = new Array<number>(LONGS).fill(0);
  part.splice(0, 6, id('PART'), 64, 0, 7, -1, 1);
  bstr(part, 9, 'DH0');
  // The DosEnvec: 128-long blocks, the drive's geometry, 2 reserved blocks, the cylinders, 30 buffers, FFS.
  part.splice(32, 17, 16, 128, 0, heads, 1, sectors, RESERVED_BLOCKS, 0, 0, FIRST_CYLINDER, cylinders - 1, 30, 0, 0x1fe00, 0x7ffffffe, 0, id('DOS\x01'));
  block(bytes, 1, part, 2, 64);

  const start = FIRST_CYLINDER * cylinderBlocks;
  const blocks = (cylinders - FIRST_CYLINDER) * cylinderBlocks;
  const root = Math.floor((blocks - 1 + RESERVED_BLOCKS) / 2);
  new DataView(bytes.buffer).setUint32(start * SECTOR_BYTES, id('DOS\x01'));

  // Bitmap blocks follow the root block; a set bit is a free block, counting from the first after the reserved ones.
  const bitsPerBitmap = (LONGS - 1) * 32;
  const bitmapCount = Math.ceil((blocks - RESERVED_BLOCKS) / bitsPerBitmap);
  const used = new Set([root, ...Array.from({ length: bitmapCount }, (_, i) => root + 1 + i)]);
  for (let page = 0; page < bitmapCount; page++) {
    const longs = new Array<number>(LONGS).fill(0);
    for (let bit = 0; bit < bitsPerBitmap; bit++) {
      const key = RESERVED_BLOCKS + page * bitsPerBitmap + bit;
      if (key < blocks && !used.has(key)) longs[1 + (bit >> 5)] |= 1 << (bit & 31);
    }
    block(bytes, start + root + 1 + page, longs, 0);
  }

  const rootLongs = new Array<number>(LONGS).fill(0);
  rootLongs[0] = 2;
  rootLongs[3] = LONGS - 56;
  rootLongs[78] = -1;
  for (let page = 0; page < bitmapCount; page++) rootLongs[79 + page] = root + 1 + page;
  rootLongs[105] = rootLongs[118] = rootLongs[121] = 8000;
  bstr(rootLongs, 108, volume);
  rootLongs[127] = 1;
  block(bytes, start + root, rootLongs, 5);

  image.dirty.clear();
  return { image, rootLba: start + root };
}
