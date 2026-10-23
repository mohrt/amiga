/** The SDMAC's registers (the low seven address bits; the chip repeats every $80 bytes from $DD0000). */
const PORT_START = 0xdd0000;
const PORT_END = 0xde0000;
const REG_MASK = 0x7f;
const REG_CNTR = 0x0a;
const REG_CINT = 0x1a;
const REG_ISTR = 0x1e;
/** The WD33C93's address register (its auxiliary status when read) and its data register, each twice. */
const WD_ADDRESS = [0x41, 0x49];
const WD_DATA = [0x43, 0x47];

/** CNTR: the SCSI interrupt reaches the CPU. */
const CNTR_INTEN = 0x04;
/** ISTR: the SCSI chip is interrupting, an interrupt is pending, and the (unused) FIFO is empty. */
const ISTR_INTS = 0x40;
const ISTR_INT_P = 0x10;
const ISTR_FE_FLG = 0x01;

/** WD33C93 registers. */
const WD_OWN_ID = 0x00;
const WD_SCSI_STATUS = 0x17;
const WD_COMMAND = 0x18;
const WD_DATA_REG = 0x19;
const WD_AUXILIARY_STATUS = 0x1f;
/** WD33C93 commands: reset, and the four kinds of selection. */
const CMD_RESET = 0x00;
const CMD_SELECT_FIRST = 0x06;
const CMD_SELECT_LAST = 0x09;
/** Its status after a reset (with the advanced features of own ID bit 3), a selection no one answered, and a command it can't do here. */
const CSR_RESET = 0x00;
const CSR_RESET_ADVANCED = 0x01;
const CSR_TIMEOUT = 0x42;
const CSR_INVALID = 0x40;
const OWN_ID_ADVANCED = 0x08;
/** Auxiliary status: an interrupt, and a command in progress. */
const ASR_INT = 0x80;
const ASR_BSY = 0x20;

/** Lines (64 µs) until the chip answers: a reset, and a selection's timeout. */
const RESET_LINES = 2;
const SELECTION_TIMEOUT_LINES = 1000;

/**
 * The A3000's SCSI controller at $DD0000: Commodore's SDMAC with a WD33C93,
 * as far as Kickstart's scsi.device needs with no drive on the bus. Resets
 * finish, every selection times out (as with no device at that ID), and the
 * WD33C93's interrupt reaches Paula as INT2 (PORTS) while CNTR enables it.
 */
export class A3000Scsi {
  private readonly regs = new Uint8Array(0x20);
  private address = 0;
  private cntr = 0;
  /** The WD33C93's interrupt (its auxiliary status), and the SDMAC's copy of it, which CINT clears. */
  private interrupt = false;
  private dmacInterrupt = false;
  /** The status the command in progress ends with, and the lines until it does. */
  private pendingStatus = -1;
  private pendingLines = 0;

  static handles(address: number): boolean {
    return address >= PORT_START && address < PORT_END;
  }

  /** Whether the controller is pulling INT2. */
  get interrupting(): boolean {
    return this.dmacInterrupt && (this.cntr & CNTR_INTEN) !== 0;
  }

  reset(): void {
    this.regs.fill(0);
    this.address = 0;
    this.cntr = 0;
    this.interrupt = this.dmacInterrupt = false;
    this.pendingStatus = -1;
  }

  /** Once a line: the command in progress finishes when its time is up. */
  tick(): void {
    if (this.pendingStatus < 0 || --this.pendingLines > 0) return;
    this.regs[WD_SCSI_STATUS] = this.pendingStatus;
    this.pendingStatus = -1;
    this.interrupt = this.dmacInterrupt = true;
  }

  read8(address: number): number {
    const reg = address & REG_MASK;
    if (WD_ADDRESS.includes(reg)) return this.auxiliaryStatus();
    if (WD_DATA.includes(reg)) return this.readWd();
    const word = this.read16(reg & ~1);
    return reg & 1 ? word & 0xff : word >> 8;
  }

  read16(address: number): number {
    switch (address & REG_MASK & ~1) {
      case REG_CNTR:
        return this.cntr;
      case REG_ISTR:
        return (this.dmacInterrupt ? ISTR_INTS | ISTR_INT_P : 0) | ISTR_FE_FLG;
      case REG_CINT:
        this.dmacInterrupt = false;
        return 0;
      default:
        return 0xffff;
    }
  }

  write8(address: number, value: number): void {
    const reg = address & REG_MASK;
    if (WD_ADDRESS.includes(reg)) this.address = value & 0x1f;
    else if (WD_DATA.includes(reg)) this.writeWd(value & 0xff);
    else this.write16(reg & ~1, reg & 1 ? value & 0xff : (value & 0xff) << 8);
  }

  write16(address: number, value: number): void {
    // The rest (the DMA address, count and start/stop registers) has nothing to move with no drive.
    const reg = address & REG_MASK & ~1;
    if (reg === REG_CNTR) this.cntr = value & 0xff;
    else if (reg === REG_CINT) this.dmacInterrupt = false;
  }

  private auxiliaryStatus(): number {
    return (this.interrupt ? ASR_INT : 0) | (this.pendingStatus >= 0 ? ASR_BSY : 0);
  }

  /** Reading the SCSI status acknowledges the interrupt. Other registers but data, command and status step the address on. */
  private readWd(): number {
    const reg = this.address;
    const value = reg === WD_AUXILIARY_STATUS ? this.auxiliaryStatus() : this.regs[reg];
    if (reg === WD_SCSI_STATUS) this.interrupt = this.dmacInterrupt = false;
    this.step(false);
    return value;
  }

  private writeWd(value: number): void {
    const reg = this.address;
    if (reg !== WD_SCSI_STATUS && reg !== WD_AUXILIARY_STATUS) this.regs[reg] = value;
    if (reg === WD_COMMAND) this.command(value & 0x7f);
    this.step(true);
  }

  private step(write: boolean): void {
    const reg = this.address;
    if (reg === WD_AUXILIARY_STATUS || reg === WD_DATA_REG || reg === WD_COMMAND || (write && reg === WD_SCSI_STATUS)) return;
    this.address = (reg + 1) & 0x1f;
  }

  private command(command: number): void {
    if (command === CMD_RESET) {
      const ownId = this.regs[WD_OWN_ID];
      this.regs.fill(0, 1, WD_SCSI_STATUS);
      this.regs[WD_COMMAND] = 0;
      this.finishIn(ownId & OWN_ID_ADVANCED ? CSR_RESET_ADVANCED : CSR_RESET, RESET_LINES);
    } else if (command >= CMD_SELECT_FIRST && command <= CMD_SELECT_LAST) {
      this.finishIn(CSR_TIMEOUT, SELECTION_TIMEOUT_LINES);
    } else {
      this.finishIn(CSR_INVALID, RESET_LINES);
    }
  }

  private finishIn(status: number, lines: number): void {
    this.pendingStatus = status;
    this.pendingLines = lines;
  }
}
