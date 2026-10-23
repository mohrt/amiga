import type { MemoryConfig } from './amiga';
import type { CpuModel } from './cpu/m68k';

/** The Amigas the emulator can be. */
export type ModelId = 'a500' | 'a1000' | 'a2000' | 'a500plus' | 'a600' | 'a1200' | 'a3000' | 'a4000';

/** The custom chips: the original ones, the Enhanced Chip Set (Super Agnus and Super Denise), or AGA. */
export type Chipset = 'ocs' | 'ecs' | 'aga';

export interface MemoryOption {
  key: string;
  config: MemoryConfig;
}

const option = (key: string, chipKb: MemoryConfig['chipKb'], slowKb: MemoryConfig['slowKb'], fastKb: MemoryConfig['fastKb'] = 0): MemoryOption => ({
  key,
  config: { chipKb, slowKb, fastKb },
});

export interface ModelSpec {
  id: ModelId;
  name: string;
  year: number;
  cpu: CpuModel;
  chipset: Chipset;
  /** Memory setups offered, by the value of Machine setup's menu; the first is the default. */
  memory: MemoryOption[];
  /** A battery-backed clock (the MSM6242B at $DC0000). */
  clock: boolean;
  /** The IDE port on the main board (Gayle), rather than one added on. */
  ideBuiltIn: boolean;
  /** Where the hard drive goes: an A600-style Gayle port (built in or added on), the A4000's own port, or the A3000's SCSI controller. */
  ide?: 'a4000' | 'scsi';
  /** Ramsey's revision, for the models with their 32-bit fast RAM (and Gary) on the main board. */
  ramsey?: number;
  /** The A3000's SCSI controller. */
  scsi?: boolean;
  /** Which Kickstarts suit it, newest first (by their major version), for picking from a collection. */
  kickstarts: number[];
  /** Shown in Machine setup. */
  romHint: string;
  /** Not available yet (its CPU or chips aren't emulated). */
  unavailable?: string;
}

const OCS_MEMORY = [option('512+512', 512, 512), option('512', 512, 0), option('1024', 1024, 0)];

const ZORRO_MEMORY = [
  option('512+512', 512, 512),
  option('1024', 1024, 0),
  option('1024+2048', 1024, 0, 2048),
  option('1024+4096', 1024, 0, 4096),
  option('1024+8192', 1024, 0, 8192),
];

export const MODELS: ModelSpec[] = [
  {
    id: 'a500',
    name: 'Amiga 500',
    year: 1987,
    cpu: '68000',
    chipset: 'ocs',
    memory: OCS_MEMORY,
    clock: false,
    ideBuiltIn: false,
    kickstarts: [34, 33, 40, 37],
    romHint: 'Kickstart 1.3 runs the most A500 games; 1.2, 2.04 and 3.1 for the A500 work too.',
  },
  {
    id: 'a1000',
    name: 'Amiga 1000',
    year: 1985,
    cpu: '68000',
    chipset: 'ocs',
    memory: [option('512', 512, 0), option('256', 256, 0)],
    clock: false,
    ideBuiltIn: false,
    kickstarts: [33, 34, 31, 30],
    romHint: 'The A1000 loaded Kickstart from a disk into its own memory; an image of Kickstart 1.0 to 1.3 goes in here directly.',
  },
  {
    id: 'a2000',
    name: 'Amiga 2000',
    year: 1987,
    cpu: '68000',
    chipset: 'ocs',
    memory: ZORRO_MEMORY,
    clock: true,
    ideBuiltIn: false,
    kickstarts: [34, 33, 40, 37],
    romHint: 'Kickstart 1.3 (or 1.2), as the A500; 2.04 and 3.1 for the A500/A2000 work too.',
  },
  {
    id: 'a500plus',
    name: 'Amiga 500 Plus',
    year: 1991,
    cpu: '68000',
    chipset: 'ecs',
    memory: [option('1024', 1024, 0), option('2048', 2048, 0)],
    clock: true,
    ideBuiltIn: false,
    kickstarts: [37, 40, 34],
    romHint: 'Kickstart 2.04 is the A500 Plus\u2019s own; 3.1 for the A500/A2000 works too.',
  },
  {
    id: 'a600',
    name: 'Amiga 600',
    year: 1992,
    cpu: '68000',
    chipset: 'ecs',
    memory: [option('1024', 1024, 0), option('2048', 2048, 0)],
    clock: false,
    ideBuiltIn: true,
    kickstarts: [37, 40],
    romHint: 'Kickstart 2.05 is the A600\u2019s own (its scsi.device drives the IDE port); 3.1 for the A500/A2000/A600 works too.',
  },
  {
    id: 'a1200',
    name: 'Amiga 1200',
    year: 1992,
    cpu: '68ec020',
    chipset: 'aga',
    memory: [option('2048', 2048, 0), option('2048+4096', 2048, 0, 4096), option('2048+8192', 2048, 0, 8192)],
    clock: false,
    ideBuiltIn: true,
    kickstarts: [40, 39],
    romHint: 'Kickstart 3.0 or 3.1 for the A1200 (its own, 39.106 or 40.68); the A500\u2019s 1.3 starts on it too.',
  },
  {
    id: 'a3000',
    name: 'Amiga 3000',
    year: 1990,
    cpu: '68030',
    chipset: 'ecs',
    memory: [option('1024+4096', 1024, 0, 4096), option('2048+8192', 2048, 0, 8192), option('2048+16384', 2048, 0, 16384), option('1024', 1024, 0)],
    clock: true,
    ideBuiltIn: false,
    ide: 'scsi',
    ramsey: 0x0d,
    scsi: true,
    kickstarts: [40],
    romHint: 'Kickstart 3.1 for the A3000 (its own, 40.68).',
  },
  {
    id: 'a4000',
    name: 'Amiga 4000',
    year: 1992,
    cpu: '68030',
    chipset: 'aga',
    memory: [option('2048+4096', 2048, 0, 4096), option('2048+8192', 2048, 0, 8192), option('2048+16384', 2048, 0, 16384), option('2048', 2048, 0)],
    clock: true,
    ideBuiltIn: true,
    ide: 'a4000',
    ramsey: 0x0f,
    kickstarts: [40, 39],
    romHint: 'Kickstart 3.0 or 3.1 for the A4000 (its own, 39.106 or 40.68).',
  },
];

export const DEFAULT_MODEL: ModelId = 'a500';

export function modelById(id: string | undefined): ModelSpec {
  return MODELS.find((model) => model.id === id && !model.unavailable) ?? MODELS.find((model) => model.id === DEFAULT_MODEL)!;
}

/** The model's memory setup matching `memory`, or its default if it has no such setup. */
export function memoryOption(model: ModelSpec, memory: MemoryConfig): MemoryOption {
  const { chipKb, slowKb, fastKb } = memory;
  return model.memory.find(({ config }) => config.chipKb === chipKb && config.slowKb === slowKb && config.fastKb === fastKb) ?? model.memory[0];
}

/** The model's memory setup by its menu value, or its default. */
export function memoryByKey(model: ModelSpec, key: string): MemoryConfig {
  return (model.memory.find((entry) => entry.key === key) ?? model.memory[0]).config;
}
