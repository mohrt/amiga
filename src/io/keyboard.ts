/** Amiga raw key codes by browser key code. */
export const KEY_CODES: Record<string, number> = {
  Backquote: 0x00,
  Digit1: 0x01,
  Digit2: 0x02,
  Digit3: 0x03,
  Digit4: 0x04,
  Digit5: 0x05,
  Digit6: 0x06,
  Digit7: 0x07,
  Digit8: 0x08,
  Digit9: 0x09,
  Digit0: 0x0a,
  Minus: 0x0b,
  Equal: 0x0c,
  Backslash: 0x0d,
  Numpad0: 0x0f,
  KeyQ: 0x10,
  KeyW: 0x11,
  KeyE: 0x12,
  KeyR: 0x13,
  KeyT: 0x14,
  KeyY: 0x15,
  KeyU: 0x16,
  KeyI: 0x17,
  KeyO: 0x18,
  KeyP: 0x19,
  BracketLeft: 0x1a,
  BracketRight: 0x1b,
  Numpad1: 0x1d,
  Numpad2: 0x1e,
  Numpad3: 0x1f,
  KeyA: 0x20,
  KeyS: 0x21,
  KeyD: 0x22,
  KeyF: 0x23,
  KeyG: 0x24,
  KeyH: 0x25,
  KeyJ: 0x26,
  KeyK: 0x27,
  KeyL: 0x28,
  Semicolon: 0x29,
  Quote: 0x2a,
  Numpad4: 0x2d,
  Numpad5: 0x2e,
  Numpad6: 0x2f,
  IntlBackslash: 0x30,
  KeyZ: 0x31,
  KeyX: 0x32,
  KeyC: 0x33,
  KeyV: 0x34,
  KeyB: 0x35,
  KeyN: 0x36,
  KeyM: 0x37,
  Comma: 0x38,
  Period: 0x39,
  Slash: 0x3a,
  NumpadDecimal: 0x3c,
  Numpad7: 0x3d,
  Numpad8: 0x3e,
  Numpad9: 0x3f,
  Space: 0x40,
  Backspace: 0x41,
  Tab: 0x42,
  NumpadEnter: 0x43,
  Enter: 0x44,
  Escape: 0x45,
  Delete: 0x46,
  NumpadSubtract: 0x4a,
  ArrowUp: 0x4c,
  ArrowDown: 0x4d,
  ArrowRight: 0x4e,
  ArrowLeft: 0x4f,
  F1: 0x50,
  F2: 0x51,
  F3: 0x52,
  F4: 0x53,
  F5: 0x54,
  F6: 0x55,
  F7: 0x56,
  F8: 0x57,
  F9: 0x58,
  F10: 0x59,
  NumpadDivide: 0x5c,
  NumpadMultiply: 0x5d,
  NumpadAdd: 0x5e,
  Insert: 0x5f,
  PageDown: 0x5f,
  ShiftLeft: 0x60,
  ShiftRight: 0x61,
  CapsLock: 0x62,
  ControlLeft: 0x63,
  ControlRight: 0x63,
  AltLeft: 0x64,
  AltRight: 0x65,
  MetaLeft: 0x66,
  Home: 0x66,
  MetaRight: 0x67,
  End: 0x67,
};

export const KEY_CTRL = 0x63;
export const KEY_LEFT_AMIGA = 0x66;
export const KEY_RIGHT_AMIGA = 0x67;

/** If the computer doesn't answer a key code, the keyboard carries on after this long (143 ms; in lines of 64 µs). */
const HANDSHAKE_TIMEOUT_LINES = 2240;

/**
 * The Amiga keyboard: it sends each key press and release as a byte through
 * CIA-A's serial port (the code shifted left with the release bit at the
 * bottom, inverted), waiting for the computer's handshake before the next.
 * Ctrl with both Amiga keys resets the machine.
 */
export class AmigaKeyboard {
  private readonly queue: number[] = [];
  private readonly held = new Set<number>();
  private waitLines = 0;

  constructor(
    private readonly send: (byte: number) => void,
    private readonly onReset: () => void,
  ) {}

  reset(): void {
    this.queue.length = 0;
    this.held.clear();
    this.waitLines = 0;
  }

  press(code: number): void {
    if (this.held.has(code)) return;
    this.held.add(code);
    this.queue.push(code);
    if (this.held.has(KEY_CTRL) && this.held.has(KEY_LEFT_AMIGA) && this.held.has(KEY_RIGHT_AMIGA)) {
      this.reset();
      this.onReset();
    }
  }

  release(code: number): void {
    if (!this.held.delete(code)) return;
    this.queue.push(code | 0x80);
  }

  /** Lets go of every key (the page lost focus). */
  releaseAll(): void {
    for (const code of [...this.held]) this.release(code);
  }

  /** The computer pulsed the data line: it has the last byte. */
  handshake(): void {
    this.waitLines = 0;
  }

  /** Once a line: sends the next key when the last one was taken. */
  tick(): void {
    if (this.waitLines > 0) {
      this.waitLines--;
      return;
    }
    const next = this.queue.shift();
    if (next === undefined) return;
    this.send(~(((next & 0x7f) << 1) | (next >> 7)) & 0xff);
    this.waitLines = HANDSHAKE_TIMEOUT_LINES;
  }
}
