import { ADF_SIZE } from '../../src/drive/adf';

/** A bootblock's checksum: the longwords added with end-around carry, inverted. */
function bootChecksum(block: Uint8Array): number {
  const view = new DataView(block.buffer, block.byteOffset, 1024);
  let sum = 0;
  for (let i = 0; i < 1024; i += 4) {
    if (i === 4) continue;
    sum += view.getUint32(i);
    if (sum > 0xffffffff) sum -= 0xffffffff;
  }
  return ~sum >>> 0;
}

/** A blank .adf whose bootblock runs `code` (68000 machine code) when Kickstart boots it. */
export function bootableAdf(code: number[]): Uint8Array {
  const adf = new Uint8Array(ADF_SIZE);
  adf.set([0x44, 0x4f, 0x53, 0x00]); // "DOS\0"
  adf.set([0x00, 0x00, 0x03, 0x70], 8); // the root block, 880
  adf.set(code, 12);
  new DataView(adf.buffer).setUint32(4, bootChecksum(adf));
  return adf;
}

/** Boot code that sets the background to `colour` for ever: lea $DFF000,a0; loop: move.w #colour,$180(a0); bra.s loop. */
export function colourLoop(colour: number): number[] {
  return [0x41, 0xf9, 0x00, 0xdf, 0xf0, 0x00, 0x31, 0x7c, colour >> 8, colour & 0xff, 0x01, 0x80, 0x60, 0xf8];
}
