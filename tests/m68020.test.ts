import { describe, expect, it } from 'vitest';
import { M68k, type CpuModel, type M68kBus } from '../src/cpu/m68k';

const CODE = 0x1000;
const STACK = 0x8000;

/** A 68EC020 (or a 68030) on a megabyte of plain memory, running `words` from $1000 in supervisor mode. */
function cpuWith(words: number[], model: CpuModel = '68ec020'): { cpu: M68k; memory: Uint8Array; writes: number[] } {
  const memory = new Uint8Array(0x100000);
  /** The addresses the CPU wrote words to, as it put them on the bus. */
  const writes: number[] = [];
  const bus: M68kBus = {
    read8: (address) => memory[address & 0xfffff],
    read16: (address) => (memory[address & 0xfffff] << 8) | memory[(address + 1) & 0xfffff],
    write8: (address, value) => (memory[address & 0xfffff] = value),
    write16: (address, value) => {
      writes.push(address);
      memory[address & 0xfffff] = value >> 8;
      memory[(address + 1) & 0xfffff] = value;
    },
    acknowledgeInterrupt: () => {},
    resetDevices: () => {},
  };
  words.forEach((word, i) => bus.write16(CODE + i * 2, word));
  writes.length = 0;
  const cpu = new M68k(bus);
  cpu.setModel(model);
  cpu.pc = CODE;
  cpu.a[7] = STACK;
  cpu.intMask = 7;
  return { cpu, memory, writes };
}

const run = (cpu: M68k, instructions: number) => {
  for (let i = 0; i < instructions; i++) cpu.step();
};

const read32 = (memory: Uint8Array, address: number) =>
  ((memory[address] << 24) | (memory[address + 1] << 16) | (memory[address + 2] << 8) | memory[address + 3]) >>> 0;
const write32 = (memory: Uint8Array, address: number, value: number) => {
  for (let i = 0; i < 4; i++) memory[address + i] = value >>> (24 - i * 8);
};

describe('68EC020', () => {
  it('multiplies 32 by 32 bits, to 32 bits with overflow or to 64', () => {
    // MULU.L D1,D0; MULU.L D1,D3:D4; MULS.L D1,D5
    const { cpu } = cpuWith([0x4c01, 0x0000, 0x4c01, 0x4403, 0x4c01, 0x5800]);
    cpu.d[0] = 0x10000;
    cpu.d[1] = 0x30000;
    cpu.d[4] = 0x12345678;
    cpu.d[5] = 0xfffffffe;
    run(cpu, 1);
    expect(cpu.d[0]).toBe(0);
    expect(cpu.v).toBe(true);
    run(cpu, 1);
    // $12345678 x $30000 = $369D_0368_0000.
    expect(cpu.d[3]).toBe(0x369d);
    expect(cpu.d[4]).toBe(0x03680000);
    run(cpu, 1);
    expect(cpu.d[5]).toBe((-2 * 0x30000) >>> 0);
    expect(cpu.v).toBe(false);
    expect(cpu.n).toBe(true);
  });

  it('divides 32 and 64 bits by 32, with the remainder in another register', () => {
    // DIVU.L D1,D2:D0 (32 bits, remainder to D2); DIVU.L D1,D4:D3 (64 bits); DIVS.L D1,D5
    const { cpu } = cpuWith([0x4c41, 0x0002, 0x4c41, 0x3404, 0x4c41, 0x5805]);
    cpu.d[0] = 1000;
    cpu.d[1] = 7;
    run(cpu, 1);
    expect(cpu.d[0]).toBe(142);
    expect(cpu.d[2]).toBe(6);
    cpu.d[4] = 1;
    cpu.d[3] = 0;
    run(cpu, 1);
    // 2^32 / 7 = 613566756 remainder 4.
    expect(cpu.d[3]).toBe(613566756);
    expect(cpu.d[4]).toBe(4);
    cpu.d[5] = -100 >>> 0;
    run(cpu, 1);
    expect(cpu.d[5] | 0).toBe(-14);
  });

  it('sign-extends a byte to a long with EXTB', () => {
    const { cpu } = cpuWith([0x49c0]);
    cpu.d[0] = 0x12345680;
    run(cpu, 1);
    expect(cpu.d[0]).toBe(0xffffff80);
    expect(cpu.n).toBe(true);
  });

  it('extracts, inserts and finds bit fields in registers and memory', () => {
    // BFEXTU D0{4:8},D1; BFINS D2,(A0){12:16}; BFFFO D3{0:32},D4; BFEXTS (A0){12:16},D5
    const { cpu, memory } = cpuWith([0xe9c0, 0x1108, 0xefd0, 0x2310, 0xedc3, 0x4000, 0xebd0, 0x5310]);
    cpu.d[0] = 0x12345678;
    cpu.d[2] = 0xabcd;
    cpu.d[3] = 0x00010000;
    cpu.a[0] = 0x4000;
    run(cpu, 1);
    expect(cpu.d[1]).toBe(0x23);
    run(cpu, 1);
    // Bits 12-27 of the long at $4000 are $ABCD.
    expect(read32(memory, 0x4000)).toBe(0x000abcd0);
    expect(cpu.n).toBe(true);
    run(cpu, 1);
    expect(cpu.d[4]).toBe(15);
    run(cpu, 1);
    expect(cpu.d[5]).toBe(0xffffabcd);
  });

  it('scales the index, and goes through memory with the full extension format', () => {
    // LEA (8,A0,D1.L*4),A2; MOVE.L ([4,A0],D1.L*2,8),D2
    const { cpu, memory } = cpuWith([0x45f0, 0x1c08, 0x2430, 0x1b26, 0x0004, 0x0008]);
    cpu.a[0] = 0x2000;
    cpu.d[1] = 3;
    write32(memory, 0x2004, 0x3000);
    write32(memory, 0x3000 + 6 + 8, 0xcafef00d);
    run(cpu, 1);
    expect(cpu.a[2]).toBe(0x2000 + 8 + 12);
    run(cpu, 1);
    expect(cpu.d[2]).toBe(0xcafef00d);
  });

  it('takes exceptions through the vector base, with a format word that RTE reads back', () => {
    // MOVEC A0,VBR; TRAP #0; (handler) RTE
    const { cpu, memory } = cpuWith([0x4e7b, 0x8801, 0x4e40, 0x4e71]);
    const vbr = 0x6000;
    cpu.a[0] = vbr;
    write32(memory, vbr + 32 * 4, 0x5000);
    memory[0x5000] = 0x4e;
    memory[0x5001] = 0x73;
    run(cpu, 2);
    expect(cpu.vbr).toBe(vbr);
    expect(cpu.pc).toBe(0x5000);
    expect(cpu.a[7]).toBe(STACK - 8);
    // Format 0 and the vector offset, after the SR and PC.
    expect((memory[STACK - 2] << 8) | memory[STACK - 1]).toBe(0x0080);
    run(cpu, 1);
    expect(cpu.pc).toBe(CODE + 6);
    expect(cpu.a[7]).toBe(STACK);
  });

  it('compares and swaps with CAS', () => {
    // CAS.L D1,D2,(A0) twice
    const { cpu, memory } = cpuWith([0x0ed0, 0x0081, 0x0ed0, 0x0081]);
    cpu.a[0] = 0x4000;
    write32(memory, 0x4000, 5);
    cpu.d[1] = 5;
    cpu.d[2] = 9;
    run(cpu, 1);
    expect(read32(memory, 0x4000)).toBe(9);
    expect(cpu.z).toBe(true);
    run(cpu, 1);
    expect(cpu.d[1]).toBe(9);
  });

  it('branches with a 32-bit displacement, reads words at odd addresses, and returns with RTD', () => {
    // BRA.L +$100; ... at $1106: MOVE.W (A0),D0; BSR.W; ... RTD #8
    const { cpu, memory } = cpuWith([0x60ff, 0x0000, 0x0100]);
    memory.set([0x30, 0x10], 0x1102);
    memory.set([0x12, 0x34], 0x4001);
    cpu.a[0] = 0x4001;
    run(cpu, 1);
    expect(cpu.pc).toBe(CODE + 2 + 0x100);
    run(cpu, 1);
    expect(cpu.d[0] & 0xffff).toBe(0x1234);

    const rtd = cpuWith([0x4e74, 0x0008]);
    rtd.cpu.a[7] = STACK - 4;
    write32(rtd.memory, STACK - 4, 0x2222);
    run(rtd.cpu, 1);
    expect(rtd.cpu.pc).toBe(0x2222);
    expect(rtd.cpu.a[7]).toBe(STACK + 8);
  });

  it('checks a register against bounds with CMP2 and CHK2', () => {
    // CMP2.B (A0),D1; CHK2.W (A1),D0
    const { cpu, memory } = cpuWith([0x00d0, 0x1000, 0x02d1, 0x0800]);
    memory.set([10, 20], 0x4000);
    memory.set([0x00, 0x10, 0x00, 0x20], 0x4100);
    cpu.a[0] = 0x4000;
    cpu.a[1] = 0x4100;
    cpu.d[1] = 20;
    write32(memory, 6 * 4, 0x5000);
    run(cpu, 1);
    expect(cpu.z).toBe(true);
    expect(cpu.c).toBe(false);
    cpu.d[0] = 0x30;
    run(cpu, 1);
    expect(cpu.c).toBe(true);
    // CHK takes format 2, with the instruction's address.
    expect(cpu.pc).toBe(0x5000);
    expect((cpu.a[7] & 0xffff) === ((STACK - 12) & 0xffff)).toBe(true);
  });

  it('packs and unpacks BCD digits', () => {
    // PACK D0,D1,#0; UNPK D1,D2,#$3030
    const { cpu } = cpuWith([0x8340, 0x0000, 0x8581, 0x3030]);
    cpu.d[0] = 0x0305;
    run(cpu, 1);
    expect(cpu.d[1] & 0xff).toBe(0x35);
    run(cpu, 1);
    expect(cpu.d[2] & 0xffff).toBe(0x3335);
  });

  it('traps on a condition with TRAPcc, skipping its operand otherwise', () => {
    // TRAPF.W #1; TRAPT
    const { cpu, memory } = cpuWith([0x51fa, 0x0001, 0x50fc]);
    write32(memory, 7 * 4, 0x5000);
    run(cpu, 1);
    expect(cpu.pc).toBe(CODE + 4);
    run(cpu, 1);
    expect(cpu.pc).toBe(0x5000);
  });
});

describe('68030', () => {
  it('puts all 32 address bits on the bus, where the 68EC020 has 24', () => {
    // MOVE.L D0,$01000000
    const program = [0x23c0, 0x0100, 0x0000];
    const ec020 = cpuWith(program);
    run(ec020.cpu, 1);
    expect(ec020.writes).toEqual([0x000000, 0x000002]);
    const mc030 = cpuWith(program, '68030');
    run(mc030.cpu, 1);
    expect(mc030.writes).toEqual([0x1000000, 0x1000002]);
  });

  it('moves the MMU registers with PMOVE, which the 68EC020 takes as a line-F instruction', () => {
    // PMOVE (A0),TC; PMOVE TC,(A1)
    const program = [0xf010, 0x4000, 0xf011, 0x4200];
    const { cpu, memory } = cpuWith(program, '68030');
    cpu.a[0] = 0x2000;
    cpu.a[1] = 0x2010;
    write32(memory, 0x2000, 0x00c07760);
    run(cpu, 2);
    expect(cpu.tc).toBe(0x00c07760);
    expect(read32(memory, 0x2010)).toBe(0x00c07760);
    const ec020 = cpuWith(program);
    write32(ec020.memory, 11 * 4, 0x5000);
    run(ec020.cpu, 1);
    expect(ec020.cpu.pc).toBe(0x5000);
  });

  it('keeps its data cache bits in CACR', () => {
    // MOVEC D0,CACR; MOVEC CACR,D1
    const program = [0x4e7b, 0x0002, 0x4e7a, 0x1002];
    const mc030 = cpuWith(program, '68030');
    mc030.cpu.d[0] = 0xffffffff;
    run(mc030.cpu, 2);
    expect(mc030.cpu.d[1]).toBe(0x3313);
    const ec020 = cpuWith(program);
    ec020.cpu.d[0] = 0xffffffff;
    run(ec020.cpu, 2);
    expect(ec020.cpu.d[1]).toBe(0x3);
  });
});

describe('68882 FPU', () => {
  const fpuWith = (program: number[]) => {
    const machine = cpuWith(program, '68030');
    machine.cpu.setFpu(true);
    machine.cpu.fpu!.reset();
    return machine;
  };

  it('moves integers in, adds them and moves the sum back out', () => {
    // FMOVE.L #3,FP0; FMOVE.L #2,FP1; FADD.X FP1,FP0; FMOVE.L FP0,D0
    const { cpu } = fpuWith([0xf23c, 0x4000, 0, 3, 0xf23c, 0x4080, 0, 2, 0xf200, 0x0422, 0xf200, 0x6000]);
    run(cpu, 4);
    expect(cpu.d[0]).toBe(5);
    expect(cpu.fpu!.fp[0]).toBe(5);
  });

  it('gives pi from the constant ROM, square roots it, and stores a double', () => {
    // FMOVECR #0,FP0; FSQRT.X FP0; FMOVE.D FP0,(A0)
    const { cpu, memory } = fpuWith([0xf200, 0x5c00, 0xf200, 0x0004, 0xf210, 0x7400]);
    cpu.a[0] = 0x2000;
    run(cpu, 3);
    const view = new DataView(memory.buffer);
    expect(view.getFloat64(0x2000)).toBeCloseTo(Math.sqrt(Math.PI), 12);
  });

  it('keeps registers as extended values through FMOVEM, and branches on a compare', () => {
    // FMOVE.L #-7,FP0; FMOVE.L #9,FP1; FMOVEM.X FP0/FP1,-(A7); FMOVEM.X (A7)+,FP2/FP3; FCMP.X FP3,FP2; FBOGT.W +4; MOVEQ #1,D1; MOVEQ #2,D2
    const { cpu } = fpuWith([0xf23c, 0x4000, 0xffff, 0xfff9, 0xf23c, 0x4080, 0, 9, 0xf227, 0xe003, 0xf21f, 0xd030, 0xf200, 0x0d38, 0xf282, 0x0004, 0x7201, 0x7402]);
    run(cpu, 7);
    expect([cpu.fpu!.fp[2], cpu.fpu!.fp[3]]).toEqual([-7, 9]);
    expect(cpu.a[7]).toBe(STACK);
    // -7 isn't greater than 9, so no branch: D1 is set.
    expect(cpu.d[1]).toBe(1);
  });

  it('saves a null frame until it is used, then a 68882 idle frame', () => {
    // FSAVE -(A7); FMOVE.L #1,FP0; FSAVE -(A7)
    const { cpu, memory } = fpuWith([0xf327, 0xf23c, 0x4000, 0, 1, 0xf327]);
    run(cpu, 1);
    expect(cpu.a[7]).toBe(STACK - 4);
    expect(read32(memory, STACK - 4)).toBe(0);
    run(cpu, 2);
    expect(cpu.a[7]).toBe(STACK - 4 - 0x3c);
    expect(read32(memory, cpu.a[7]) >>> 16).toBe(0x2038);
  });

  it('is line F without an FPU', () => {
    const { cpu, memory } = cpuWith([0xf23c, 0x4000, 0, 3], '68030');
    write32(memory, 11 * 4, 0x5000);
    run(cpu, 1);
    expect(cpu.pc).toBe(0x5000);
  });
});
