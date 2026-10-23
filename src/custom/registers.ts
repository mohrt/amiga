/** Offsets of the custom chip registers from $DFF000. */
export const Reg = {
  BLTDDAT: 0x000,
  DMACONR: 0x002,
  VPOSR: 0x004,
  VHPOSR: 0x006,
  DSKDATR: 0x008,
  JOY0DAT: 0x00a,
  JOY1DAT: 0x00c,
  CLXDAT: 0x00e,
  ADKCONR: 0x010,
  POT0DAT: 0x012,
  POT1DAT: 0x014,
  POTGOR: 0x016,
  SERDATR: 0x018,
  DSKBYTR: 0x01a,
  INTENAR: 0x01c,
  INTREQR: 0x01e,
  DSKPTH: 0x020,
  DSKPTL: 0x022,
  DSKLEN: 0x024,
  DSKDAT: 0x026,
  REFPTR: 0x028,
  VPOSW: 0x02a,
  VHPOSW: 0x02c,
  COPCON: 0x02e,
  SERDAT: 0x030,
  SERPER: 0x032,
  POTGO: 0x034,
  JOYTEST: 0x036,
  BLTCON0: 0x040,
  BLTCON1: 0x042,
  BLTAFWM: 0x044,
  BLTALWM: 0x046,
  BLTCPTH: 0x048,
  BLTCPTL: 0x04a,
  BLTBPTH: 0x04c,
  BLTBPTL: 0x04e,
  BLTAPTH: 0x050,
  BLTAPTL: 0x052,
  BLTDPTH: 0x054,
  BLTDPTL: 0x056,
  BLTSIZE: 0x058,
  /** ECS blitter: BLTCON0's low byte, and the larger blits' height (BLTSIZV) and width (BLTSIZH, which starts it). */
  BLTCON0L: 0x05a,
  BLTSIZV: 0x05c,
  BLTSIZH: 0x05e,
  BLTCMOD: 0x060,
  BLTBMOD: 0x062,
  BLTAMOD: 0x064,
  BLTDMOD: 0x066,
  BLTCDAT: 0x070,
  BLTBDAT: 0x072,
  BLTADAT: 0x074,
  DSKSYNC: 0x07e,
  COP1LCH: 0x080,
  COP1LCL: 0x082,
  COP2LCH: 0x084,
  COP2LCL: 0x086,
  COPJMP1: 0x088,
  COPJMP2: 0x08a,
  COPINS: 0x08c,
  DIWSTRT: 0x08e,
  DIWSTOP: 0x090,
  DDFSTRT: 0x092,
  DDFSTOP: 0x094,
  DMACON: 0x096,
  CLXCON: 0x098,
  INTENA: 0x09a,
  INTREQ: 0x09c,
  ADKCON: 0x09e,
  /** AUD0LCH; each channel's six registers take 16 bytes. */
  AUD0: 0x0a0,
  AUD3_END: 0x0df,
  /** BPL1PTH; BPL1PTH-BPL6PTL run to $0F6. */
  BPL1PT: 0x0e0,
  BPL6PT_END: 0x0f7,
  /** AGA's seventh and eighth plane pointers end here. */
  BPL8PT_END: 0x0ff,
  BPLCON0: 0x100,
  BPLCON1: 0x102,
  BPLCON2: 0x104,
  /** ECS Denise and later. */
  BPLCON3: 0x106,
  BPL1MOD: 0x108,
  BPL2MOD: 0x10a,
  /** BPL1DAT-BPL6DAT run to $11A, and AGA's BPL7DAT and BPL8DAT to $11E. */
  BPL1DAT: 0x110,
  BPL6DAT: 0x11a,
  BPL8DAT: 0x11e,
  /** AGA: BPLCON4 (bitplane and sprite colour banks) and FMODE (fetch widths). */
  BPLCON4: 0x10c,
  FMODE: 0x1fc,
  /** SPR0PTH; SPR0PTH-SPR7PTL run to $13E. */
  SPR0PT: 0x120,
  SPR7PT_END: 0x13f,
  /** SPR0POS; each sprite has POS, CTL, DATA and DATB (8 bytes). */
  SPR0POS: 0x140,
  SPR7_END: 0x17f,
  COLOR00: 0x180,
  COLOR31: 0x1be,
  /** ECS Agnus and later. */
  BEAMCON0: 0x1dc,
  DIWHIGH: 0x1e4,
  /** ECS Denise's ID ($FC); the original Denise has no such register. */
  DENISEID: 0x07c,
} as const;

/** DMACON bits. */
export const Dma = {
  SET: 0x8000,
  BBUSY: 0x4000,
  BZERO: 0x2000,
  BLTPRI: 0x0400,
  DMAEN: 0x0200,
  BPLEN: 0x0100,
  COPEN: 0x0080,
  BLTEN: 0x0040,
  SPREN: 0x0020,
  DSKEN: 0x0010,
  AUD0EN: 0x0001,
} as const;

/** INTENA and INTREQ bits. */
export const Int = {
  SET: 0x8000,
  INTEN: 0x4000,
  EXTER: 0x2000,
  DSKSYN: 0x1000,
  RBF: 0x0800,
  AUD0: 0x0080,
  BLIT: 0x0040,
  VERTB: 0x0020,
  COPER: 0x0010,
  PORTS: 0x0008,
  SOFT: 0x0004,
  DSKBLK: 0x0002,
  TBE: 0x0001,
} as const;

/** The CPU interrupt level (1-6) of each INTREQ bit. */
export const INTERRUPT_LEVELS = [1, 1, 1, 2, 3, 3, 3, 4, 4, 4, 4, 5, 5, 6] as const;

/** A SET/CLR register write: bit 15 says whether the other set bits are set or cleared. */
export function setClear(current: number, value: number): number {
  return value & 0x8000 ? (current | value) & 0x7fff : current & ~value & 0x7fff;
}
