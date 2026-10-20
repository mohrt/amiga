/** Chip RAM, which the CPU shares with the custom chips' DMA; addresses wrap at its size. */
export class ChipRam {
  bytes: Uint8Array;
  /** Masks a DMA pointer to an even address within the RAM. */
  wordMask: number;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.wordMask = (size - 1) & ~1;
  }

  get size(): number {
    return this.bytes.length;
  }

  resize(size: number): void {
    if (size === this.bytes.length) return;
    this.bytes = new Uint8Array(size);
    this.wordMask = (size - 1) & ~1;
  }

  read16(address: number): number {
    const a = address & this.wordMask;
    return (this.bytes[a] << 8) | this.bytes[a + 1];
  }

  write16(address: number, value: number): void {
    const a = address & this.wordMask;
    this.bytes[a] = value >> 8;
    this.bytes[a + 1] = value;
  }

  read8(address: number): number {
    return this.bytes[address & (this.bytes.length - 1)];
  }

  write8(address: number, value: number): void {
    this.bytes[address & (this.bytes.length - 1)] = value;
  }
}
