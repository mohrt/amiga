import { Joy } from './ports';

/** The parts of the browser's Gamepad object we use (so tests can pass plain objects). */
export interface GamepadLike {
  readonly id: string;
  readonly index: number;
  readonly mapping: string;
  readonly connected?: boolean;
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean }[];
}

const AXIS_THRESHOLD = 0.5;
/** Axes never go past ±1; a hat switch reads about 1.29 when centred. */
const HAT_NEUTRAL_LIMIT = 1.05;

// Standard gamepad mapping (https://w3c.github.io/gamepad/#remapping): the bottom and left
// face buttons fire, the right and top ones are the second button a few games use.
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;
// The CD32 pad's: X and Y are green and yellow, the shoulders reverse and forward, Start play
// (a joystick takes green as fire and yellow as the second button).
const BUTTONS: [number, number][] = [
  [0, Joy.Fire],
  [2, Joy.Green],
  [1, Joy.Fire2],
  [3, Joy.Yellow],
  [4, Joy.Reverse],
  [5, Joy.Forward],
  [9, Joy.Play],
];

const HAT_STEPS = [Joy.Up, Joy.Up | Joy.Right, Joy.Right, Joy.Down | Joy.Right, Joy.Down, Joy.Down | Joy.Left, Joy.Left, Joy.Up | Joy.Left];

/**
 * Directions of a hat switch reported as one axis: eight positions from -1
 * (up) clockwise in steps of 2/7, and a value beyond ±1 when centred. Many USB
 * pads report their D-pad this way when the browser has no standard mapping.
 */
export function hatDirections(value: number): number {
  if (Math.abs(value) > HAT_NEUTRAL_LIMIT) return 0;
  return HAT_STEPS[Math.round((value + 1) * 3.5)] ?? 0;
}

/** Axes seen resting beyond ±1, which makes them hat switches, by pad id. */
const knownHatAxes = new Map<string, Set<number>>();

function hatAxes(pad: GamepadLike): Set<number> {
  let hats = knownHatAxes.get(pad.id);
  if (!hats) {
    hats = new Set();
    knownHatAxes.set(pad.id, hats);
  }
  pad.axes.forEach((value, index) => {
    if (Math.abs(value) > HAT_NEUTRAL_LIMIT) hats.add(index);
  });
  return hats;
}

function axisPairDirs(x: number, y: number): number {
  let dirs = 0;
  if (y < -AXIS_THRESHOLD) dirs |= Joy.Up;
  if (y > AXIS_THRESHOLD) dirs |= Joy.Down;
  if (x < -AXIS_THRESHOLD) dirs |= Joy.Left;
  if (x > AXIS_THRESHOLD) dirs |= Joy.Right;
  return dirs;
}

/** A pad as an Amiga joystick: D-pad or stick for the directions, face buttons for fire. */
export function readGamepad(pad: GamepadLike): number {
  const pressed = (i: number) => pad.buttons[i]?.pressed ?? false;
  const axes = pad.axes;
  let state = 0;
  if (pad.mapping === 'standard') {
    if (pressed(DPAD_UP)) state |= Joy.Up;
    if (pressed(DPAD_DOWN)) state |= Joy.Down;
    if (pressed(DPAD_LEFT)) state |= Joy.Left;
    if (pressed(DPAD_RIGHT)) state |= Joy.Right;
    state |= axisPairDirs(axes[0] ?? 0, axes[1] ?? 0);
    for (const [index, button] of BUTTONS) if (pressed(index)) state |= button;
  } else {
    const hats = hatAxes(pad);
    if (!hats.has(0) && !hats.has(1)) state |= axisPairDirs(axes[0] ?? 0, axes[1] ?? 0);
    for (const index of hats) state |= hatDirections(axes[index] ?? 2);
    // Without a standard mapping, any button fires.
    if (pad.buttons.some((button) => button.pressed)) state |= Joy.Fire;
  }
  return state;
}

/** Connected gamepads in the order they were plugged in. */
export class GamepadManager {
  private readonly connectOrder: number[] = [];

  constructor(private readonly source: () => readonly (GamepadLike | null)[] = browserGamepads) {}

  attach(target: Window): void {
    target.addEventListener('gamepadconnected', (event) => this.noteConnected((event as GamepadEvent).gamepad.index));
    target.addEventListener('gamepaddisconnected', (event) => {
      const at = this.connectOrder.indexOf((event as GamepadEvent).gamepad.index);
      if (at >= 0) this.connectOrder.splice(at, 1);
    });
  }

  private noteConnected(index: number): void {
    if (!this.connectOrder.includes(index)) this.connectOrder.push(index);
  }

  connected(): GamepadLike[] {
    const pads = [...this.source()].filter((pad): pad is GamepadLike => pad !== null && pad.connected !== false);
    for (const pad of pads) this.noteConnected(pad.index);
    const rank = (pad: GamepadLike) => this.connectOrder.indexOf(pad.index);
    return pads.sort((a, b) => rank(a) - rank(b));
  }
}

function browserGamepads(): readonly (GamepadLike | null)[] {
  try {
    return navigator.getGamepads?.() ?? [];
  } catch {
    // Blocked by a permissions policy.
    return [];
  }
}

/** A short, readable name for a pad (browsers add vendor and product codes). */
export function padName(pad: GamepadLike): string {
  return pad.id.replace(/\s*\(.*\)\s*$/, '').trim() || 'Gamepad';
}
