import type { ModelId, ModelSpec } from '../models';
import type { KeyValueStore } from '../storage/store';
import { crc32 } from '../util/crc32';

export const KICKSTART_256K = 0x40000;
export const KICKSTART_512K = 0x80000;

/** Amiga Forever's encrypted ROMs: this header, then the ROM XORed with the bytes of rom.key over and over. */
const ENCRYPTED_MAGIC = 'AMIROMTYPE1';

interface KnownRom {
  name: string;
  /** Set for ROMs made for a later Amiga that isn't emulated yet. */
  unsuitable?: string;
  /** The model a ROM needs (the A1200's for its 68EC020 and AGA chips, the A4000's for its 68030 and main board). */
  requires?: ModelId;
}

/** CRC-32s of the original Commodore Kickstarts. */
const KNOWN_ROMS: Record<number, KnownRom> = {
  0xa6ce1636: { name: 'Kickstart 1.2 (33.180)' },
  0x9ed783d0: { name: 'Kickstart 1.2 (33.166, A1000)' },
  0xc4f0f55f: { name: 'Kickstart 1.3 (34.5)' },
  0xc3bdb240: { name: 'Kickstart 2.04 (37.175, A500+)' },
  0x83028fb5: { name: 'Kickstart 2.05 (37.299, A600)' },
  0x64466c2a: { name: 'Kickstart 2.05 (37.300, A600HD)' },
  0x43b0df7b: { name: 'Kickstart 2.05 (37.350, A600HD)' },
  0xfc24ae0d: { name: 'Kickstart 3.1 (40.63, A500/A600/A2000)' },
  0x299790ff: { name: 'Kickstart 1.0 (A1000)', unsuitable: 'it is the A1000 boot disk ROM' },
  0xd060572a: { name: 'Kickstart 1.1 (31.34, A1000)', unsuitable: 'it is the A1000 boot disk ROM' },
  0xec86dae2: { name: 'Kickstart 1.1 (32.34, A1000)', unsuitable: 'it is the A1000 boot disk ROM' },
  0xe0f37258: { name: 'Kickstart 1.3 (34.5, A3000)', unsuitable: 'it is the A3000 SuperKickstart, which loads Kickstart from disk' },
  0xb4113910: { name: 'Kickstart 2.0 (36.28, A3000)', unsuitable: 'it is the A3000 SuperKickstart, which loads Kickstart from disk' },
  0x9a15519d: { name: 'Kickstart 2.02 (36.207, A3000)', unsuitable: 'it is the A3000 SuperKickstart, which loads Kickstart from disk' },
  0x6c9b07d2: { name: 'Kickstart 3.0 (39.106, A1200)', requires: 'a1200' },
  0x9e6ac152: { name: 'Kickstart 3.0 (39.106, A4000)', requires: 'a4000' },
  0x1483a091: { name: 'Kickstart 3.1 (40.68, A1200)', requires: 'a1200' },
  0xefb239cc: { name: 'Kickstart 3.1 (40.68, A3000)', requires: 'a3000' },
  0xd6bae334: { name: 'Kickstart 3.1 (40.68, A4000)', requires: 'a4000' },
  0x2b4566f1: { name: 'Kickstart 3.1 (40.70, A4000)', requires: 'a4000' },
  0x75932c3a: { name: 'Kickstart 3.1 (40.70, A4000T)', unsuitable: 'it is made for the A4000T (68040 and AGA)' },
  0x1e62d4a5: { name: 'Kickstart 3.1 (40.60, CD32)', unsuitable: 'it is made for the CD32 (68020 and AGA)' },
};

/** Commodore's Kickstarts for an A500, newest first: 3.1, 2.05, 2.04, 1.3, 1.2; then the A1200's 3.1 and 3.0, and the A4000's. */
const PREFERRED_ROMS = [
  0xfc24ae0d, 0x43b0df7b, 0x64466c2a, 0x83028fb5, 0xc3bdb240, 0xc4f0f55f, 0xa6ce1636, 0x9ed783d0, 0x1483a091, 0x6c9b07d2, 0x2b4566f1, 0xd6bae334,
  0x9e6ac152,
];

/** Whether a Kickstart starts on the model: the A1200's and A4000's ROMs need that model. */
export function suitsModel(rom: Kickstart, model: ModelSpec): boolean {
  return !rom.requires || rom.requires === model.id;
}

function preferenceRank(rom: Kickstart, model?: ModelSpec): number {
  // A model's own ROMs come first (the A1200's for an A1200).
  const own = model && rom.requires === model.id ? -PREFERRED_ROMS.length : 0;
  const known = PREFERRED_ROMS.indexOf(crc32(rom.data));
  if (known >= 0) return own + known;
  return own + PREFERRED_ROMS.length + (rom.warning ? 1 : 0);
}

const IDE_DRIVER = [...'scsi.device'].map((char) => char.charCodeAt(0));

/** Whether a Kickstart has the A600's IDE driver (scsi.device), as 2.05 and 3.1 do; 1.x and the A500+'s 2.04 don't. */
export function hasIdeDriver(rom: Uint8Array): boolean {
  outer: for (let i = 0; i <= rom.length - IDE_DRIVER.length; i++) {
    for (let j = 0; j < IDE_DRIVER.length; j++) if (rom[i + j] !== IDE_DRIVER[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Several Kickstarts (a ROM collection's) best first, each ROM once. Collections also hold
 * betas, hacks and ROMs for other models; when Commodore's own A500 ROMs are among them, only those count.
 */
export function rankKickstarts(roms: Kickstart[], model?: ModelSpec): Kickstart[] {
  const unique = new Map<number, Kickstart>();
  for (const rom of roms) {
    const crc = crc32(rom.data);
    if (!unique.has(crc)) unique.set(crc, rom);
  }
  const all = [...unique.values()];
  const originals = all.filter((rom) => PREFERRED_ROMS.includes(crc32(rom.data)));
  return (originals.length ? originals : all).sort((a, b) => preferenceRank(a, model) - preferenceRank(b, model));
}

/** The Kickstart to use from several: the newest Commodore made for the model (the A500 if none is given) that starts on it. */
export function preferredKickstart(roms: Kickstart[], model?: ModelSpec): Kickstart {
  const ranked = rankKickstarts(roms, model);
  return ranked.find((rom) => !model || suitsModel(rom, model)) ?? ranked[0];
}

/** Kickstart versions (from the ROM header) by the number Commodore marketed them as. */
const MARKETED_VERSIONS: [number, string][] = [
  [40, '3.1'],
  [39, '3.0'],
  [37, '2.04'],
  [36, '2.0'],
  [34, '1.3'],
  [33, '1.2'],
  [31, '1.1'],
];

export interface StoredRom {
  /** The file it came from, shown to the user. */
  name: string;
  data: Uint8Array;
}

export interface Kickstart extends StoredRom {
  /** e.g. "Kickstart 1.3 (34.5)". */
  title: string;
  /** Set when the ROM isn't one Commodore shipped for an A500-class machine. */
  warning: string | null;
  /** The model it needs, for the A1200's and A4000's ROMs. */
  requires?: ModelId;
}

/** Thrown for an Amiga Forever ROM when no rom.key has been given yet. */
export class NeedsRomKey extends Error {
  constructor(readonly fileName: string) {
    super(`${fileName} is encrypted. Add the rom.key file that came with it (Amiga Forever keeps it next to the ROMs).`);
  }
}

const startsWith = (data: Uint8Array, text: string) => [...text].every((char, i) => data[i] === char.charCodeAt(0));

export function isEncryptedRom(data: Uint8Array): boolean {
  return startsWith(data, ENCRYPTED_MAGIC);
}

export function decryptRom(data: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length === 0) throw new Error('That rom.key file is empty.');
  const body = data.subarray(ENCRYPTED_MAGIC.length);
  return body.map((byte, i) => byte ^ key[i % key.length]);
}

/** Every Kickstart starts with $1111 (256K) or $1114 (512K) and a JMP to its start. */
function hasKickstartHeader(data: Uint8Array): boolean {
  return data[0] === 0x11 && (data[1] === 0x11 || data[1] === 0x14) && data[2] === 0x4e && data[3] === 0xf9;
}

/** Whether a file starts like a Kickstart, straight or byte-swapped. */
export function looksLikeKickstart(data: Uint8Array): boolean {
  return hasKickstartHeader(data) || (data[1] === 0x11 && data[3] === 0x4e && data[2] === 0xf9);
}

function swapBytes(data: Uint8Array): Uint8Array {
  const swapped = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 2) {
    swapped[i] = data[i + 1];
    swapped[i + 1] = data[i];
  }
  return swapped;
}

/** Kickstarts are built so that their longwords, added with end-around carry, come to $FFFFFFFF. */
export function kickstartChecksumOk(data: Uint8Array): boolean {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += view.getUint32(i);
    if (sum > 0xffffffff) sum -= 0xffffffff;
  }
  return sum === 0xffffffff;
}

function versionTitle(data: Uint8Array): string {
  const version = (data[12] << 8) | data[13];
  const revision = (data[14] << 8) | data[15];
  if (version === 0xffff) return 'Kickstart';
  const marketed = MARKETED_VERSIONS.find(([number]) => version >= number)?.[1];
  return `Kickstart ${marketed ?? '?'} (${version}.${revision})`;
}

/** A 512K file holding a 256K ROM twice (an "overdump") is the 256K ROM. */
function trimOverdump(data: Uint8Array): Uint8Array {
  if (data.length !== KICKSTART_512K) return data;
  const half = KICKSTART_256K;
  for (let i = 0; i < half; i++) if (data[i] !== data[i + half]) return data;
  return data.slice(0, half);
}

/**
 * Works out whether a file is a Kickstart an A500 can start, after decrypting
 * it (with `key`) and undoing byte-swapped dumps and overdumps. Throws if it
 * isn't one.
 */
export function identifyKickstart(name: string, file: Uint8Array, key?: Uint8Array): Kickstart {
  let data = file;
  if (isEncryptedRom(data)) {
    if (!key) throw new NeedsRomKey(name);
    data = decryptRom(data, key);
    if (!hasKickstartHeader(trimOverdump(data)) && !hasKickstartHeader(swapBytes(data))) {
      throw new Error(`${name} didn't decrypt to a Kickstart with that rom.key. Use the key that came with the ROM.`);
    }
  }
  data = trimOverdump(data);
  if (data.length !== KICKSTART_256K && data.length !== KICKSTART_512K) {
    throw new Error(
      `${name} is ${data.length.toLocaleString('en')} bytes, which isn't a Kickstart ROM. ` +
        'Kickstarts are 262,144 bytes (1.2 and 1.3) or 524,288 bytes (2.04 and later).',
    );
  }
  if (!hasKickstartHeader(data) && hasKickstartHeader(swapBytes(data))) data = swapBytes(data);
  if (!hasKickstartHeader(data)) {
    throw new Error(`${name} is the size of a Kickstart ROM but doesn't start like one. Check it is a Kickstart image.`);
  }

  const known = KNOWN_ROMS[crc32(data)];
  if (known?.unsuitable) {
    throw new Error(
      `${known.name} won't start on the Amigas emulated here yet: ${known.unsuitable}. ` +
        'Use Kickstart 1.3, 2.04 or 3.1 for the A500/A2000, 2.05 for the A600, or 3.0 or 3.1 for the A1200, A3000 or A4000.',
    );
  }
  if (known) return { name, data, title: known.name, warning: null, ...(known.requires ? { requires: known.requires } : {}) };
  const warning = kickstartChecksumOk(data)
    ? 'not an original Commodore ROM for the A500; it may not start'
    : 'its checksum is wrong, so it is probably damaged';
  return { name, data, title: versionTitle(data), warning };
}

/**
 * Two halves of a Kickstart dumped from its two chips (even and odd bytes),
 * put back together; null if they don't make a Kickstart either way round.
 */
export function joinSplitKickstart(first: Uint8Array, second: Uint8Array): Uint8Array | null {
  if (first.length !== second.length || (first.length !== KICKSTART_256K / 2 && first.length !== KICKSTART_512K / 2)) return null;
  for (const [high, low] of [
    [first, second],
    [second, first],
  ]) {
    const joined = new Uint8Array(first.length * 2);
    for (let i = 0; i < first.length; i++) {
      joined[i * 2] = high[i];
      joined[i * 2 + 1] = low[i];
    }
    if (hasKickstartHeader(joined)) return joined;
  }
  return null;
}

const KICKSTART_KEY = 'kickstart';
const CHOICE_PREFIX = 'choice-';

/**
 * The user's Kickstart, kept in browser storage (IndexedDB) so it only has to
 * be given once. Saving asks the browser to make the storage persistent, which
 * stops it evicting the ROM under storage pressure; browsers are likelier to
 * grant that right after a user action like choosing files.
 */
export class SystemRomStore {
  constructor(private readonly store: KeyValueStore<StoredRom>) {}

  async load(): Promise<Kickstart | null> {
    const stored = await this.store.get(KICKSTART_KEY);
    if (!stored) return null;
    try {
      return identifyKickstart(stored.name, stored.data);
    } catch {
      return null;
    }
  }

  save(rom: Kickstart): Promise<void> {
    void globalThis.navigator?.storage?.persist?.().catch(() => false);
    return this.store.put(KICKSTART_KEY, { name: rom.name, data: rom.data });
  }

  /** The other Kickstarts that came with it (from a collection), offered to switch to. */
  async loadChoices(): Promise<Kickstart[]> {
    const choices: Kickstart[] = [];
    for (const [key, stored] of await this.store.entries()) {
      if (!key.startsWith(CHOICE_PREFIX)) continue;
      try {
        choices.push(identifyKickstart(stored.name, stored.data));
      } catch {
        // A ROM that no longer identifies is left out.
      }
    }
    return rankKickstarts(choices);
  }

  /** Replaces the Kickstarts offered to switch to. */
  async saveChoices(roms: Kickstart[]): Promise<void> {
    await this.forgetChoices();
    for (const rom of roms) await this.store.put(`${CHOICE_PREFIX}${crc32(rom.data).toString(16)}`, { name: rom.name, data: rom.data });
  }

  private async forgetChoices(): Promise<void> {
    for (const [key] of await this.store.entries()) if (key.startsWith(CHOICE_PREFIX)) await this.store.delete(key);
  }

  async forget(): Promise<void> {
    await this.store.delete(KICKSTART_KEY);
    await this.forgetChoices();
  }
}
