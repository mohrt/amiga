/** Joystick directions and buttons. */
export const Joy = {
  Up: 0x01,
  Down: 0x02,
  Left: 0x04,
  Right: 0x08,
  Fire: 0x10,
  /** The second button (pin 9), which a few games use. */
  Fire2: 0x20,
  /** The CD32 pad's other buttons (its red and blue are Fire and Fire2); a joystick takes green as fire and yellow as the second button. */
  Green: 0x40,
  Yellow: 0x80,
  Play: 0x100,
  Reverse: 0x200,
  Forward: 0x400,
} as const;

const FIRE_BUTTONS = Joy.Fire | Joy.Green;
const SECOND_BUTTONS = Joy.Fire2 | Joy.Yellow;
/** The CD32 pad's buttons in the order its shift register gives them. */
const PAD_ORDER = [Joy.Fire2, Joy.Fire, Joy.Yellow, Joy.Green, Joy.Forward, Joy.Reverse, Joy.Play];
/** POTGO and POTGOR for port 2: pin 9's output enable and data, pin 5's output enable and data. */
const P9_OUT = 0x8000;
const P9_DATA = 0x4000;
const P5_OUT = 0x2000;
const P5_DATA = 0x1000;
const PORT2_FIRE = 0x80;

/** What is plugged into port 1 (port 2 always has a joystick). */
export type Port1Device = 'mouse' | 'joystick';

/** Several sources can hold a joystick's buttons at once (keyboard, gamepad, on-screen pad); they are combined. */
export class JoystickInput {
  private readonly sources = new Map<string, number>();
  state = 0;

  set(source: string, state: number): void {
    if (state) this.sources.set(source, state);
    else this.sources.delete(source);
    this.state = 0;
    for (const value of this.sources.values()) this.state |= value;
  }

  clear(source: string): void {
    this.set(source, 0);
  }
}

const encodeJoystick = (state: number) => {
  const right = state & Joy.Right ? 1 : 0;
  const left = state & Joy.Left ? 1 : 0;
  const down = state & Joy.Down ? 1 : 0;
  const up = state & Joy.Up ? 1 : 0;
  return (left << 9) | ((up ^ left) << 8) | (right << 1) | (down ^ right);
};

/**
 * The two control ports: the mouse's movement counters (JOY0DAT) and buttons
 * in port 1, the joysticks' directions (JOYxDAT), fire buttons (on CIA-A)
 * and second buttons (POTGOR).
 */
export class ControlPorts {
  port1: Port1Device = 'mouse';
  readonly joysticks = [new JoystickInput(), new JoystickInput()];
  mouseLeft = false;
  mouseRight = false;
  mouseMiddle = false;
  private mouseX = 0;
  private mouseY = 0;
  /** Movement not yet a whole count. */
  private pendingX = 0;
  private pendingY = 0;
  potgo = 0;
  /**
   * A CD32 pad in port 2 (on the CD32). With pin 5 driven low it shifts its buttons out on pin 9,
   * one for each falling edge of the fire line, which the CD32 then drives as a clock.
   */
  cd32Pad = false;
  private padShift = 8;
  private padClock = PORT2_FIRE;

  reset(): void {
    this.mouseX = this.mouseY = 0;
    this.potgo = 0;
    this.padShift = 8;
  }

  /** CIA-A's port A changed: with the fire line an output, a falling edge clocks the pad's next button out. */
  writePortA(output: number, direction: number): void {
    const clock = output & PORT2_FIRE;
    const shifting = !(this.potgo & P5_OUT) || !(this.potgo & P5_DATA);
    if (this.cd32Pad && shifting && direction & PORT2_FIRE && clock !== this.padClock && !clock) this.padShift = Math.max(0, this.padShift - 1);
    this.padClock = clock;
  }

  moveMouse(dx: number, dy: number): void {
    this.pendingX += dx;
    this.pendingY += dy;
    const x = Math.trunc(this.pendingX);
    const y = Math.trunc(this.pendingY);
    this.pendingX -= x;
    this.pendingY -= y;
    this.mouseX = (this.mouseX + x) & 0xff;
    this.mouseY = (this.mouseY + y) & 0xff;
  }

  joy0dat(): number {
    if (this.port1 === 'mouse') return (this.mouseY << 8) | this.mouseX;
    return encodeJoystick(this.joysticks[0].state);
  }

  joy1dat(): number {
    return encodeJoystick(this.joysticks[1].state);
  }

  /** JOYTEST writes the counters' top six bits. */
  joytest(value: number): void {
    this.mouseX = (this.mouseX & 0x03) | (value & 0xfc);
    this.mouseY = (this.mouseY & 0x03) | ((value >> 8) & 0xfc);
  }

  /** CIA-A port A bits 6 and 7: port 1's and port 2's fire buttons (active low). */
  fireBits(): number {
    const port1 = this.port1 === 'mouse' ? this.mouseLeft : (this.joysticks[0].state & FIRE_BUTTONS) !== 0;
    const port2 = (this.joysticks[1].state & FIRE_BUTTONS) !== 0;
    return (port1 ? 0 : 0x40) | (port2 ? 0 : 0x80);
  }

  /** POTGOR: the pot pins, as POTGO drives them, pulled low by a pressed button. */
  potgor(): number {
    const pin = (dataBit: number, pressed: boolean) => {
      const outputEnable = dataBit << 1;
      const level = this.potgo & outputEnable ? (this.potgo & dataBit) !== 0 : true;
      return level && !pressed ? dataBit : 0;
    };
    const port1Second = this.port1 === 'mouse' ? this.mouseRight : (this.joysticks[0].state & SECOND_BUTTONS) !== 0;
    const port2Second = (this.joysticks[1].state & SECOND_BUTTONS) !== 0;
    const port1 = pin(0x0100, this.port1 === 'mouse' && this.mouseMiddle) | pin(0x0400, port1Second);
    if (this.cd32Pad) return port1 | this.padPins();
    return port1 | pin(P5_DATA, false) | pin(P9_DATA, port2Second);
  }

  /** Port 2's pot pins with the CD32 pad in: pin 9 gives the button the shift register is at (low when pressed). */
  private padPins(): number {
    // Pin 5 driven high holds the register at its start (blue).
    if (this.potgo & P5_OUT && this.potgo & P5_DATA) this.padShift = 8;
    let pins = this.potgo & P5_DATA;
    if (!(this.potgo & P9_OUT)) pins |= P9_DATA;
    // After the seven buttons come a 1 and a 0, which say a pad is there.
    if (this.padShift === 0) pins &= ~P9_DATA;
    else if (this.padShift >= 2 && this.joysticks[1].state & PAD_ORDER[8 - this.padShift]) pins &= ~P9_DATA;
    return pins;
  }
}
