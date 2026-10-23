import { describe, expect, it } from 'vitest';
import { Amiga } from '../src/amiga';
import { ADF_SIZE, FloppyDisk } from '../src/drive/adf';
import { DiskSaves, type DiskSaveRecord, type SaveDiskRecord } from '../src/storage/disk-saves';
import { SaveStates, decodeSession, encodeSession, type SaveStateRecord, type Session } from '../src/storage/save-states';
import { MemoryStore } from '../src/storage/store';
import { bootableAdf, colourLoop } from './helpers/adf';
import { localKickstart, machineWith, runSeconds } from './helpers/machine';

const rom = localKickstart('kick13.rom');

function session(amiga: Amiga): Session {
  return {
    machine: amiga.saveState(),
    kickstartCrc: 0,
    kickstartTitle: 'Kickstart 1.3',
    standard: amiga.standard,
    memory: amiga.memory,
    externalDrive: false,
    disks: [amiga.drives[0].disk ? { name: 'boot', adf: amiga.drives[0].disk.toAdf(), origin: null } : null, null],
  };
}

describe('save states', () => {
  it.skipIf(!rom)('restores the whole machine, which then carries on exactly as the original', async () => {
    const original = machineWith(rom!);
    original.insertDisk(0, FloppyDisk.fromAdf(bootableAdf(colourLoop(0x0f00)), 'boot.adf'));
    runSeconds(original, 3);
    const bytes = await encodeSession(session(original));
    const restored = await decodeSession(bytes);

    const copy = machineWith(rom!);
    copy.drives[0].disk = FloppyDisk.fromAdf(restored.disks[0]!.adf, 'boot');
    copy.loadState(restored.machine);
    for (let frame = 0; frame < 300; frame++) {
      original.runFrame();
      copy.runFrame();
    }
    expect(copy.cpu.pc).toBe(original.cpu.pc);
    expect(copy.agnus.clock).toBe(original.agnus.clock);
    expect(copy.denise.framebuffer).toEqual(original.denise.framebuffer);
    expect(copy.denise.colors[0]).toBe(0xf00);
  }, 120_000);

  it('keeps states in browser storage, newest first, and refuses other files', async () => {
    const states = new SaveStates(new MemoryStore<SaveStateRecord>());
    const amiga = machineWith(new Uint8Array(0x40000));
    await states.add('first', session(amiga));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await states.add('second', session(amiga));
    const list = await states.list();
    expect(list.map((state) => state.name)).toEqual(['second', 'first']);
    expect((await states.load(list[0].id))?.standard).toBe('pal');
    await expect(decodeSession(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not an Amiga save state/);
  });
});

describe('disk saves', () => {
  it("keeps the sectors a game wrote, puts them back when the image goes in again, and reverts", async () => {
    const saves = new DiskSaves(new MemoryStore<DiskSaveRecord>(), new MemoryStore<SaveDiskRecord>());
    const image = new Uint8Array(ADF_SIZE);
    image[0] = 0x44;
    const { disk, hasSavedChanges } = await saves.openImage(0, FloppyDisk.fromAdf(image, 'game.adf'));
    expect(hasSavedChanges).toBe(false);
    disk.sectors[512 * 100] = 0x99;
    await saves.persist(0, disk);

    const again = await saves.openImage(0, FloppyDisk.fromAdf(image, 'game.adf'));
    expect(again.hasSavedChanges).toBe(true);
    expect(again.disk.sectors[512 * 100]).toBe(0x99);
    expect(image[512 * 100]).toBe(0);

    const reverted = await saves.revert(0);
    expect(reverted?.sectors[512 * 100]).toBe(0);
    expect((await saves.openImage(0, FloppyDisk.fromAdf(image, 'game.adf'))).hasSavedChanges).toBe(false);
  });

  it('stores blank save disks whole', async () => {
    const saves = new DiskSaves(new MemoryStore<DiskSaveRecord>(), new MemoryStore<SaveDiskRecord>());
    const { disk, name } = await saves.createSaveDisk(1);
    expect(name).toBe('Save disk 1');
    disk.sectors[5] = 7;
    await saves.persist(1, disk);
    const [info] = await saves.listSaveDisks();
    expect((await saves.saveDiskBytes(info.id))?.[5]).toBe(7);
    expect((await saves.openSaveDisk(0, info.id))?.disk.sectors[5]).toBe(7);
  });
});
