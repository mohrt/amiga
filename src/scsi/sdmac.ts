import { cdbLength, type ScsiCommand, type ScsiDisk } from './disk';

/** The SDMAC's registers (the low seven address bits; the chip repeats every $80 bytes from $DD0000). */
const PORT_START = 0xdd0000;
const PORT_END = 0xde0000;
const REG_MASK = 0x7f;
const REG_CNTR = 0x0a;
const REG_ACR_HIGH = 0x0c;
const REG_ACR_LOW = 0x0e;
const REG_ST_DMA = 0x12;
const REG_CINT = 0x1a;
const REG_ISTR = 0x1e;
const REG_SP_DMA = 0x3e;
/** The WD33C93's address register (its auxiliary status when read) and its data register, each twice. */
const WD_ADDRESS = [0x41, 0x49];
const WD_DATA = [0x43, 0x47];

/** CNTR: the SCSI interrupt reaches the CPU. */
const CNTR_INTEN = 0x04;
/** ISTR: the SCSI chip is interrupting, an interrupt is pending, and the FIFO is empty. */
const ISTR_INTS = 0x40;
const ISTR_INT_P = 0x10;
const ISTR_FE_FLG = 0x01;

/** WD33C93 registers. */
const WD_OWN_ID = 0x00;
const WD_CONTROL = 0x01;
const WD_CDB = 0x03;
const WD_TARGET_LUN = 0x0f;
const WD_COMMAND_PHASE = 0x10;
const WD_TRANSFER_COUNT = 0x12;
const WD_DESTINATION_ID = 0x15;
const WD_SCSI_STATUS = 0x17;
const WD_COMMAND = 0x18;
const WD_DATA_REG = 0x19;
const WD_AUXILIARY_STATUS = 0x1f;
/** CONTROL: the DMA mode bits (none is polled I/O), and the ending disconnect interrupt. */
const CONTROL_DMA_MODE = 0xe0;
const CONTROL_EDI = 0x08;
const OWN_ID_ADVANCED = 0x08;

/** WD33C93 commands (bit 7 makes a transfer a single byte). */
const CMD_RESET = 0x00;
const CMD_ABORT = 0x01;
const CMD_ASSERT_ATN = 0x02;
const CMD_NEGATE_ACK = 0x03;
const CMD_DISCONNECT = 0x04;
const CMD_SELECT_ATN = 0x06;
const CMD_SELECT = 0x07;
const CMD_SELECT_ATN_TRANSFER = 0x08;
const CMD_SELECT_TRANSFER = 0x09;
const CMD_TRANSFER_INFO = 0x20;
const CMD_TRANSFER_PAD = 0x21;
const CMD_SINGLE_BYTE = 0x80;

/** Interrupt statuses: reset, selected, a phase finished (with the next phase), select-and-transfer done, and the rest. */
const CSR_RESET = 0x00;
const CSR_RESET_ADVANCED = 0x01;
const CSR_SELECT = 0x11;
const CSR_SEL_XFER_DONE = 0x16;
const CSR_XFER_DONE = 0x18;
const CSR_MSGIN = 0x20;
const CSR_INVALID = 0x40;
const CSR_TIMEOUT = 0x42;
const CSR_UNEXPECTED = 0x48;
const CSR_DISCONNECT = 0x85;
const CSR_SERVICE_REQUIRED = 0x88;
/** SCSI bus phases, in the low bits of a status. */
const PHASE_DATA_OUT = 0x00;
const PHASE_DATA_IN = 0x01;
const PHASE_COMMAND = 0x02;
const PHASE_STATUS = 0x03;
const PHASE_MESSAGE_OUT = 0x06;
const PHASE_MESSAGE_IN = 0x07;
/** The message a target ends a command with. */
const MESSAGE_COMMAND_COMPLETE = 0x00;
/** Auxiliary status: an interrupt, busy with a command, and a byte waiting in the data register. */
const ASR_INT = 0x80;
const ASR_BSY = 0x20;
const ASR_DBR = 0x01;

/** Lines (64 µs) until the chip answers: most steps, and a selection's timeout. */
const STEP_LINES = 2;
const SELECTION_TIMEOUT_LINES = 1000;

/** The host's memory, as the SDMAC reaches it (without waiting for the chip bus). */
export interface DmaMemory {
  read8(address: number): number;
  write8(address: number, value: number): void;
}

/**
 * The A3000's SCSI controller at $DD0000: Commodore's SDMAC with a WD33C93,
 * and the drives on its bus (a hard disk at ID 0, if there is one). The
 * WD33C93 runs the selection, then each bus phase in turn (message out,
 * command, data, status, message in) for TRANSFER INFO, or the whole command
 * for SELECT-AND-TRANSFER; data moves by the SDMAC's DMA or through the data
 * register. Each phase ends with an interrupt status, given once the last one
 * has been read; the interrupt reaches Paula as INT2 (PORTS) while CNTR enables it.
 */
export class A3000Scsi {
  /** The drives, by SCSI ID. */
  readonly drives: (ScsiDisk | null)[] = new Array(8).fill(null);
  private readonly regs = new Uint8Array(0x20);
  private address = 0;
  private cntr = 0;
  private acr = 0;
  private dmaRunning = false;
  /** The WD33C93's interrupt (its auxiliary status), and the SDMAC's copy of it, which CINT clears. */
  private interrupt = false;
  private dmacInterrupt = false;
  private busy = false;
  /** Interrupt statuses waiting to be given, each after so many lines. */
  private readonly queue: { status: number; lines: number }[] = [];

  /** The drive selected, its logical unit, and the bus phase it wants next. */
  private target: ScsiDisk | null = null;
  private lun = 0;
  private busPhase = -1;
  private readonly cdb = new Uint8Array(16);
  private cdbBytes = 0;
  private command: ScsiCommand | null = null;
  /** The data phase's bytes and how many have moved. */
  private data: Uint8Array = new Uint8Array(0);
  private dataOffset = 0;
  /** A transfer waiting to be made: by DMA once the SDMAC runs, or byte by byte through the data register. */
  private transferLeft = 0;
  private transferByDma = false;
  private polled = false;

  constructor(private readonly memory: DmaMemory) {}

  static handles(address: number): boolean {
    return address >= PORT_START && address < PORT_END;
  }

  /** The hard disk at ID 0. */
  get disk(): ScsiDisk | null {
    return this.drives[0];
  }

  /** Whether the controller is pulling INT2. */
  get interrupting(): boolean {
    return this.dmacInterrupt && (this.cntr & CNTR_INTEN) !== 0;
  }

  reset(): void {
    this.regs.fill(0);
    this.address = 0;
    this.cntr = 0;
    this.acr = 0;
    this.dmaRunning = false;
    this.interrupt = this.dmacInterrupt = this.busy = false;
    this.queue.length = 0;
    this.disconnect();
  }

  /** Once a line: a DMA transfer the SDMAC is ready for, and the next interrupt status when its time is up. */
  tick(): void {
    for (const drive of this.drives) drive?.tick();
    if (this.transferLeft > 0 && this.transferByDma && this.dmaRunning) this.transferByDmaNow();
    if (this.interrupt || this.queue.length === 0) return;
    const next = this.queue[0];
    if (--next.lines > 0) return;
    this.queue.shift();
    this.regs[WD_SCSI_STATUS] = next.status;
    this.interrupt = this.dmacInterrupt = true;
    this.busy = this.queue.length > 0 || this.transferLeft > 0;
  }

  // --- The SDMAC's registers ------------------------------------------------------

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
      case REG_ACR_HIGH:
        return this.acr >>> 16;
      case REG_ACR_LOW:
        return this.acr & 0xffff;
      case REG_ISTR:
        return (this.dmacInterrupt ? ISTR_INTS | ISTR_INT_P : 0) | ISTR_FE_FLG;
      case REG_ST_DMA:
        this.dmaRunning = true;
        return 0;
      case REG_SP_DMA:
        this.dmaRunning = false;
        return 0;
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
    switch (address & REG_MASK & ~1) {
      case REG_CNTR:
        this.cntr = value & 0xff;
        break;
      case REG_ACR_HIGH:
        this.acr = ((value << 16) | (this.acr & 0xffff)) >>> 0;
        break;
      case REG_ACR_LOW:
        this.acr = ((this.acr & 0xffff0000) | (value & 0xfffe)) >>> 0;
        break;
      case REG_ST_DMA:
        this.dmaRunning = true;
        break;
      case REG_SP_DMA:
        this.dmaRunning = false;
        break;
      case REG_CINT:
        this.dmacInterrupt = false;
        break;
    }
  }

  // --- The WD33C93's registers ----------------------------------------------------

  private auxiliaryStatus(): number {
    return (this.interrupt ? ASR_INT : 0) | (this.busy ? ASR_BSY : 0) | (this.polled && this.transferLeft > 0 ? ASR_DBR : 0);
  }

  /** Reading the SCSI status acknowledges the interrupt. Other registers but data, command and status step the address on. */
  private readWd(): number {
    const reg = this.address;
    let value = reg === WD_AUXILIARY_STATUS ? this.auxiliaryStatus() : this.regs[reg];
    if (reg === WD_SCSI_STATUS) this.interrupt = this.dmacInterrupt = false;
    if (reg === WD_DATA_REG && this.polled && this.transferLeft > 0) value = this.regs[WD_DATA_REG] = this.moveIn();
    this.step(false);
    return value;
  }

  private writeWd(value: number): void {
    const reg = this.address;
    if (reg !== WD_SCSI_STATUS && reg !== WD_AUXILIARY_STATUS) this.regs[reg] = value;
    if (reg === WD_COMMAND) this.runCommand(value);
    else if (reg === WD_DATA_REG && this.polled && this.transferLeft > 0) this.moveOut(value);
    this.step(true);
  }

  private step(write: boolean): void {
    const reg = this.address;
    if (reg === WD_AUXILIARY_STATUS || reg === WD_DATA_REG || reg === WD_COMMAND || (write && reg === WD_SCSI_STATUS)) return;
    this.address = (reg + 1) & 0x1f;
  }

  private get transferCount(): number {
    return (this.regs[WD_TRANSFER_COUNT] << 16) | (this.regs[WD_TRANSFER_COUNT + 1] << 8) | this.regs[WD_TRANSFER_COUNT + 2];
  }

  private set transferCount(count: number) {
    this.regs[WD_TRANSFER_COUNT] = count >> 16;
    this.regs[WD_TRANSFER_COUNT + 1] = count >> 8;
    this.regs[WD_TRANSFER_COUNT + 2] = count;
  }

  private finish(status: number, lines = STEP_LINES): void {
    this.queue.push({ status, lines });
  }

  private disconnect(): void {
    this.target = null;
    this.busPhase = -1;
    this.command = null;
    this.transferLeft = 0;
    this.polled = false;
  }

  // --- Commands ------------------------------------------------------------------

  private runCommand(value: number): void {
    const command = value & 0x7f;
    this.busy = true;
    switch (command) {
      case CMD_RESET: {
        const ownId = this.regs[WD_OWN_ID];
        this.regs.fill(0, 1, WD_SCSI_STATUS);
        this.regs[WD_COMMAND] = 0;
        this.queue.length = 0;
        this.disconnect();
        this.finish(ownId & OWN_ID_ADVANCED ? CSR_RESET_ADVANCED : CSR_RESET);
        break;
      }
      case CMD_ABORT:
      case CMD_ASSERT_ATN:
      case CMD_DISCONNECT:
        if (command === CMD_DISCONNECT) this.disconnect();
        this.busy = false;
        break;
      case CMD_NEGATE_ACK:
        // After the command complete message, the target lets the bus go.
        if (this.busPhase === -2) {
          this.disconnect();
          this.regs[WD_COMMAND_PHASE] = 0x60;
          this.finish(CSR_DISCONNECT, 1);
        } else {
          this.busy = false;
        }
        break;
      case CMD_SELECT_ATN:
      case CMD_SELECT:
        this.select(command === CMD_SELECT_ATN);
        break;
      case CMD_SELECT_ATN_TRANSFER:
      case CMD_SELECT_TRANSFER:
        this.selectAndTransfer();
        break;
      case CMD_TRANSFER_INFO:
      case CMD_TRANSFER_PAD:
        this.transferInfo((value & CMD_SINGLE_BYTE) !== 0);
        break;
      default:
        this.finish(CSR_INVALID);
    }
  }

  private selectedDrive(): ScsiDisk | null {
    const id = this.regs[WD_DESTINATION_ID] & 7;
    return id === 7 ? null : this.drives[id];
  }

  private select(attention: boolean): void {
    this.disconnect();
    const drive = this.selectedDrive();
    if (!drive) {
      this.finish(CSR_TIMEOUT, SELECTION_TIMEOUT_LINES);
      return;
    }
    this.target = drive;
    this.lun = this.regs[WD_TARGET_LUN] & 7;
    this.cdbBytes = 0;
    this.finish(CSR_SELECT);
    // With ATN the target asks for the identify message first; without, for the command.
    this.busPhase = attention ? PHASE_MESSAGE_OUT : PHASE_COMMAND;
    this.regs[WD_COMMAND_PHASE] = attention ? 0x10 : 0x20;
    this.finish(CSR_SERVICE_REQUIRED | this.busPhase, 4);
  }

  /** SELECT-AND-TRANSFER: the CDB from the registers, the data by DMA, the status into TARGET LUN. */
  private selectAndTransfer(): void {
    this.disconnect();
    const drive = this.selectedDrive();
    if (!drive) {
      this.regs[WD_COMMAND_PHASE] = 0;
      this.finish(CSR_TIMEOUT, SELECTION_TIMEOUT_LINES);
      return;
    }
    const cdb = this.regs.slice(WD_CDB, WD_CDB + cdbLength(this.regs[WD_CDB]));
    const result = drive.execute(cdb, this.regs[WD_TARGET_LUN] & 7);
    let count = this.transferCount;
    if (result.dataIn) {
      const length = Math.min(count, result.dataIn.length);
      for (let i = 0; i < length; i++) this.memory.write8(this.acr + i, result.dataIn[i]);
      this.acr = (this.acr + length) >>> 0;
      count -= length;
    } else if (result.dataOutLength) {
      const length = Math.min(count, result.dataOutLength);
      const data = new Uint8Array(result.dataOutLength);
      for (let i = 0; i < length; i++) data[i] = this.memory.read8(this.acr + i);
      this.acr = (this.acr + length) >>> 0;
      count -= length;
      if (length === result.dataOutLength) result.onDataOut?.(data);
    }
    this.transferCount = count;
    this.regs[WD_TARGET_LUN] = result.status;
    this.regs[WD_COMMAND_PHASE] = 0x60;
    this.finish(CSR_SEL_XFER_DONE);
    if (!(this.regs[WD_CONTROL] & CONTROL_EDI)) this.finish(CSR_DISCONNECT, 1);
  }

  /** TRANSFER INFO: moves the bytes of the phase the target is in. */
  private transferInfo(singleByte: boolean): void {
    if (!this.target || this.busPhase < 0) {
      this.finish(CSR_UNEXPECTED | PHASE_STATUS);
      return;
    }
    const count = singleByte ? 1 : this.transferCount || 1;
    if (this.busPhase === PHASE_DATA_IN || this.busPhase === PHASE_DATA_OUT) this.regs[WD_COMMAND_PHASE] = 0x45;
    else if (this.busPhase === PHASE_STATUS) this.regs[WD_COMMAND_PHASE] = 0x46;
    else if (this.busPhase === PHASE_MESSAGE_IN) this.regs[WD_COMMAND_PHASE] = 0x50;
    else if (this.busPhase === PHASE_COMMAND) this.regs[WD_COMMAND_PHASE] = 0x30;
    this.transferLeft = count;
    this.transferByDma = (this.regs[WD_CONTROL] & CONTROL_DMA_MODE) !== 0;
    this.polled = !this.transferByDma;
    if (this.transferByDma && this.dmaRunning) this.transferByDmaNow();
  }

  private transferByDmaNow(): void {
    while (this.transferLeft > 0) {
      if (this.busPhase === PHASE_DATA_OUT || this.busPhase === PHASE_COMMAND || this.busPhase === PHASE_MESSAGE_OUT) {
        this.moveOut(this.memory.read8(this.acr));
      } else {
        this.memory.write8(this.acr, this.moveIn());
      }
      this.acr = (this.acr + 1) >>> 0;
    }
  }

  /** A byte from the target to the host, in the phase it is in. */
  private moveIn(): number {
    let value = 0;
    if (this.busPhase === PHASE_DATA_IN) value = this.data[this.dataOffset++] ?? 0;
    else if (this.busPhase === PHASE_STATUS) value = this.command?.status ?? 0;
    else if (this.busPhase === PHASE_MESSAGE_IN) value = MESSAGE_COMMAND_COMPLETE;
    this.byteMoved();
    return value;
  }

  /** A byte from the host to the target. */
  private moveOut(value: number): void {
    if (this.busPhase === PHASE_MESSAGE_OUT) this.lun = value & 7;
    else if (this.busPhase === PHASE_COMMAND) this.cdb[this.cdbBytes++] = value;
    else if (this.busPhase === PHASE_DATA_OUT) this.data[this.dataOffset++] = value;
    this.byteMoved();
  }

  /** Counts a byte off the transfer; the phase ends when the data does, and the transfer when its count does. */
  private byteMoved(): void {
    this.transferLeft--;
    const count = this.transferCount;
    if (count > 0) this.transferCount = count - 1;
    const phaseDone = this.phaseComplete();
    if (phaseDone) {
      const leftOver = this.transferLeft;
      this.transferLeft = 0;
      this.polled = false;
      this.nextPhase(leftOver);
    } else if (this.transferLeft === 0) {
      this.polled = false;
      this.finish(CSR_XFER_DONE | this.busPhase);
    }
  }

  private phaseComplete(): boolean {
    switch (this.busPhase) {
      case PHASE_COMMAND:
        return this.cdbBytes >= cdbLength(this.cdb[0]);
      case PHASE_DATA_IN:
      case PHASE_DATA_OUT:
        return this.dataOffset >= this.data.length;
      default:
        return true;
    }
  }

  /** The target moves on to its next phase; the status says which, or that the host wanted more than there was. */
  private nextPhase(leftOver: number): void {
    const done = leftOver > 0 ? CSR_UNEXPECTED : CSR_XFER_DONE;
    switch (this.busPhase) {
      case PHASE_MESSAGE_OUT:
        this.busPhase = PHASE_COMMAND;
        this.regs[WD_COMMAND_PHASE] = 0x20;
        break;
      case PHASE_COMMAND: {
        const result = this.target!.execute(this.cdb.slice(0, this.cdbBytes), this.lun);
        this.command = result;
        this.dataOffset = 0;
        if (result.dataIn?.length) {
          this.data = result.dataIn;
          this.busPhase = PHASE_DATA_IN;
        } else if (result.dataOutLength) {
          this.data = new Uint8Array(result.dataOutLength);
          this.busPhase = PHASE_DATA_OUT;
        } else {
          this.busPhase = PHASE_STATUS;
        }
        this.regs[WD_COMMAND_PHASE] = this.busPhase === PHASE_STATUS ? 0x46 : 0x45;
        break;
      }
      case PHASE_DATA_OUT:
        this.command?.onDataOut?.(this.data);
        this.busPhase = PHASE_STATUS;
        this.regs[WD_COMMAND_PHASE] = 0x46;
        break;
      case PHASE_DATA_IN:
        this.busPhase = PHASE_STATUS;
        this.regs[WD_COMMAND_PHASE] = 0x46;
        break;
      case PHASE_STATUS:
        this.regs[WD_TARGET_LUN] = this.command?.status ?? 0;
        this.busPhase = PHASE_MESSAGE_IN;
        this.regs[WD_COMMAND_PHASE] = 0x50;
        break;
      case PHASE_MESSAGE_IN:
        // The message came in with ACK held; NEGATE ACK lets the target go on (and disconnect).
        this.busPhase = -2;
        this.finish(CSR_MSGIN, 1);
        return;
    }
    this.finish(done | this.busPhase, 1);
  }
}
