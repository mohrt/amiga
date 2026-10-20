import { describe, expect, it } from 'vitest';
import { Int } from '../src/custom/registers';
import { idleMachine } from './helpers/machine';

describe('Agnus', () => {
  it('runs PAL frames of 313 lines of 227 colour clocks, and NTSC frames of 263', () => {
    const amiga = idleMachine();
    const start = amiga.agnus.clock;
    amiga.runFrame();
    const first = amiga.agnus.clock;
    amiga.runFrame();
    expect(amiga.agnus.clock - first).toBe(313 * 227);
    expect(first - start).toBeLessThanOrEqual(313 * 227);

    amiga.setStandard('ntsc');
    amiga.runFrame();
    const ntsc = amiga.agnus.clock;
    amiga.runFrame();
    // NTSC lines alternate 227 and 228 colour clocks.
    expect(amiga.agnus.clock - ntsc).toBeGreaterThanOrEqual(263 * 227);
    expect(amiga.agnus.clock - ntsc).toBeLessThanOrEqual(263 * 228);
  });

  it('reports the beam in VPOSR and VHPOSR', () => {
    const amiga = idleMachine();
    while (amiga.agnus.vpos !== 0x123 || amiga.agnus.hpos !== 0x45) amiga.agnus.step();
    expect(amiga.readCustom(0x004) & 1).toBe(1);
    expect(amiga.readCustom(0x006)).toBe(0x2345);
  });

  it('runs a blit in the free DMA cycles, raising BLIT when done', () => {
    const amiga = idleMachine();
    amiga.writeCustom(0x096, 0x8240); // DMAEN, BLTEN
    amiga.writeCustom(0x040, 0x09f0);
    amiga.writeCustom(0x042, 0);
    amiga.writeCustom(0x058, (50 << 6) | 20); // 1000 words, A to D: 2 cycles each
    expect(amiga.readCustom(0x002) & 0x4000).toBe(0x4000);
    amiga.agnus.runTo(amiga.agnus.clock + 1500);
    expect(amiga.agnus.blitter.busy).toBe(true);
    amiga.agnus.runTo(amiga.agnus.clock + 1500);
    expect(amiga.agnus.blitter.busy).toBe(false);
    expect(amiga.paula.intreq & Int.BLIT).toBe(Int.BLIT);
  });

  it('fetches sprites by DMA: their position, then a line of data each line', () => {
    const amiga = idleMachine();
    const sprite = 0x3000;
    // Lines $40 to $42 at horizontal position $90, then the end of the list.
    [0x4048, 0x4300, 0xffff, 0x0000, 0x8001, 0x8001, 0x0f0f, 0xf0f0, 0, 0].forEach((word, i) =>
      amiga.chip.write16(sprite + i * 2, word),
    );
    amiga.writeCustom(0x120, 0);
    amiga.writeCustom(0x122, sprite);
    amiga.writeCustom(0x096, 0x8220); // DMAEN, SPREN
    // In this frame: the pointer isn't reloaded at the next vertical blank (a Copper list normally does that).
    while (amiga.agnus.vpos !== 0x41 || amiga.agnus.hpos !== 0x40) amiga.agnus.step();
    expect(amiga.denise.sprPos[0]).toBe(0x4048);
    expect(amiga.denise.sprDataA[0]).toBe(0x8001);
    expect(amiga.denise.sprArmed[0]).toBe(1);
    while ((amiga.agnus.vpos as number) !== 0x44) amiga.agnus.step();
    expect(amiga.denise.sprArmed[0]).toBe(0);
  });
});
