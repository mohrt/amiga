import type { Amiga } from '../amiga';
import { KEY_CODES } from './keyboard';
import { Joy } from './ports';

/** The numeric keypad. */
const NUMPAD_KEYS: Record<string, number> = {
  Numpad8: Joy.Up,
  Numpad2: Joy.Down,
  Numpad4: Joy.Left,
  Numpad6: Joy.Right,
  Numpad7: Joy.Up | Joy.Left,
  Numpad9: Joy.Up | Joy.Right,
  Numpad1: Joy.Down | Joy.Left,
  Numpad3: Joy.Down | Joy.Right,
  Numpad0: Joy.Fire,
  Numpad5: Joy.Fire,
};

const ARROW_KEYS: Record<string, number> = {
  ArrowUp: Joy.Up,
  ArrowDown: Joy.Down,
  ArrowLeft: Joy.Left,
  ArrowRight: Joy.Right,
  Space: Joy.Fire,
  AltRight: Joy.Fire2,
};

const WASD_KEYS: Record<string, number> = {
  KeyW: Joy.Up,
  KeyS: Joy.Down,
  KeyA: Joy.Left,
  KeyD: Joy.Right,
  KeyF: Joy.Fire,
  KeyG: Joy.Fire2,
};

/** The CD32 pad's other buttons, on the CD32 (which has no keyboard to type on). */
const CD32_KEYS: Record<string, number> = {
  Enter: Joy.Play,
  KeyQ: Joy.Reverse,
  KeyE: Joy.Forward,
  KeyR: Joy.Green,
  KeyT: Joy.Yellow,
};

export const KEY_SETS = { off: {}, numpad: NUMPAD_KEYS, arrows: ARROW_KEYS, wasd: WASD_KEYS } as const;
export type KeySetName = keyof typeof KEY_SETS;

/** Keys too short to see in a game that reads the joystick once a frame are held this long. */
const MIN_KEY_HOLD_MS = 40;
/** How many mouse counts a pixel of movement makes. */
const MOUSE_SCALE = 1;

/** True when a key press belongs to a form field rather than the Amiga. */
function typingInField(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return !!target && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
}

/**
 * The browser's keyboard, mouse and keys-as-joystick, wired to the Amiga:
 * keys type on the Amiga keyboard unless a joystick port uses them; the
 * mouse is captured by clicking the screen (Esc lets it go) and moves the
 * port 1 mouse.
 */
export class BrowserInput {
  private readonly keySets: [Record<string, number>, Record<string, number>] = [{}, {}];
  private readonly heldJoystick = [new Map<string, number>(), new Map<string, number>()];
  private readonly pressedAt = new Map<string, number>();
  private mouseCaptured = false;
  /** Called when the mouse is captured or let go, so the page can say how to get it back. */
  onMouseCapture: (captured: boolean) => void = () => {};

  constructor(
    private readonly amiga: Amiga,
    private readonly canvas: HTMLCanvasElement,
  ) {}

  /** Which keys act as the joystick in port 1 (index 0) or port 2 (index 1). */
  setJoystickKeys(port: 0 | 1, set: KeySetName): void {
    this.heldJoystick[port].clear();
    this.amiga.ports.joysticks[port].clear('keyboard');
    this.keySets[port] = KEY_SETS[set];
  }

  attach(target: Window): void {
    target.addEventListener('keydown', (event) => this.onKey(event, true));
    target.addEventListener('keyup', (event) => this.onKey(event, false));
    target.addEventListener('blur', () => this.releaseAll());

    this.canvas.addEventListener('mousedown', (event) => {
      if (!this.mouseCaptured) {
        if (this.amiga.ports.port1 === 'mouse') void this.canvas.requestPointerLock?.();
        return;
      }
      this.setButton(event.button, true);
      event.preventDefault();
    });
    target.addEventListener('mouseup', (event) => {
      if (this.mouseCaptured) this.setButton(event.button, false);
    });
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    target.addEventListener('mousemove', (event) => {
      if (this.mouseCaptured) this.amiga.ports.moveMouse(event.movementX * MOUSE_SCALE, event.movementY * MOUSE_SCALE);
    });
    document.addEventListener('pointerlockchange', () => {
      this.mouseCaptured = document.pointerLockElement === this.canvas;
      if (!this.mouseCaptured) this.releaseMouse();
      this.onMouseCapture(this.mouseCaptured);
    });
  }

  releaseMouse(): void {
    const ports = this.amiga.ports;
    ports.mouseLeft = ports.mouseRight = ports.mouseMiddle = false;
  }

  /** Lets the mouse go (the page does this when the port no longer has a mouse). */
  exitCapture(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private setButton(button: number, down: boolean): void {
    const ports = this.amiga.ports;
    if (button === 0) ports.mouseLeft = down;
    else if (button === 2) ports.mouseRight = down;
    else if (button === 1) ports.mouseMiddle = down;
  }

  private releaseAll(): void {
    this.amiga.keyboard.releaseAll();
    for (const port of [0, 1] as const) {
      this.heldJoystick[port].clear();
      this.amiga.ports.joysticks[port].clear('keyboard');
    }
    this.releaseMouse();
  }

  private onKey(event: KeyboardEvent, down: boolean): void {
    if (typingInField(event)) return;
    if (event.metaKey && !['MetaLeft', 'MetaRight'].includes(event.code)) return;
    const code = event.code;
    for (const port of [0, 1] as const) {
      const bits = this.keySets[port][code] ?? (port === 1 && this.amiga.ports.cd32Pad ? CD32_KEYS[code] : undefined);
      if (bits === undefined) continue;
      event.preventDefault();
      if (down) {
        if (!event.repeat) this.pressJoystickKey(port, code, bits);
      } else {
        this.releaseJoystickKey(port, code);
      }
      return;
    }
    const amigaKey = KEY_CODES[code];
    if (amigaKey === undefined) return;
    event.preventDefault();
    if (down) {
      if (!event.repeat) this.amiga.keyboard.press(amigaKey);
    } else {
      this.amiga.keyboard.release(amigaKey);
    }
  }

  private pressJoystickKey(port: 0 | 1, code: string, bits: number): void {
    this.heldJoystick[port].set(code, bits);
    this.pressedAt.set(code, performance.now());
    this.updateJoystick(port);
  }

  private releaseJoystickKey(port: 0 | 1, code: string): void {
    const remaining = MIN_KEY_HOLD_MS - (performance.now() - (this.pressedAt.get(code) ?? 0));
    const release = () => {
      this.heldJoystick[port].delete(code);
      this.updateJoystick(port);
    };
    if (remaining > 0) setTimeout(release, remaining);
    else release();
  }

  private updateJoystick(port: 0 | 1): void {
    let bits = 0;
    for (const value of this.heldJoystick[port].values()) bits |= value;
    this.amiga.ports.joysticks[port].set('keyboard', bits);
  }
}
