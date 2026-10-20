import { describe, expect, it } from 'vitest';
import type { Amiga } from '../src/amiga';
import { idleMachine } from './helpers/machine';

const LIST = 0x2000;

function startCopper(amiga: Amiga, list: number[]): void {
  list.forEach((word, i) => amiga.chip.write16(LIST + i * 2, word));
  amiga.writeCustom(0x080, LIST >> 16);
  amiga.writeCustom(0x082, LIST & 0xffff);
  amiga.writeCustom(0x096, 0x8280); // DMAEN, COPEN
  amiga.writeCustom(0x088, 0);
}

function runToLine(amiga: Amiga, line: number, hpos = 0): void {
  while (amiga.agnus.vpos !== line || amiga.agnus.hpos !== hpos) amiga.agnus.step();
}

describe('Copper', () => {
  it('waits for a beam position, then moves values into registers', () => {
    const amiga = idleMachine();
    runToLine(amiga, 10);
    startCopper(amiga, [0x0180, 0x0111, 0x6401, 0xfffe, 0x0180, 0x0f00, 0xffff, 0xfffe]);
    runToLine(amiga, 20);
    expect(amiga.denise.colors[0]).toBe(0x111);
    runToLine(amiga, 0x64, 0x10);
    expect(amiga.denise.colors[0]).toBe(0xf00);
  });

  it('restarts from COP1LC at each vertical blank', () => {
    const amiga = idleMachine();
    startCopper(amiga, [0x0180, 0x0123, 0xffff, 0xfffe]);
    runToLine(amiga, 50);
    amiga.writeCustom(0x180, 0);
    runToLine(amiga, 5);
    expect(amiga.denise.colors[0]).toBe(0x123);
  });

  it('skips the next instruction once the beam is past a SKIP', () => {
    const amiga = idleMachine();
    runToLine(amiga, 10);
    startCopper(amiga, [0x0501, 0xffff, 0x0180, 0x0f00, 0x0182, 0x00f0, 0xffff, 0xfffe]);
    runToLine(amiga, 12);
    expect(amiga.denise.colors[0]).toBe(0);
    expect(amiga.denise.colors[1]).toBe(0x0f0);
  });

  it('stops at a write below $80 without the danger bit, and allows the blitter registers with it', () => {
    const amiga = idleMachine();
    runToLine(amiga, 10);
    startCopper(amiga, [0x0044, 0x1234, 0x0180, 0x0fff, 0xffff, 0xfffe]);
    runToLine(amiga, 12);
    expect(amiga.agnus.blitter.afwm).toBe(0xffff);
    expect(amiga.denise.colors[0]).toBe(0);

    const dangerous = idleMachine();
    runToLine(dangerous, 10);
    dangerous.writeCustom(0x02e, 0x0002);
    startCopper(dangerous, [0x0044, 0x1234, 0x0180, 0x0fff, 0xffff, 0xfffe]);
    runToLine(dangerous, 12);
    expect(dangerous.agnus.blitter.afwm).toBe(0x1234);
    expect(dangerous.denise.colors[0]).toBe(0xfff);
  });
});
