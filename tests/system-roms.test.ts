import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KICKSTART_256K,
  NeedsRomKey,
  SystemRomStore,
  identifyKickstart,
  joinSplitKickstart,
  kickstartChecksumOk,
  preferredKickstart,
  rankKickstarts,
  suitsModel,
  type StoredRom,
} from '../src/roms/system-roms';
import { modelById } from '../src/models';
import { MemoryStore } from '../src/storage/store';
import { localRoms } from './helpers/machine';

/** A made-up 256K Kickstart: the header, a version, and a checksum that comes out right. */
function fakeKickstart(): Uint8Array {
  const rom = new Uint8Array(KICKSTART_256K);
  rom.set([0x11, 0x11, 0x4e, 0xf9, 0x00, 0xfc, 0x00, 0xd2, 0, 0, 0xff, 0xff, 0x00, 0x22, 0x00, 0x05]);
  for (let i = 0x100; i < rom.length - 0x100; i++) rom[i] = (i * 7) & 0xff;
  const view = new DataView(rom.buffer);
  let sum = 0;
  for (let i = 0; i < rom.length; i += 4) {
    sum += view.getUint32(i);
    if (sum > 0xffffffff) sum -= 0xffffffff;
  }
  // The checksum word goes near the end, as in the real ROMs.
  view.setUint32(rom.length - 0x18, (0xffffffff - sum) >>> 0);
  return rom;
}

const swap = (data: Uint8Array) => data.map((_, i) => data[i ^ 1]);
const encrypt = (data: Uint8Array, key: Uint8Array) => {
  const out = new Uint8Array(11 + data.length);
  out.set([...'AMIROMTYPE1'].map((char) => char.charCodeAt(0)));
  data.forEach((byte, i) => (out[11 + i] = byte ^ key[i % key.length]));
  return out;
};

describe('Kickstart identification', () => {
  const rom = fakeKickstart();

  it('accepts a Kickstart it doesn\'t know, with a warning, and names it from its header', () => {
    expect(kickstartChecksumOk(rom)).toBe(true);
    const result = identifyKickstart('custom.rom', rom);
    expect(result.title).toBe('Kickstart 1.3 (34.5)');
    expect(result.warning).toMatch(/not an original/);
  });

  it('undoes byte-swapped dumps and overdumps', () => {
    expect(identifyKickstart('swapped.rom', swap(rom)).data).toEqual(rom);
    const doubled = new Uint8Array(rom.length * 2);
    doubled.set(rom);
    doubled.set(rom, rom.length);
    expect(identifyKickstart('overdump.rom', doubled).data).toEqual(rom);
  });

  it('decrypts Amiga Forever ROMs with rom.key, and asks for the key without it', () => {
    const key = Uint8Array.from({ length: 1000 }, (_, i) => (i * 31 + 7) & 0xff);
    const file = encrypt(rom, key);
    expect(() => identifyKickstart('amiga-os-130.rom', file)).toThrow(NeedsRomKey);
    expect(identifyKickstart('amiga-os-130.rom', file, key).data).toEqual(rom);
    expect(() => identifyKickstart('amiga-os-130.rom', file, new Uint8Array([1, 2, 3]))).toThrow(/didn't decrypt/);
  });

  it('joins the two halves of a ROM dumped from its two chips, in either order', () => {
    const high = rom.filter((_, i) => i % 2 === 0);
    const low = rom.filter((_, i) => i % 2 === 1);
    expect(joinSplitKickstart(high, low)).toEqual(rom);
    expect(joinSplitKickstart(low, high)).toEqual(rom);
    expect(joinSplitKickstart(high, high)).toBeNull();
  });

  it('turns away files that are not Kickstarts', () => {
    expect(() => identifyKickstart('game.adf', new Uint8Array(901120))).toThrow(/isn't a Kickstart/);
    expect(() => identifyKickstart('zeros.rom', new Uint8Array(KICKSTART_256K))).toThrow(/doesn't start like one/);
  });

  it('flags a damaged ROM by its checksum', () => {
    const damaged = rom.slice();
    damaged[0x1000] ^= 0xff;
    expect(identifyKickstart('damaged.rom', damaged).warning).toMatch(/checksum/);
  });

  it('keeps the ROM in browser storage', async () => {
    const store = new SystemRomStore(new MemoryStore<StoredRom>());
    expect(await store.load()).toBeNull();
    await store.save(identifyKickstart('custom.rom', rom));
    expect((await store.load())?.data).toEqual(rom);
    await store.forget();
    expect(await store.load()).toBeNull();
  });
});

describe('real Kickstarts from roms/', () => {
  const real = (name: string) => (existsSync(join(localRoms, name)) ? new Uint8Array(readFileSync(join(localRoms, name))) : null);

  it.skipIf(!real('kick13.rom'))('recognises Kickstart 1.3', () => {
    const result = identifyKickstart('kick13.rom', real('kick13.rom')!);
    expect(result.title).toBe('Kickstart 1.3 (34.5)');
    expect(result.warning).toBeNull();
  });

  it.skipIf(!real('kick13.rom') || !real('kick31.rom') || !real('kick12.rom'))('picks the newest from several, as from a ROM collection, and keeps the others to switch to', async () => {
    const roms = ['kick12.rom', 'kick13.rom', 'kick31.rom', 'kick13-overdump.rom'].map((name) => identifyKickstart(name, real(name)!));
    expect(preferredKickstart(roms).title).toBe('Kickstart 3.1 (40.63, A500/A600/A2000)');
    // The overdump is the same ROM as kick13.rom, so it is offered once.
    expect(rankKickstarts(roms).map((rom) => rom.title)).toEqual([
      'Kickstart 3.1 (40.63, A500/A600/A2000)',
      'Kickstart 1.3 (34.5)',
      'Kickstart 1.2 (33.180)',
    ]);
    const store = new SystemRomStore(new MemoryStore<StoredRom>());
    await store.save(roms[2]);
    await store.saveChoices(rankKickstarts(roms));
    expect((await store.loadChoices()).length).toBe(3);
    expect((await store.load())?.title).toBe('Kickstart 3.1 (40.63, A500/A600/A2000)');
    await store.forget();
    expect(await store.loadChoices()).toEqual([]);
  });

  it.skipIf(!real('kick31.rom') || !real('kick31-a1200.rom') || !real('kick30-a1200.rom'))('picks the A1200\'s own Kickstart for an A1200, and an A500 one otherwise', () => {
    const roms = ['kick31.rom', 'kick30-a1200.rom', 'kick31-a1200.rom'].map((name) => identifyKickstart(name, real(name)!));
    const a1200 = modelById('a1200');
    expect(roms[2].title).toBe('Kickstart 3.1 (40.68, A1200)');
    expect(roms[2].requires).toBe('a1200');
    expect(suitsModel(roms[2], modelById('a500'))).toBe(false);
    expect(suitsModel(roms[0], a1200)).toBe(true);
    expect(preferredKickstart(roms).title).toBe('Kickstart 3.1 (40.63, A500/A600/A2000)');
    expect(preferredKickstart(roms, a1200).title).toBe('Kickstart 3.1 (40.68, A1200)');
    expect(rankKickstarts(roms, a1200).map((rom) => rom.title)).toEqual([
      'Kickstart 3.1 (40.68, A1200)',
      'Kickstart 3.0 (39.106, A1200)',
      'Kickstart 3.1 (40.63, A500/A600/A2000)',
    ]);
    // With only the A1200's ROMs, an A500 still gets one (Machine setup then switches the model).
    expect(preferredKickstart(roms.slice(1), modelById('a500')).requires).toBe('a1200');
  });

  it.skipIf(!real('kick31-a4000.rom'))('turns away the Kickstarts of models not emulated yet', () => {
    expect(() => identifyKickstart('kick31-a4000.rom', real('kick31-a4000.rom')!)).toThrow(/A4000/);
  });

  it.skipIf(!real('kick13-overdump.rom'))('recognises an overdump of it', () => {
    expect(identifyKickstart('kick34005.A500', real('kick13-overdump.rom')!).title).toBe('Kickstart 1.3 (34.5)');
  });

  it.skipIf(!real('kick12-encrypted.rom'))('asks for rom.key for an encrypted Kickstart 1.2', () => {
    expect(() => identifyKickstart('kick12.rom', real('kick12-encrypted.rom')!)).toThrow(NeedsRomKey);
  });
});
