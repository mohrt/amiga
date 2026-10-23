/** The 24C08's device code in the top four bits of the address byte; bits 2-1 pick the 256-byte block. */
const DEVICE_CODE = 0xa0;
/** It writes up to 16 bytes at a time, within an aligned 16-byte page. */
const PAGE_BYTES = 16;

/**
 * The CD32's 1 KB save memory: a 24C08 EEPROM on an I2C bus that software
 * drives by hand through Akiko. After a start condition the chip takes its
 * address byte, then a word address and bytes to write (kept at the stop), or
 * with the read bit sends bytes from where the last address left it. It
 * samples a bit on each rising clock, puts its own bits out while the clock
 * is low, and acknowledges each byte it takes by pulling SDA low.
 */
export class I2cEeprom {
  readonly bytes: Uint8Array;
  /** Set when a write has changed the contents, for the page to keep them. */
  changed = false;
  private scl = true;
  private sda = true;
  /** SDA as the chip drives it (true is released). */
  private out = true;
  private mode: 'idle' | 'receive' | 'transmit' = 'idle';
  private phase: 'device' | 'word' | 'data' = 'device';
  private shift = 0;
  private bit = 0;
  private acknowledging = false;
  private readMode = false;
  /** Where reads and writes go: the block and the address in it. */
  private block = 0;
  private address = 0;
  private readonly pending: { at: number; value: number }[] = [];

  constructor(size = 1024) {
    this.bytes = new Uint8Array(size).fill(0xff);
  }

  /** SDA as the bus has it: low if either side pulls it low. */
  get dataLine(): boolean {
    return this.sda && this.out;
  }

  /** The master's lines (true is released, high). */
  setLines(scl: boolean, sda: boolean): void {
    if (this.scl && scl && sda !== this.sda) {
      // SDA changing while SCL is high: a start (falling) or a stop (rising).
      this.sda = sda;
      if (sda) this.stop();
      else this.start();
      return;
    }
    const rising = !this.scl && scl;
    const falling = this.scl && !scl;
    this.scl = scl;
    this.sda = sda;
    if (rising) this.clockRise();
    if (falling) this.clockFall();
  }

  private start(): void {
    this.commit();
    this.mode = 'receive';
    this.phase = 'device';
    this.shift = this.bit = 0;
    this.acknowledging = false;
    this.out = true;
  }

  private stop(): void {
    this.commit();
    this.mode = 'idle';
    this.out = true;
  }

  /** A write's bytes reach the cells at the stop. */
  private commit(): void {
    for (const { at, value } of this.pending) {
      if (this.bytes[at] !== value) this.changed = true;
      this.bytes[at] = value;
    }
    this.pending.length = 0;
  }

  private get location(): number {
    return ((this.block << 8) | this.address) % this.bytes.length;
  }

  private clockRise(): void {
    if (this.mode === 'receive' && !this.acknowledging && this.bit < 8) {
      this.shift = ((this.shift << 1) | (this.sda ? 1 : 0)) & 0xff;
      this.bit++;
    } else if (this.mode === 'transmit' && this.bit === 9) {
      // The master's acknowledge: low for another byte, high for no more.
      if (this.sda) this.mode = 'idle';
      else this.bit = 0;
    }
  }

  private clockFall(): void {
    if (this.mode === 'receive') {
      if (this.acknowledging) {
        this.acknowledging = false;
        this.out = true;
        this.shift = this.bit = 0;
        if (this.readMode) {
          this.mode = 'transmit';
          this.sendBit();
        }
      } else if (this.bit === 8) {
        if (this.take(this.shift)) {
          this.acknowledging = true;
          this.out = false;
        } else {
          this.mode = 'idle';
        }
      }
    } else if (this.mode === 'transmit') {
      this.sendBit();
    }
  }

  /** A byte from the master: the device address, the word address, or data. False if the chip doesn't answer it. */
  private take(byte: number): boolean {
    if (this.phase === 'device') {
      if ((byte & 0xf0) !== DEVICE_CODE) return false;
      this.block = (byte >> 1) & 3;
      this.readMode = (byte & 1) !== 0;
      this.phase = 'word';
      return true;
    }
    if (this.phase === 'word') {
      this.address = byte;
      this.phase = 'data';
      return true;
    }
    this.pending.push({ at: this.location, value: byte });
    const page = this.address & ~(PAGE_BYTES - 1);
    this.address = page | ((this.address + 1) & (PAGE_BYTES - 1));
    return true;
  }

  /** While the clock is low: the next bit of the byte being sent, then SDA let go for the master's acknowledge. */
  private sendBit(): void {
    if (this.bit === 0) this.shift = this.bytes[this.location];
    if (this.bit < 8) {
      this.out = ((this.shift >> (7 - this.bit)) & 1) === 1;
      this.bit++;
      if (this.bit === 8) {
        this.address = (this.address + 1) & 0xff;
        if (this.address === 0) this.block = (this.block + 1) & 3;
      }
    } else if (this.bit === 8) {
      this.out = true;
      this.bit = 9;
    }
  }
}
