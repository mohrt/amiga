import { Agnus, CCK_HZ, type VideoStandard } from './agnus/agnus';
import { Cia8520 } from './cia/cia8520';
import { M68k } from './cpu/m68k';
import { Int, Reg } from './custom/registers';
import { Denise } from './denise/denise';
import type { FloppyDisk } from './drive/adf';
import { FloppyDrive } from './drive/floppy';
import { A4000Ide } from './ide/a4000-ide';
import { ScsiDisk } from './scsi/disk';
import { A3000Scsi } from './scsi/sdmac';
import { Akiko } from './cd32/akiko';
import { Gayle } from './ide/gayle';
import type { HardDiskImage } from './ide/image';
import { RealTimeClock } from './io/clock';
import { AmigaKeyboard } from './io/keyboard';
import { ControlPorts } from './io/ports';
import { AmigaBus } from './memory/bus';
import { ChipRam } from './memory/chip-ram';
import { ZorroRam } from './memory/zorro';
import { DEFAULT_MODEL, modelById, type ModelSpec } from './models';
import { Paula } from './paula/paula';
import { captureState, restoreState, type StateNode } from './state/snapshot';

export type { VideoStandard } from './agnus/agnus';

export interface MemoryConfig {
  chipKb: 256 | 512 | 1024 | 2048;
  /** The trapdoor expansion's "slow" RAM at $C00000. */
  slowKb: 0 | 512;
  /** Fast RAM: on a Zorro II board (autoconfigured at $200000), or on the A4000's main board (up to $8000000). */
  fastKb: 0 | 2048 | 4096 | 8192 | 16384;
}

const CPU_RATIO: Record<ModelSpec['cpu'], number> = { '68000': 2, '68ec020': 4, '68030': 7 };

export const DEFAULT_MEMORY: MemoryConfig = { chipKb: 512, slowKb: 512, fastKb: 0 };

/** Which chip's part of a register a delayed write is for (0 for the whole register). */
const PART_AGNUS = 1;
const PART_DENISE = 2;
/** E-clock ticks (for the CIAs) come every 5 colour clocks. */
const CCKS_PER_E_TICK = 5;
const ROM_SPACE = 0x80000;

/**
 * An Amiga (an A500 unless setModel says otherwise): a 68000, the OCS or ECS
 * chipset (Agnus with the Copper and blitter, Denise, Paula), two 8520 CIAs,
 * chip RAM with optional slow and fast RAM, the Kickstart ROM, the keyboard,
 * the control ports and the floppy drives (DF0 inside, DF1 optional). The chips
 * run in colour clocks; the CPU runs an instruction at a time and the chips are
 * brought up to its time whenever it touches the chip bus.
 */
export class Amiga {
  /** Which Amiga this is (set with setModel, before a power on). */
  model: ModelSpec = modelById(DEFAULT_MODEL);
  readonly chip = new ChipRam(DEFAULT_MEMORY.chipKb * 1024);
  slow = new Uint8Array(DEFAULT_MEMORY.slowKb * 1024);
  /** A Zorro II fast RAM board, if there is one. */
  zorro: ZorroRam | null = null;
  /** The A3000's and A4000's 32-bit fast RAM on the main board, which Ramsey puts just below $8000000. */
  motherboardRam = new Uint8Array(0);
  /** Gary's timeout, timeout-enable and cold-boot bits, and Ramsey's control register (A3000 and A4000). */
  readonly gary = new Uint8Array(3);
  ramseyControl = 0;
  /** The A3000's SCSI controller. */
  scsi: A3000Scsi | null = null;
  /** The CD32's Akiko chip, with its CD drive. */
  akiko: Akiko | null = null;
  /** The battery-backed clock of the models that have one. */
  clock: RealTimeClock | null = null;
  /** The Kickstart, filling the 512K at $F80000 (a 256K ROM twice). */
  readonly rom = new Uint8Array(ROM_SPACE);
  /** A ROM at $E00000 (AROS has one). */
  extendedRom: Uint8Array | null = null;
  /** The A600-style IDE port and its drive, when a hard disk is attached. */
  gayle: Gayle | A4000Ide | null = null;
  readonly denise = new Denise();
  readonly drives = [new FloppyDrive(true), new FloppyDrive(false), new FloppyDrive(false), new FloppyDrive(false)];
  readonly ports = new ControlPorts();
  readonly paula: Paula;
  readonly agnus: Agnus;
  readonly ciaA: Cia8520;
  readonly ciaB: Cia8520;
  readonly keyboard: AmigaKeyboard;
  readonly bus = new AmigaBus(this);
  readonly cpu = new M68k(this.bus);
  /** The ROM is mapped over chip RAM at $000000 (until CIA-A's OVL line goes low). */
  overlay = true;
  /** On the CD32, CIA-A's PA0 is the overlay only until boot first turns it off; then it switches the CD audio. */
  private cd32OverlayDone = false;
  /** The power light (also the audio filter's switch). */
  powerLed = false;
  private eClock = CCKS_PER_E_TICK;
  /** Paula's interrupt level over the last three cycles (a byte each, newest lowest): the CPU's pins follow three cycles behind. */
  private interruptPipe = 0;
  private sampleRate = 48000;
  /** Called with each finished picture: 720 pixels wide and `rows` tall. */
  onFrame: (framebuffer: Uint32Array, rows: number) => void = () => {};

  constructor() {
    const amiga = this;
    this.paula = new Paula(this.chip, this.drives, {
      audioDma: (channel) => this.audioDma(channel),
      get diskDma() {
        return amiga.diskDma;
      },
      indexPulse: () => this.ciaB.pulseFlag(),
      heldInterrupts: () =>
        (this.ciaA.interrupt || this.scsi?.interrupting || this.akiko?.interrupting ? Int.PORTS : 0) | (this.ciaB.interrupt ? Int.EXTER : 0),
    });
    this.agnus = new Agnus(this.chip, this.denise, {
      writeRegister: (reg, value) => this.writeCustom(reg, value),
      onLine: () => {
        this.ciaB.countEvent();
        this.keyboard.tick();
        this.gayle?.tick();
        this.scsi?.tick();
        this.akiko?.tick();
        if (this.scsi?.interrupting || this.akiko?.interrupting) this.paula.raise(Int.PORTS);
      },
      onFrame: () => {
        this.ciaA.countEvent();
        this.paula.raise(Int.VERTB);
        this.onFrame(this.denise.framebuffer, this.denise.outputLines * 2);
      },
      get diskDma() {
        return amiga.diskDma;
      },
      audioDma: (channel) => this.audioDma(channel),
      tick: () => this.tickChips(),
      applyDelayedWrite: (reg, value, part) => this.applyWrite(reg, value, part),
    });
    this.ciaA = new Cia8520({
      readPortA: () => 0x03 | this.paula.floppy.readStatus() | this.ports.fireBits(),
      onOutputChange: () => this.ciaAOutputChanged(),
      // The handshake is a pulse on the data line: the serial port switched to output and back.
      onSerialDirection: (output) => {
        if (!output) this.keyboard.handshake();
      },
    });
    this.ciaB = new Cia8520({ onOutputChange: () => this.paula.floppy.writeControl(this.ciaB.portBOutput) });
    this.agnus.onBlitDone = () => this.paula.raiseNextCycle(Int.BLIT);
    this.ciaA.onInterrupt = () => this.paula.raise(Int.PORTS);
    this.ciaB.onInterrupt = () => this.paula.raise(Int.EXTER);
    this.keyboard = new AmigaKeyboard(
      (byte) => this.ciaA.receiveSerial(byte),
      () => this.reset(),
    );
  }

  get standard(): VideoStandard {
    return this.agnus.standard;
  }

  /** CPU cycles per colour clock: the 68000 runs at twice the colour clock, the A1200's 68EC020 at four times, the 68030 at seven (25 MHz). */
  get cpuRatio(): number {
    return CPU_RATIO[this.model.cpu];
  }

  get clockHz(): number {
    return CCK_HZ[this.standard];
  }

  get hasKickstart(): boolean {
    return this.rom[0] === 0x11;
  }

  private get dmaOn(): boolean {
    return (this.agnus.dmacon & 0x0200) !== 0;
  }

  private get diskDma(): boolean {
    return this.dmaOn && (this.agnus.dmacon & 0x0010) !== 0;
  }

  private audioDma(channel: number): boolean {
    return this.dmaOn && (this.agnus.dmacon & (1 << channel)) !== 0;
  }

  private ciaAOutputChanged(): void {
    const output = this.ciaA.portAOutput;
    if (this.akiko && this.cd32OverlayDone) {
      this.akiko.audioOn = (output & 0x01) !== 0;
    } else {
      this.overlay = (output & 0x01) !== 0;
      if (this.akiko && !this.overlay) this.cd32OverlayDone = true;
    }
    this.powerLed = (output & 0x02) === 0;
    this.paula.audio.ledFilter = this.powerLed;
    this.ports.writePortA(output, this.ciaA.portADirection);
  }

  private tickChips(): void {
    this.interruptPipe = ((this.interruptPipe << 8) | this.paula.level) & 0xffffff;
    this.cpu.irqLevel = this.interruptPipe >>> 16;
    this.paula.applyPending();
    this.paula.audio.tick();
    this.paula.floppy.tick();
    if (--this.eClock === 0) {
      this.eClock = CCKS_PER_E_TICK;
      this.ciaA.tick(1);
      this.ciaB.tick(1);
    }
  }

  // --- Setup -------------------------------------------------------------------------

  /** Puts a Kickstart (256K or 512K) in, with the extended ROM at $E00000 it may have (the CD32's); takes effect at the next power on. */
  setKickstart(rom: Uint8Array, extended: Uint8Array | null = null): void {
    this.extendedRom = extended;
    if (rom.length === ROM_SPACE / 2) {
      this.rom.set(rom, 0);
      this.rom.set(rom, ROM_SPACE / 2);
    } else {
      this.rom.set(rom.subarray(0, ROM_SPACE));
    }
  }

  /** Makes the machine this model (its chips and clock); takes effect at the next power on. */
  setModel(model: ModelSpec): void {
    this.model = model;
    const ecs = model.chipset !== 'ocs';
    const aga = model.chipset === 'aga';
    this.agnus.setChipset(ecs, aga);
    this.cpu.setModel(model.cpu);
    this.cpu.setFpu(!!model.fpu);
    this.denise.ecs = ecs;
    this.denise.aga = aga;
    this.clock = model.clock ? (this.clock ?? new RealTimeClock()) : null;
    if (this.gayle instanceof Gayle) this.gayle.aga = aga;
    this.scsi = model.scsi ? (this.scsi ?? new A3000Scsi(this.bus.dmaMemory)) : null;
    this.akiko = model.cd32 ? (this.akiko ?? new Akiko(this.bus.dmaMemory, () => this.agnus.frameLines)) : null;
    this.paula.audio.extraSource = this.akiko;
    this.ports.cd32Pad = !!model.cd32;
    // The CD32 has no floppy drive.
    this.drives[0].connected = !model.cd32;
  }

  setMemory(config: MemoryConfig): void {
    this.chip.resize(config.chipKb * 1024);
    if (this.slow.length !== config.slowKb * 1024) this.slow = new Uint8Array(config.slowKb * 1024);
    // The A3000's and A4000's fast RAM is on the main board; the others' is on a Zorro II board.
    const onBoard = this.model.ramsey !== undefined;
    const boardKb = onBoard ? 0 : config.fastKb;
    if ((this.zorro?.bytes.length ?? 0) !== boardKb * 1024) this.zorro = boardKb ? new ZorroRam(boardKb) : null;
    const mainKb = onBoard ? config.fastKb : 0;
    if (this.motherboardRam.length !== mainKb * 1024) this.motherboardRam = new Uint8Array(mainKb * 1024);
  }

  get memory(): MemoryConfig {
    return {
      chipKb: (this.chip.size / 1024) as MemoryConfig['chipKb'],
      slowKb: (this.slow.length / 1024) as MemoryConfig['slowKb'],
      fastKb: ((this.zorro?.bytes.length ?? this.motherboardRam.length) / 1024) as MemoryConfig['fastKb'],
    };
  }

  setStandard(standard: VideoStandard): void {
    this.agnus.setStandard(standard);
    this.paula.audio.setRates(CCK_HZ[standard], this.sampleRate);
  }

  setSampleRate(rate: number): void {
    this.sampleRate = rate;
    this.paula.audio.setRates(this.clockHz, rate);
  }

  /** Whether the external drive DF1 is plugged in (takes effect at the next power on, when Kickstart looks for drives). */
  setExternalDrive(connected: boolean): void {
    this.drives[1].connected = connected;
    if (!connected) this.drives[1].eject();
  }

  /** Attaches a hard disk on an A600-style IDE port (null takes it away); Kickstart looks for it at power on. */
  attachHardDisk(image: HardDiskImage | null): void {
    const raisePorts = () => this.paula.raise(Int.PORTS);
    if (this.scsi) this.scsi.drives[0] = image && this.model.ide === 'scsi' ? new ScsiDisk(image) : null;
    if (!image || this.model.ide === 'scsi' || this.model.ide === 'none') this.gayle = null;
    else if (this.model.ide === 'a4000') this.gayle = new A4000Ide(image, raisePorts);
    else {
      const gayle = new Gayle(image, raisePorts);
      gayle.aga = this.model.chipset === 'aga';
      this.gayle = gayle;
    }
  }

  /** The hard drive, on whichever port it is (for its size and activity light). */
  get hardDrive(): { image: HardDiskImage; activity: number } | null {
    return this.gayle?.drive ?? this.scsi?.disk ?? null;
  }

  insertDisk(drive: number, disk: FloppyDisk | null): void {
    if (disk) this.drives[drive].insert(disk);
    else this.drives[drive].eject();
  }

  // --- Power and reset ---------------------------------------------------------------

  /** Switches on: memory cleared, everything reset, the CPU starting from the ROM. */
  powerOn(): void {
    this.chip.bytes.fill(0);
    this.slow.fill(0);
    this.zorro?.bytes.fill(0);
    this.motherboardRam.fill(0);
    // Gary tells Kickstart a power-on from a reset.
    this.gary.fill(0);
    this.gary[2] = 0x80;
    this.keyboard.reset();
    this.ports.reset();
    for (const drive of this.drives) {
      drive.cylinder = 0;
      drive.position = 0;
    }
    this.reset();
  }

  /** Ctrl-Amiga-Amiga: the CPU and chips restart; memory keeps its contents. */
  reset(): void {
    this.resetDevices();
    this.interruptPipe = 0;
    this.cpu.irqLevel = this.cpu.polledIrqLevel = 0;
    this.cpu.reset();
  }

  /** The reset line: the CIAs and custom chips (the CPU's RESET instruction pulses it). */
  resetDevices(): void {
    this.cd32OverlayDone = false;
    this.ciaA.reset();
    this.ciaB.reset();
    this.denise.reset();
    this.paula.reset();
    this.agnus.reset();
    this.gayle?.reset();
    this.scsi?.reset();
    this.akiko?.reset();
    this.zorro?.reset();
    this.eClock = CCKS_PER_E_TICK;
  }

  // --- Running -----------------------------------------------------------------------

  /** Runs for `ccks` colour clocks. */
  run(ccks: number): void {
    const { cpu, agnus } = this;
    const end = agnus.clock + ccks;
    while (agnus.clock < end) {
      if (cpu.stopped && cpu.irqLevel <= cpu.intMask) {
        // STOP: nothing happens until an interrupt, so the chips run on alone.
        agnus.step();
        cpu.cycles = agnus.clock * this.cpuRatio;
        continue;
      }
      cpu.step();
      // The CPU samples its interrupt pins in the instruction's last bus cycle, a cycle before its end.
      const now = Math.floor(cpu.cycles / this.cpuRatio);
      if (now - 1 > agnus.clock) agnus.runTo(now - 1);
      cpu.polledIrqLevel = cpu.irqLevel;
      if (now > agnus.clock) agnus.runTo(now);
    }
  }

  /** Runs until the next picture is complete. */
  runFrame(): void {
    const target = this.agnus.frames + 1;
    while (this.agnus.frames < target) this.run(this.agnus.lineLength);
  }

  // --- Custom chip registers ---------------------------------------------------------

  readCustom(reg: number): number {
    const { agnus, paula, ports, denise } = this;
    switch (reg) {
      case Reg.BLTDDAT:
        return agnus.blitter.ddat;
      case Reg.DMACONR:
        return agnus.dmaconr;
      case Reg.VPOSR:
        return agnus.vposr;
      case Reg.VHPOSR:
        return agnus.vhposr;
      case Reg.JOY0DAT:
        return ports.joy0dat();
      case Reg.JOY1DAT:
        return ports.joy1dat();
      case Reg.CLXDAT:
        return denise.readClxdat();
      case Reg.ADKCONR:
        return paula.adkcon;
      case Reg.POTGOR:
        return ports.potgor();
      case Reg.SERDATR:
        // Transmitter empty, nothing received, the line idle.
        return 0x3800;
      case Reg.DSKBYTR:
        return paula.floppy.readBytes();
      case Reg.INTENAR:
        return paula.intena;
      case Reg.INTREQR:
        return paula.intreq;
      case Reg.DENISEID:
        return denise.id;
      default:
        if (reg >= Reg.COLOR00 && reg < Reg.COLOR00 + 64) return denise.readColor((reg - Reg.COLOR00) >> 1);
        return 0;
    }
  }

  /**
   * A write to a custom register, from the CPU or the Copper. Some registers take it a few cycles
   * later (as vAmiga measured on the hardware), Agnus's and Denise's parts of a register apart.
   */
  writeCustom(reg: number, value: number): void {
    const { agnus } = this;
    switch (reg) {
      case Reg.DMACON:
      case Reg.BPL1MOD:
      case Reg.BPL2MOD:
      case Reg.BLTCON0:
      case Reg.BLTCON1:
        agnus.delayWrite(2, reg, value);
        return;
      case Reg.DDFSTRT:
      case Reg.DDFSTOP:
        agnus.delayWrite(4, reg, value);
        return;
      case Reg.BPLCON0:
      case Reg.DIWSTRT:
      case Reg.DIWSTOP:
        agnus.delayWrite(1, reg, value, PART_DENISE);
        agnus.delayWrite(4, reg, value, PART_AGNUS);
        return;
      case Reg.BPLCON1:
      case Reg.BPLCON2:
      case Reg.BPLCON3:
      case Reg.BPLCON4:
        agnus.delayWrite(1, reg, value);
        return;
    }
    if ((reg >= Reg.BPL1PT && reg <= Reg.BPL8PT_END) || (reg >= Reg.SPR0PT && reg <= Reg.SPR7PT_END)) {
      agnus.delayWrite(2, reg, value);
      return;
    }
    this.applyWrite(reg, value);
  }

  /** A custom register write taking effect; for BPLCON0, DIWSTRT and DIWSTOP, Agnus's or Denise's part. */
  private applyWrite(reg: number, value: number, part = 0): void {
    const { agnus, paula, denise } = this;
    if (reg >= Reg.AUD0 && reg <= Reg.AUD3_END) {
      paula.audio.writeRegister((reg - Reg.AUD0) >> 4, reg & 0xf, value);
      return;
    }
    if (reg >= Reg.SPR0POS && reg <= Reg.SPR7_END) {
      const n = (reg - Reg.SPR0POS) >> 3;
      switch (reg & 6) {
        case 0:
          denise.writeSprPos(n, value);
          agnus.noteSpritePosition(n, value, denise.sprCtl[n]);
          break;
        case 2:
          denise.writeSprCtl(n, value);
          agnus.noteSpritePosition(n, denise.sprPos[n], value);
          break;
        case 4:
          denise.writeSprDataA(n, value);
          break;
        default:
          denise.writeSprDataB(n, value);
      }
      return;
    }
    if (reg >= Reg.COLOR00 && reg <= Reg.COLOR31) {
      denise.writeColor((reg - Reg.COLOR00) >> 1, value);
      return;
    }
    if (reg >= Reg.BPL1DAT && reg <= (denise.aga ? Reg.BPL8DAT : Reg.BPL6DAT)) {
      denise.writeBplDat((reg - Reg.BPL1DAT) >> 1, value);
      return;
    }
    switch (reg) {
      case Reg.DSKPTH:
        paula.floppy.writePointerHigh(value);
        break;
      case Reg.DSKPTL:
        paula.floppy.writePointerLow(value);
        break;
      case Reg.DSKLEN:
        paula.floppy.writeLength(value);
        agnus.rebuildSlots();
        break;
      case Reg.DSKSYNC:
        paula.floppy.sync = value;
        break;
      case Reg.VPOSW:
        agnus.writeVposw(value);
        break;
      case Reg.SERDAT:
        paula.writeSerial();
        break;
      case Reg.POTGO:
        this.ports.potgo = value;
        break;
      case Reg.JOYTEST:
        this.ports.joytest(value);
        break;
      case Reg.DMACON:
        agnus.writeDmacon(value);
        paula.audio.updateDma();
        break;
      case Reg.CLXCON:
        denise.writeClxcon(value);
        break;
      case Reg.INTENA:
        paula.writeIntena(value);
        break;
      case Reg.INTREQ:
        paula.writeIntreq(value);
        break;
      case Reg.ADKCON:
        paula.writeAdkcon(value);
        break;
      case Reg.BPLCON0:
        if (part !== PART_AGNUS) denise.writeBplcon0(value);
        if (part !== PART_DENISE) agnus.writeBplcon0(value);
        break;
      case Reg.DIWSTRT:
        if (part !== PART_AGNUS) denise.writeDiwStart(value);
        if (part !== PART_DENISE) agnus.writeRegister(reg, value);
        break;
      case Reg.DIWSTOP:
        if (part !== PART_AGNUS) denise.writeDiwStop(value);
        if (part !== PART_DENISE) agnus.writeRegister(reg, value);
        break;
      case Reg.BPLCON1:
        denise.writeBplcon1(value);
        break;
      case Reg.BPLCON2:
        denise.writeBplcon2(value);
        break;
      case Reg.BPLCON3:
        if (denise.ecs) denise.writeBplcon3(value);
        break;
      case Reg.BPLCON4:
        if (denise.aga) denise.writeBplcon4(value);
        break;
      case Reg.BEAMCON0:
        // ECS: the PAL bit switches the machine between PAL and NTSC.
        if (agnus.ecs) this.setStandard(value & 0x20 ? 'pal' : 'ntsc');
        break;
      case Reg.DIWHIGH:
        denise.writeDiwHigh(value);
        agnus.writeRegister(reg, value);
        break;
      default:
        agnus.writeRegister(reg, value);
    }
  }

  // --- Save states -------------------------------------------------------------------

  /** Everything in the machine except the ROMs and the disks (which a session keeps itself). */
  saveState(): StateNode {
    this.agnus.blitter.finishNow();
    return captureState(this);
  }

  /** Restores a saved state; the same Kickstart and disks must already be in. */
  loadState(state: StateNode): void {
    restoreState(this, state);
    this.agnus.rebuildSlots();
  }
}
