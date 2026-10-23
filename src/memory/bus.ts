import type { Amiga } from '../amiga';
import type { M68kBus } from '../cpu/m68k';
import { A4000Ide } from '../ide/a4000-ide';
import { RealTimeClock } from '../io/clock';

const CHIP_END = 0x200000;
const SLOW_START = 0xc00000;
const EXTENDED_ROM_START = 0xe00000;
const EXTENDED_ROM_END = 0xe80000;
const ROM_START = 0xf80000;
/** Without RAM there, the space from the end of slow RAM to $D80000 echoes the custom chips (Kickstart looks for that). */
const CUSTOM_ECHO_END = 0xd80000;
/** While the overlay is on, the ROM also appears at the bottom of memory (where the CPU finds its reset vectors). */
const OVERLAY_END = 0x80000;
/** The 68030's addresses above the 24-bit space; the A4000's main board RAM ends at $8000000. */
const HIGH_START = 0x1000000;
const MOTHERBOARD_RAM_END = 0x8000000;
/** Gary's registers (bit 7 of $DE0000-$DE0002) and Ramsey's control and version, on the A4000. */
const GARY_START = 0xde0000;
const GARY_END = 0xde0003;
const RAMSEY_CONTROL = 0xde0003;
const RAMSEY_VERSION = 0xde0043;
/** Ramsey revision 7, as in later A4000s. */
const RAMSEY_REVISION = 0x0f;

/**
 * The A500's address decoding, from the CPU's side: chip RAM (with the ROM
 * over it until CIA-A turns the overlay off), slow RAM at $C00000, the CIAs
 * at $BFxxxx, the custom chips at $DFF000, the Kickstart at $F80000 (a 256K
 * one appears twice) and an extended ROM at $E00000 if there is one.
 *
 * Chip RAM, slow RAM and the custom chips are on the chip bus: the chips are
 * first run up to the CPU's time, then the CPU waits for a cycle no DMA
 * wants. CIA accesses wait for the E clock.
 */
export class AmigaBus implements M68kBus {
  constructor(private readonly amiga: Amiga) {}

  /** Brings the chips up to the CPU's access and waits for a free chip bus cycle. */
  private chipBusCycle(): void {
    const { cpu, agnus } = this.amiga;
    const ratio = this.amiga.cpuRatio;
    // The access is two CPU cycles into the four of a 68000 bus cycle.
    const at = Math.floor((cpu.cycles - 2) / ratio);
    if (at > agnus.clock) agnus.runTo(at);
    else if (at < agnus.clock) cpu.cycles += (agnus.clock - at) * ratio;
    cpu.cycles += agnus.cpuAccess() * ratio;
  }

  /** CIA accesses are synchronised to the E clock (a tenth of the CPU's). */
  private ciaCycle(): void {
    const { cpu, agnus } = this.amiga;
    // The E clock is a tenth of the 68000's clock (a twentieth of the 68EC020's).
    const ratio = this.amiga.cpuRatio;
    const period = 5 * ratio;
    cpu.cycles += 2 * ratio + ((period - (cpu.cycles % period)) % period);
    agnus.runTo(Math.floor(cpu.cycles / ratio));
  }

  private ciaRead(address: number): number {
    this.ciaCycle();
    const { ciaA, ciaB } = this.amiga;
    const reg = (address >> 8) & 0xf;
    const low = address & 0x1000 ? 0xff : ciaA.read(reg);
    const high = address & 0x2000 ? 0xff : ciaB.read(reg);
    return (high << 8) | low;
  }

  private ciaWrite(address: number, value: number, byte: boolean): void {
    this.ciaCycle();
    const { ciaA, ciaB } = this.amiga;
    const reg = (address >> 8) & 0xf;
    // CIA-A is on the low byte (odd addresses), CIA-B on the high byte (even ones).
    const odd = (address & 1) !== 0;
    if (!(address & 0x1000) && (!byte || odd)) ciaA.write(reg, byte ? value : value & 0xff);
    if (!(address & 0x2000) && (!byte || !odd)) ciaB.write(reg, byte ? value : value >> 8);
  }

  /** The custom chips answer at $DFF000, and also in the unused part of the slow RAM space. */
  private isCustom(address: number): boolean {
    if (address >= 0xdff000) return address < EXTENDED_ROM_START;
    return address >= SLOW_START + this.amiga.slow.length && address >= SLOW_START && address < CUSTOM_ECHO_END;
  }

  /** The A4000's main board RAM, as an offset into it, or -1 for an address outside it. */
  private motherboardOffset(address: number): number {
    const ram = this.amiga.motherboardRam;
    const offset = address - (MOTHERBOARD_RAM_END - ram.length);
    return offset >= 0 && offset < ram.length ? offset : -1;
  }

  /** Gary and Ramsey answer on the A4000 only. */
  private isGary(address: number): boolean {
    return this.amiga.model.cpu === '68030' && address >= GARY_START && address <= RAMSEY_VERSION && (address <= RAMSEY_CONTROL || address === RAMSEY_VERSION);
  }

  private garyRead(address: number): number {
    const amiga = this.amiga;
    if (address === RAMSEY_VERSION) return RAMSEY_REVISION;
    if (address === RAMSEY_CONTROL) return amiga.ramseyControl;
    const value = amiga.gary[address - GARY_START];
    // Reading the cold-boot bit clears it, so a later reset reads as a warm one.
    if (address === GARY_END - 1) amiga.gary[2] = 0;
    return value;
  }

  private garyWrite(address: number, value: number): void {
    if (address === RAMSEY_CONTROL) this.amiga.ramseyControl = value & 0xff;
    else if (address < GARY_END) this.amiga.gary[address - GARY_START] = value & 0x80;
  }

  read16(address: number): number {
    const amiga = this.amiga;
    if (address >= HIGH_START) {
      const offset = this.motherboardOffset(address);
      return offset < 0 ? 0 : (amiga.motherboardRam[offset] << 8) | amiga.motherboardRam[offset + 1];
    }
    if (address < CHIP_END) {
      if (amiga.overlay && address < OVERLAY_END) return this.romWord(address);
      this.chipBusCycle();
      return amiga.chip.read16(address);
    }
    if (address >= ROM_START) return this.romWord(address);
    if (this.isCustom(address)) {
      this.chipBusCycle();
      return amiga.readCustom(address & 0x1fe);
    }
    if (address >= SLOW_START && address < SLOW_START + amiga.slow.length) {
      this.chipBusCycle();
      const a = address - SLOW_START;
      return (amiga.slow[a] << 8) | amiga.slow[a + 1];
    }
    if (address >= 0xa00000 && address < 0xc00000) return this.ciaRead(address);
    if (address >= EXTENDED_ROM_START && address < EXTENDED_ROM_END && amiga.extendedRom) {
      const a = address & 0x7fffe;
      return (amiga.extendedRom[a] << 8) | amiga.extendedRom[a + 1];
    }
    if (amiga.gayle?.handles(address)) return amiga.gayle.read16(address);
    if (amiga.model.ide === 'a4000' && A4000Ide.handles(address)) return A4000Ide.readEmpty(address) << 8;
    return this.expansionRead(address, false);
  }

  /** The fast RAM board (or its autoconfig space) and the clock, which aren't on the chip bus. */
  private expansionRead(address: number, byte: boolean): number {
    const { zorro, clock } = this.amiga;
    if (zorro?.holds(address)) return byte ? zorro.read8(address) : zorro.read16(address);
    if (zorro?.configures(address)) return byte ? zorro.readConfig(address) : (zorro.readConfig(address) << 8) | 0xff;
    if (clock && RealTimeClock.handles(address)) return clock.read(address);
    return byte ? 0xff : 0;
  }

  private expansionWrite(address: number, value: number, byte: boolean): void {
    const { zorro, clock } = this.amiga;
    if (zorro?.holds(address)) {
      if (byte) zorro.write8(address, value);
      else zorro.write16(address, value);
    } else if (zorro?.configures(address)) {
      zorro.writeConfig(address, byte ? value : value >> 8);
    } else if (clock && RealTimeClock.handles(address)) {
      clock.write(address, value);
    }
  }

  read8(address: number): number {
    const amiga = this.amiga;
    if (address >= HIGH_START) {
      const offset = this.motherboardOffset(address);
      return offset < 0 ? 0 : amiga.motherboardRam[offset];
    }
    if (this.isGary(address)) return this.garyRead(address);
    if (address < CHIP_END) {
      if (amiga.overlay && address < OVERLAY_END) return amiga.rom[address & 0x7ffff];
      this.chipBusCycle();
      return amiga.chip.read8(address);
    }
    if (address >= ROM_START) return amiga.rom[address & 0x7ffff];
    if (address >= SLOW_START && address < SLOW_START + amiga.slow.length) {
      this.chipBusCycle();
      return amiga.slow[address - SLOW_START];
    }
    if (address >= 0xa00000 && address < 0xc00000) {
      const word = this.ciaRead(address);
      return address & 1 ? word & 0xff : word >> 8;
    }
    if (amiga.gayle?.handles(address)) return amiga.gayle.read8(address);
    if (amiga.model.ide === 'a4000' && A4000Ide.handles(address)) return A4000Ide.readEmpty(address);
    if (amiga.zorro || amiga.clock) {
      const { zorro, clock } = amiga;
      if (zorro?.holds(address) || zorro?.configures(address) || (clock && RealTimeClock.handles(address))) return this.expansionRead(address, true);
    }
    const word = this.read16(address & ~1);
    return address & 1 ? word & 0xff : word >> 8;
  }

  write16(address: number, value: number): void {
    const amiga = this.amiga;
    if (address >= HIGH_START) {
      const offset = this.motherboardOffset(address);
      if (offset >= 0) {
        amiga.motherboardRam[offset] = value >> 8;
        amiga.motherboardRam[offset + 1] = value;
      }
      return;
    }
    if (address < CHIP_END) {
      this.chipBusCycle();
      amiga.chip.write16(address, value);
    } else if (this.isCustom(address)) {
      this.chipBusCycle();
      amiga.writeCustom(address & 0x1fe, value);
    } else if (address >= SLOW_START && address < SLOW_START + amiga.slow.length) {
      this.chipBusCycle();
      const a = address - SLOW_START;
      amiga.slow[a] = value >> 8;
      amiga.slow[a + 1] = value;
    } else if (address >= 0xa00000 && address < 0xc00000) {
      this.ciaWrite(address, value, false);
    } else if (amiga.gayle?.handles(address)) {
      amiga.gayle.write16(address, value);
    } else {
      this.expansionWrite(address, value, false);
    }
  }

  write8(address: number, value: number): void {
    const amiga = this.amiga;
    if (address >= HIGH_START) {
      const offset = this.motherboardOffset(address);
      if (offset >= 0) amiga.motherboardRam[offset] = value;
      return;
    }
    if (this.isGary(address)) {
      this.garyWrite(address, value);
      return;
    }
    if (address < CHIP_END) {
      this.chipBusCycle();
      amiga.chip.write8(address, value);
    } else if (this.isCustom(address)) {
      // A byte written to a custom register arrives on both halves of the data bus.
      this.chipBusCycle();
      amiga.writeCustom(address & 0x1fe, (value << 8) | value);
    } else if (address >= SLOW_START && address < SLOW_START + amiga.slow.length) {
      this.chipBusCycle();
      amiga.slow[address - SLOW_START] = value;
    } else if (address >= 0xa00000 && address < 0xc00000) {
      this.ciaWrite(address, value, true);
    } else if (amiga.gayle?.handles(address)) {
      amiga.gayle.write8(address, value);
    } else {
      this.expansionWrite(address, value, true);
    }
  }

  private romWord(address: number): number {
    const a = address & 0x7fffe;
    const rom = this.amiga.rom;
    return (rom[a] << 8) | rom[a + 1];
  }

  acknowledgeInterrupt(): void {}

  /** The RESET instruction resets the CIAs and the custom chips (which turns the overlay back on). */
  resetDevices(): void {
    this.amiga.resetDevices();
  }
}
