import { describe, expect, it } from 'vitest';
import { readGamepad } from '../src/io/gamepad-input';
import { AmigaKeyboard, KEY_CODES } from '../src/io/keyboard';
import { ControlPorts, Joy } from '../src/io/ports';
import { idleMachine, localKickstart, machineWith, runSeconds } from './helpers/machine';

/** What the Amiga's keyboard handler does to a received byte: NOT, then rotate right. */
const decode = (byte: number) => {
  const inverted = ~byte & 0xff;
  return ((inverted >> 1) | (inverted << 7)) & 0xff;
};

describe('keyboard', () => {
  it('sends presses and releases, waiting for the handshake between them', () => {
    const sent: number[] = [];
    const keyboard = new AmigaKeyboard((byte) => sent.push(byte), () => {});
    keyboard.press(KEY_CODES.KeyA);
    keyboard.release(KEY_CODES.KeyA);
    keyboard.tick();
    keyboard.tick();
    expect(sent.map(decode)).toEqual([0x20]);
    keyboard.handshake();
    keyboard.tick();
    expect(sent.map(decode)).toEqual([0x20, 0xa0]);
  });

  it('carries on if the computer never answers', () => {
    const sent: number[] = [];
    const keyboard = new AmigaKeyboard((byte) => sent.push(byte), () => {});
    keyboard.press(KEY_CODES.Space);
    keyboard.press(KEY_CODES.Enter);
    for (let line = 0; line < 3000; line++) keyboard.tick();
    expect(sent.map(decode)).toEqual([0x40, 0x44]);
  });

  it('resets the Amiga on Ctrl and both Amiga keys', () => {
    let resets = 0;
    const keyboard = new AmigaKeyboard(() => {}, () => resets++);
    keyboard.press(KEY_CODES.ControlLeft);
    keyboard.press(KEY_CODES.MetaLeft);
    expect(resets).toBe(0);
    keyboard.press(KEY_CODES.MetaRight);
    expect(resets).toBe(1);
  });

  it('reaches CIA-A, whose switch of the serial port to output is the handshake', () => {
    const amiga = idleMachine();
    amiga.ciaA.write(0xd, 0x88);
    amiga.keyboard.press(KEY_CODES.KeyQ);
    amiga.runFrame();
    expect(decode(amiga.ciaA.read(0xc))).toBe(0x10);
    expect(amiga.ciaA.read(0xd) & 0x08).toBe(0x08);
    amiga.keyboard.release(KEY_CODES.KeyQ);
    amiga.ciaA.write(0xe, 0x40);
    amiga.ciaA.write(0xe, 0x00);
    amiga.runFrame();
    expect(decode(amiga.ciaA.read(0xc))).toBe(0x90);
  });
});

describe('keyboard with Kickstart', () => {
  const rom = localKickstart('kick13.rom');

  it.skipIf(!rom)('Kickstart 1.3 takes keys as fast as the keyboard sends them, handshaking each', () => {
    const amiga = machineWith(rom!);
    runSeconds(amiga, 6);
    let handshakes = 0;
    const handshake = amiga.keyboard.handshake.bind(amiga.keyboard);
    amiga.keyboard.handshake = () => {
      handshakes++;
      handshake();
    };
    for (const code of [0x20, 0x21, 0x22, 0x23, 0x24]) {
      amiga.keyboard.press(code);
      amiga.keyboard.release(code);
    }
    amiga.runFrame();
    amiga.runFrame();
    expect(handshakes).toBe(10);
  }, 60_000);
});

describe('control ports', () => {
  it('encodes joystick directions as the hardware does', () => {
    const ports = new ControlPorts();
    const joystick = ports.joysticks[1];
    const check = (state: number, value: number) => {
      joystick.set('test', state);
      expect(ports.joy1dat().toString(16)).toBe(value.toString(16));
    };
    check(Joy.Right, 0x0003);
    check(Joy.Left, 0x0300);
    check(Joy.Down, 0x0001);
    check(Joy.Up, 0x0100);
    check(Joy.Up | Joy.Right, 0x0103);
    check(0, 0);
  });

  it('counts mouse movement in JOY0DAT, wrapping at 8 bits, and keeps fractions', () => {
    const ports = new ControlPorts();
    ports.moveMouse(10, -3);
    expect(ports.joy0dat()).toBe((0xfd << 8) | 10);
    ports.moveMouse(250, 0.5);
    ports.moveMouse(0, 0.5);
    expect(ports.joy0dat()).toBe((0xfe << 8) | 4);
  });

  it('reads the fire buttons on CIA-A and the second buttons in POTGOR, active low', () => {
    const ports = new ControlPorts();
    expect(ports.fireBits()).toBe(0xc0);
    ports.mouseLeft = true;
    ports.joysticks[1].set('test', Joy.Fire | Joy.Fire2);
    expect(ports.fireBits()).toBe(0x00);
    expect(ports.potgor() & 0x4000).toBe(0);
    ports.mouseRight = true;
    expect(ports.potgor() & 0x0400).toBe(0);
    ports.mouseRight = false;
    expect(ports.potgor() & 0x0400).toBe(0x0400);
  });

  it('puts a joystick in port 1 instead of the mouse when asked', () => {
    const ports = new ControlPorts();
    ports.port1 = 'joystick';
    ports.joysticks[0].set('test', Joy.Right | Joy.Fire);
    expect(ports.joy0dat()).toBe(0x0003);
    expect(ports.fireBits() & 0x40).toBe(0);
  });
});

describe('gamepads', () => {
  const pad = (buttons: number[], axes = [0, 0]) => ({
    id: 'pad',
    index: 0,
    mapping: 'standard',
    axes,
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: buttons.includes(i) })),
  });

  it('maps the D-pad, stick and face buttons to the joystick', () => {
    expect(readGamepad(pad([12, 0]))).toBe(Joy.Up | Joy.Fire);
    expect(readGamepad(pad([], [0.9, 0.9]))).toBe(Joy.Right | Joy.Down);
    expect(readGamepad(pad([1]))).toBe(Joy.Fire2);
  });
});
