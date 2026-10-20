import type { Amiga } from '../amiga';
import type { M68kBus } from '../cpu/m68k';
import { Gayle } from '../ide/gayle';

const CHIP_END = 0x200000;
const SLOW_START = 0xc00000;
const EXTENDED_ROM_START = 0xe00000;
const EXTENDED_ROM_END = 0xe80000;
const ROM_START = 0xf80000;
/** Without RAM there, the space from the end of slow RAM to $D80000 echoes the custom chips (Kickstart looks for that). */
const CUSTOM_ECHO_END = 0xd80000;
/** While the overlay is on, the ROM also appears at the bottom of memory (where the CPU finds its reset vectors). */
const OVERLAY_END = 0x80000;

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
    const at = Math.floor((cpu.cycles - 4) / 2);
    if (at > agnus.clock) agnus.runTo(at);
    else if (at < agnus.clock) cpu.cycles += (agnus.clock - at) * 2;
    while (agnus.cpuBlocked()) {
      agnus.cpuWaits++;
      agnus.step();
      cpu.cycles += 2;
    }
    agnus.cpuWaits = 0;
    agnus.cpuSlot = agnus.clock;
  }

  /** CIA accesses are synchronised to the E clock (a tenth of the CPU's). */
  private ciaCycle(): void {
    const { cpu, agnus } = this.amiga;
    cpu.cycles += 4 + ((10 - (cpu.cycles % 10)) % 10);
    agnus.runTo(Math.floor(cpu.cycles / 2));
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

  read16(address: number): number {
    const amiga = this.amiga;
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
    if (amiga.gayle && Gayle.handles(address)) return amiga.gayle.read16(address);
    return 0;
  }

  read8(address: number): number {
    const amiga = this.amiga;
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
    if (amiga.gayle && Gayle.handles(address)) return amiga.gayle.read8(address);
    const word = this.read16(address & ~1);
    return address & 1 ? word & 0xff : word >> 8;
  }

  write16(address: number, value: number): void {
    const amiga = this.amiga;
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
    } else if (amiga.gayle && Gayle.handles(address)) {
      amiga.gayle.write16(address, value);
    }
  }

  write8(address: number, value: number): void {
    const amiga = this.amiga;
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
    } else if (amiga.gayle && Gayle.handles(address)) {
      amiga.gayle.write8(address, value);
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
