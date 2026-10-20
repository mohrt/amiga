import { ADF_SIZE, FloppyDisk } from '../drive/adf';
import { SECTOR_BYTES } from '../drive/mfm';
import type { KeyValueStore } from './store';

/** Sectors a program wrote to a disk image, by sector number (0-1759). */
export interface DiskSaveRecord {
  name: string;
  updated: number;
  sectors: Record<string, Uint8Array>;
}

/** A blank disk created in the emulator for saving games, stored whole. */
export interface SaveDiskRecord {
  name: string;
  created: number;
  updated: number;
  bytes: Uint8Array;
}

export interface SaveDiskInfo {
  id: string;
  name: string;
  updated: number;
}

export async function fingerprint(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The sectors of `current` that differ from `original`. */
export function changedSectors(original: Uint8Array, current: Uint8Array): Record<string, Uint8Array> {
  const changes: Record<string, Uint8Array> = {};
  for (let sector = 0; sector * SECTOR_BYTES < ADF_SIZE; sector++) {
    const start = sector * SECTOR_BYTES;
    for (let i = start; i < start + SECTOR_BYTES; i++) {
      if (original[i] !== current[i]) {
        changes[sector] = current.slice(start, start + SECTOR_BYTES);
        break;
      }
    }
  }
  return changes;
}

/** Where the changes to a drive's disk are kept. */
export type DiskOrigin =
  | { kind: 'image'; key: string; name: string; original: Uint8Array }
  | { kind: 'saveDisk'; id: string; name: string };

/**
 * Keeps games' saves in browser storage without ever modifying the user's
 * disk images: for a dropped image only the changed sectors are stored, keyed
 * by a fingerprint of the original, and put back whenever that image is
 * inserted again. Blank save disks made in the emulator are stored whole.
 * Each drive has its own origin.
 */
export class DiskSaves {
  private readonly origins: (DiskOrigin | null)[] = [null, null];

  constructor(
    private readonly overlays: KeyValueStore<DiskSaveRecord>,
    private readonly saveDisks: KeyValueStore<SaveDiskRecord>,
  ) {}

  /** A disk for a dropped image, with its stored changes applied. */
  async openImage(drive: number, image: FloppyDisk): Promise<{ disk: FloppyDisk; hasSavedChanges: boolean }> {
    const original = image.sectors.slice();
    const key = await fingerprint(original);
    const record = await this.overlays.get(key);
    if (record) {
      for (const [sector, data] of Object.entries(record.sectors)) image.sectors.set(data, Number(sector) * SECTOR_BYTES);
    }
    this.origins[drive] = { kind: 'image', key, name: image.name, original };
    return { disk: image, hasSavedChanges: record !== undefined };
  }

  async createSaveDisk(drive: number): Promise<{ disk: FloppyDisk; name: string }> {
    const count = (await this.saveDisks.entries()).length;
    const name = `Save disk ${count + 1}`;
    const now = Date.now();
    const id = `save-${now}`;
    await this.saveDisks.put(id, { name, created: now, updated: now, bytes: new Uint8Array(ADF_SIZE) });
    this.origins[drive] = { kind: 'saveDisk', id, name };
    return { disk: FloppyDisk.blank(name), name };
  }

  async openSaveDisk(drive: number, id: string): Promise<{ disk: FloppyDisk; name: string } | null> {
    const record = await this.saveDisks.get(id);
    if (!record) return null;
    this.origins[drive] = { kind: 'saveDisk', id, name: record.name };
    return { disk: FloppyDisk.fromAdf(record.bytes, record.name), name: record.name };
  }

  async listSaveDisks(): Promise<SaveDiskInfo[]> {
    const entries = await this.saveDisks.entries();
    return entries.map(([id, record]) => ({ id, name: record.name, updated: record.updated })).sort((a, b) => a.updated - b.updated);
  }

  async saveDiskBytes(id: string): Promise<Uint8Array | null> {
    return (await this.saveDisks.get(id))?.bytes ?? null;
  }

  async deleteSaveDisk(id: string): Promise<void> {
    await this.saveDisks.delete(id);
    this.origins.forEach((origin, drive) => {
      if (origin?.kind === 'saveDisk' && origin.id === id) this.origins[drive] = null;
    });
  }

  origin(drive: number): DiskOrigin | null {
    return this.origins[drive];
  }

  /** Stores what has been written to a drive's disk. */
  async persist(drive: number, disk: FloppyDisk): Promise<void> {
    const origin = this.origins[drive];
    if (!origin) return;
    const current = disk.toAdf();
    if (origin.kind === 'saveDisk') {
      const record = await this.saveDisks.get(origin.id);
      if (record) await this.saveDisks.put(origin.id, { ...record, updated: Date.now(), bytes: current });
      return;
    }
    const sectors = changedSectors(origin.original, current);
    if (Object.keys(sectors).length === 0) await this.overlays.delete(origin.key);
    else await this.overlays.put(origin.key, { name: origin.name, updated: Date.now(), sectors });
  }

  /** Forgets the stored changes to a drive's image and returns a clean copy of it. */
  async revert(drive: number): Promise<FloppyDisk | null> {
    const origin = this.origins[drive];
    if (origin?.kind !== 'image') return null;
    await this.overlays.delete(origin.key);
    return FloppyDisk.fromAdf(origin.original, origin.name);
  }

  eject(drive: number): void {
    this.origins[drive] = null;
  }

  /** Makes later saves go where a restored save state's disk came from. */
  adopt(drive: number, origin: DiskOrigin | null): void {
    this.origins[drive] = origin;
  }
}
