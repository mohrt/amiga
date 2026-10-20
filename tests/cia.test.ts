import { describe, expect, it } from 'vitest';
import { Cia8520 } from '../src/cia/cia8520';

describe('8520 CIA', () => {
  it('counts timer A down and interrupts on underflow when enabled', () => {
    const cia = new Cia8520();
    let interrupts = 0;
    cia.onInterrupt = () => interrupts++;
    cia.write(0x4, 100);
    cia.write(0x5, 0);
    cia.write(0xd, 0x81);
    cia.write(0xe, 0x01);
    cia.tick(100);
    expect(interrupts).toBe(0);
    cia.tick(1);
    expect(interrupts).toBe(1);
    expect(cia.read(0xd)).toBe(0x81);
    expect(cia.read(0xd)).toBe(0);
  });

  it('starts a one-shot timer when its high byte is written', () => {
    const cia = new Cia8520();
    cia.write(0xe, 0x08);
    cia.write(0x4, 10);
    cia.write(0x5, 0);
    expect(cia.read(0xe) & 1).toBe(1);
    cia.tick(11);
    expect(cia.read(0xd) & 1).toBe(1);
    expect(cia.read(0xe) & 1).toBe(0);
  });

  it('counts timer A underflows with timer B', () => {
    const cia = new Cia8520();
    cia.write(0x4, 1);
    cia.write(0x5, 0);
    cia.write(0x6, 2);
    cia.write(0x7, 0);
    cia.write(0xf, 0x41);
    cia.write(0xe, 0x01);
    cia.tick(2 * 3);
    expect(cia.read(0xd) & 2).toBe(2);
  });

  it('has a 24-bit event counter that latches on reading its high byte, with an alarm', () => {
    const cia = new Cia8520();
    cia.write(0xd, 0x84);
    cia.write(0xf, 0x80);
    cia.write(0xa, 0);
    cia.write(0x9, 1);
    cia.write(0x8, 2);
    cia.write(0xf, 0x00);
    for (let i = 0; i < 0x101; i++) cia.countEvent();
    expect(cia.read(0xa)).toBe(0);
    cia.countEvent();
    expect(cia.read(0x9)).toBe(1);
    expect(cia.read(0x8)).toBe(1);
    cia.countEvent();
    expect(cia.read(0xd) & 0x04).toBe(0x04);
  });

  it('receives serial bytes (the keyboard) and reports switching the port to output', () => {
    const directions: boolean[] = [];
    const cia = new Cia8520({ onSerialDirection: (output) => directions.push(output) });
    cia.write(0xd, 0x88);
    cia.receiveSerial(0x5a);
    expect(cia.read(0xc)).toBe(0x5a);
    expect(cia.read(0xd)).toBe(0x88);
    cia.write(0xe, 0x40);
    cia.write(0xe, 0x00);
    expect(directions).toEqual([true, false]);
  });

  it('reads port lines set as inputs from outside, and outputs as written', () => {
    const cia = new Cia8520({ readPortA: () => 0x3f });
    cia.write(0x2, 0x03);
    cia.write(0x0, 0x02);
    expect(cia.read(0x0)).toBe(0x3e);
    expect(cia.portAOutput & 0x03).toBe(0x02);
  });
});
