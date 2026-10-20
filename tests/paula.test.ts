import { describe, expect, it } from 'vitest';
import type { Amiga } from '../src/amiga';
import { Int } from '../src/custom/registers';
import { idleMachine } from './helpers/machine';

const SAMPLE = 0x8000;

/** Channel `n` playing a square wave of `words` words (+100 then -100) by DMA at `period`. */
function playSquare(amiga: Amiga, n: number, period: number, words = 8): void {
  for (let i = 0; i < words; i++) amiga.chip.write16(SAMPLE + i * 2, i < words / 2 ? 0x6464 : 0x9c9c);
  const base = 0x0a0 + n * 16;
  amiga.writeCustom(base, SAMPLE >> 16);
  amiga.writeCustom(base + 2, SAMPLE & 0xffff);
  amiga.writeCustom(base + 4, words);
  amiga.writeCustom(base + 6, period);
  amiga.writeCustom(base + 8, 64);
  amiga.writeCustom(0x096, 0x8200 | (1 << n));
}

function samples(amiga: Amiga, frames: number): Float32Array {
  amiga.paula.audio.takeSamples();
  for (let i = 0; i < frames; i++) amiga.runFrame();
  return amiga.paula.audio.takeSamples();
}

describe('Paula interrupts', () => {
  it('turns INTREQ and INTENA into the CPU interrupt level', () => {
    const amiga = idleMachine();
    amiga.writeCustom(0x09c, 0x7fff);
    amiga.writeCustom(0x09a, 0x7fff);
    amiga.writeCustom(0x09c, 0x8000 | Int.VERTB);
    expect(amiga.cpu.irqLevel).toBe(0);
    amiga.writeCustom(0x09a, 0x8000 | Int.INTEN | Int.VERTB | Int.PORTS | Int.EXTER);
    expect(amiga.cpu.irqLevel).toBe(3);
    amiga.writeCustom(0x09c, 0x8000 | Int.EXTER);
    expect(amiga.cpu.irqLevel).toBe(6);
    amiga.writeCustom(0x09c, Int.EXTER | Int.VERTB);
    amiga.writeCustom(0x09c, 0x8000 | Int.PORTS);
    expect(amiga.cpu.irqLevel).toBe(2);
    amiga.writeCustom(0x09a, Int.INTEN);
    expect(amiga.cpu.irqLevel).toBe(0);
  });

  it('raises PORTS for CIA-A and EXTER for CIA-B', () => {
    const amiga = idleMachine();
    amiga.writeCustom(0x09c, 0x7fff);
    amiga.ciaB.write(0xd, 0x81);
    amiga.ciaB.write(0x4, 10);
    amiga.ciaB.write(0x5, 0);
    amiga.ciaB.write(0xe, 0x01);
    amiga.agnus.runTo(amiga.agnus.clock + 100);
    expect(amiga.paula.intreq & Int.EXTER).toBe(Int.EXTER);
  });
});

describe('Paula sound', () => {
  it('plays a sample by DMA at its period, raising the channel interrupt at each block', () => {
    const amiga = idleMachine();
    amiga.setSampleRate(48000);
    amiga.writeCustom(0x09c, 0x7fff);
    // 8 words of 2 bytes at 200 colour clocks each: 3200 per cycle, about 1108 Hz.
    playSquare(amiga, 0, 200);
    expect(amiga.paula.intreq & Int.AUD0).toBe(Int.AUD0);
    amiga.writeCustom(0x09c, Int.AUD0);
    const output = samples(amiga, 10);
    expect(amiga.paula.intreq & Int.AUD0).toBe(Int.AUD0);
    // Count rising zero crossings on the left (channel 0's side) over 0.2 seconds.
    let crossings = 0;
    for (let i = 2; i < output.length; i += 2) if (output[i - 2] < 0 && output[i] >= 0) crossings++;
    const seconds = output.length / 2 / 48000;
    expect(crossings / seconds).toBeGreaterThan(1050);
    expect(crossings / seconds).toBeLessThan(1170);
  });

  it('puts channels 0 and 3 on the left and 1 and 2 on the right', () => {
    const amiga = idleMachine();
    amiga.paula.audio.separation = 1;
    playSquare(amiga, 1, 400);
    const output = samples(amiga, 5);
    let left = 0;
    let right = 0;
    for (let i = 0; i < output.length; i += 2) {
      left += Math.abs(output[i]);
      right += Math.abs(output[i + 1]);
    }
    expect(right).toBeGreaterThan(100);
    expect(left).toBeLessThan(right / 100);
  });

  it('plays words the CPU writes when DMA is off, interrupting after each', () => {
    const amiga = idleMachine();
    amiga.writeCustom(0x09c, 0x7fff);
    amiga.writeCustom(0x0a6, 300);
    amiga.writeCustom(0x0a8, 64);
    amiga.writeCustom(0x0aa, 0x7f7f);
    amiga.agnus.runTo(amiga.agnus.clock + 650);
    expect(amiga.paula.intreq & Int.AUD0).toBe(Int.AUD0);
  });

  it('softens the sound when the power light is on (the LED filter)', () => {
    const energy = (led: boolean) => {
      const amiga = idleMachine();
      amiga.paula.audio.ledFilter = led;
      // A high tone: 2 words at 124 colour clocks a byte.
      playSquare(amiga, 0, 124, 2);
      const output = samples(amiga, 5);
      return output.reduce((sum, value) => sum + value * value, 0);
    };
    expect(energy(true)).toBeLessThan(energy(false) * 0.7);
  });
});
