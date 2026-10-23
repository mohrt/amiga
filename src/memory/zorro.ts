const AUTOCONFIG_START = 0xe80000;
const AUTOCONFIG_END = 0xf00000;
/** er_Type: a Zorro II board whose memory is added to the free memory list; the low bits give its size. */
const TYPE_ZORRO2_MEMORY = 0xe0;
const SIZE_CODES: Record<number, number> = { 2048: 6, 4096: 7, 8192: 0 };
const PRODUCT = 0x01;
/** er_Flags: it prefers the 8 MB space. */
const FLAGS = 0x80;
/** The manufacturer number (2011, as UAE's boards use). */
const MANUFACTURER = 2011;

/**
 * A Zorro II fast RAM board (as on the A2000's slots or an A500 side expansion). Until Kickstart
 * has configured it, it answers in the autoconfig space at $E80000 with its description, a nibble
 * in the top of each even byte (inverted, except the board type); writing the base address's high
 * byte to $48 puts it there. Fast RAM isn't on the chip bus, so DMA doesn't slow it down.
 */
export class ZorroRam {
  readonly bytes: Uint8Array;
  /** Where Kickstart put the board, or -1 while it is still in the autoconfig space. */
  base = -1;
  /** Shut up by Kickstart (written to $4C): it is left out. */
  private shutUp = false;
  /** The base address's low nibble, written to $4A before the high one at $48. */
  private lowNibble = 0;
  private readonly rom = new Uint8Array(0x40);

  constructor(sizeKb: number) {
    this.bytes = new Uint8Array(sizeKb * 1024);
    const description = [
      [0x00, TYPE_ZORRO2_MEMORY | SIZE_CODES[sizeKb]],
      [0x04, PRODUCT],
      [0x08, FLAGS],
      [0x10, MANUFACTURER >> 8],
      [0x14, MANUFACTURER & 0xff],
    ];
    // Unused bytes read as zero, which is $F inverted.
    this.rom.fill(0xf);
    for (const [offset, value] of description) {
      const invert = offset === 0 ? 0 : 0xf;
      this.rom[offset] = ((value >> 4) & 0xf) ^ invert;
      this.rom[offset + 2] = (value & 0xf) ^ invert;
    }
  }

  reset(): void {
    this.base = -1;
    this.shutUp = false;
    this.lowNibble = 0;
  }

  /** Whether the board answers at this address (in the autoconfig space until it is configured). */
  configures(address: number): boolean {
    return this.base < 0 && !this.shutUp && address >= AUTOCONFIG_START && address < AUTOCONFIG_END;
  }

  holds(address: number): boolean {
    return this.base >= 0 && address >= this.base && address < this.base + this.bytes.length;
  }

  /** A byte of the autoconfig space: the nibble in the top of the even bytes. */
  readConfig(address: number): number {
    if (address & 1) return 0xff;
    const offset = address & 0xfe;
    return offset < this.rom.length ? (this.rom[offset] << 4) | 0x0f : 0xff;
  }

  writeConfig(address: number, value: number): void {
    const offset = address & 0xff;
    if (offset === 0x4a) {
      this.lowNibble = (value >> 4) & 0xf;
    } else if (offset === 0x48) {
      this.base = ((((value >> 4) & 0xf) << 4) | this.lowNibble) << 16;
    } else if (offset === 0x4c) {
      this.shutUp = true;
    }
  }

  read16(address: number): number {
    const a = address - this.base;
    return (this.bytes[a] << 8) | this.bytes[a + 1];
  }

  read8(address: number): number {
    return this.bytes[address - this.base];
  }

  write16(address: number, value: number): void {
    const a = address - this.base;
    this.bytes[a] = value >> 8;
    this.bytes[a + 1] = value;
  }

  write8(address: number, value: number): void {
    this.bytes[address - this.base] = value;
  }
}
