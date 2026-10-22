import { Agnus, CCK_HZ, type VideoStandard } from './agnus/agnus';
import { Cia8520 } from './cia/cia8520';
import { M68k } from './cpu/m68k';
import { Int, Reg } from './custom/registers';
import { Denise } from './denise/denise';
import type { FloppyDisk } from './drive/adf';
import { FloppyDrive } from './drive/floppy';
import { Gayle } from './ide/gayle';
import type { HardDiskImage } from './ide/image';
import { AmigaKeyboard } from './io/keyboard';
import { ControlPorts } from './io/ports';
import { AmigaBus } from './memory/bus';
import { ChipRam } from './memory/chip-ram';
import { Paula } from './paula/paula';
import { captureState, restoreState, type StateNode } from './state/snapshot';

export type { VideoStandard } from './agnus/agnus';

export interface MemoryConfig {
  chipKb: 512 | 1024;
  /** The trapdoor expansion's "slow" RAM at $C00000. */
  slowKb: 0 | 512;
}

export const DEFAULT_MEMORY: MemoryConfig = { chipKb: 512, slowKb: 512 };

/** E-clock ticks (for the CIAs) come every 5 colour clocks. */
const CCKS_PER_E_TICK = 5;
const ROM_SPACE = 0x80000;

/**
 * An Amiga 500: a 68000, the OCS chipset (Agnus with the Copper and blitter,
 * Denise, Paula), two 8520 CIAs, chip RAM and optional slow RAM, the
 * Kickstart ROM, the keyboard, the control ports and the floppy drives (DF0
 * inside, DF1 optional). The chips run in colour clocks; the CPU runs an
 * instruction at a time and the chips are brought up to its time whenever it
 * touches the chip bus.
 */
export class Amiga {
  readonly chip = new ChipRam(DEFAULT_MEMORY.chipKb * 1024);
  slow = new Uint8Array(DEFAULT_MEMORY.slowKb * 1024);
  /** The Kickstart, filling the 512K at $F80000 (a 256K ROM twice). */
  readonly rom = new Uint8Array(ROM_SPACE);
  /** A ROM at $E00000 (AROS has one). */
  extendedRom: Uint8Array | null = null;
  /** The A600-style IDE port and its drive, when a hard disk is attached. */
  gayle: Gayle | null = null;
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
  /** The power light (also the audio filter's switch). */
  powerLed = false;
  private eClock = CCKS_PER_E_TICK;
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
      setInterruptLevel: (level) => (this.cpu.irqLevel = level),
      heldInterrupts: () => (this.ciaA.interrupt ? Int.PORTS : 0) | (this.ciaB.interrupt ? Int.EXTER : 0),
    });
    this.agnus = new Agnus(this.chip, this.denise, {
      writeRegister: (reg, value) => this.writeCustom(reg, value),
      onLine: () => {
        this.ciaB.countEvent();
        this.keyboard.tick();
        this.gayle?.tick();
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
    this.agnus.blitter.onDone = () => this.paula.raise(Int.BLIT);
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
    this.overlay = (output & 0x01) !== 0;
    this.powerLed = (output & 0x02) === 0;
    this.paula.audio.ledFilter = this.powerLed;
  }

  private tickChips(): void {
    this.paula.audio.tick();
    this.paula.floppy.tick();
    if (--this.eClock === 0) {
      this.eClock = CCKS_PER_E_TICK;
      this.ciaA.tick(1);
      this.ciaB.tick(1);
    }
  }

  // --- Setup -------------------------------------------------------------------------

  /** Puts a Kickstart (256K or 512K) in; takes effect at the next power on. */
  setKickstart(rom: Uint8Array): void {
    if (rom.length === ROM_SPACE / 2) {
      this.rom.set(rom, 0);
      this.rom.set(rom, ROM_SPACE / 2);
    } else {
      this.rom.set(rom.subarray(0, ROM_SPACE));
    }
  }

  setMemory(config: MemoryConfig): void {
    this.chip.resize(config.chipKb * 1024);
    if (this.slow.length !== config.slowKb * 1024) this.slow = new Uint8Array(config.slowKb * 1024);
  }

  get memory(): MemoryConfig {
    return { chipKb: (this.chip.size / 1024) as 512 | 1024, slowKb: (this.slow.length / 1024) as 0 | 512 };
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
    this.gayle = image ? new Gayle(image, () => this.paula.raise(Int.PORTS)) : null;
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
    this.cpu.irqLevel = 0;
    this.cpu.reset();
  }

  /** The reset line: the CIAs and custom chips (the CPU's RESET instruction pulses it). */
  resetDevices(): void {
    this.ciaA.reset();
    this.ciaB.reset();
    this.denise.reset();
    this.paula.reset();
    this.agnus.reset();
    this.gayle?.reset();
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
        cpu.cycles = agnus.clock * 2;
        continue;
      }
      cpu.step();
      const now = Math.floor(cpu.cycles / 2);
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
      case 0x07c:
        // DENISEID: the original Denise has no such register.
        return 0xffff;
      default:
        return 0;
    }
  }

  writeCustom(reg: number, value: number): void {
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
    if (reg >= Reg.BPL1DAT && reg <= Reg.BPL6DAT) {
      denise.bplDat[(reg - Reg.BPL1DAT) >> 1] = value;
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
        denise.writeBplcon0(value);
        agnus.rebuildSlots();
        break;
      case Reg.BPLCON1:
        denise.writeBplcon1(value);
        break;
      case Reg.BPLCON2:
        denise.writeBplcon2(value);
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
