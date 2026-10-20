import { FloppyDisk } from './adf';
import { isZip, usableFilesInZip } from './zip';

export const STATE_EXTENSION = '.amigastate';

export type Media = { kind: 'disk'; disk: FloppyDisk } | { kind: 'state'; bytes: Uint8Array };

const isGzip = (data: Uint8Array) => data[0] === 0x1f && data[1] === 0x8b;

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files a dropped file stands for: itself, or the usable files in a zip (best first). */
export async function filesFrom(file: File): Promise<File[]> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (!isZip(head)) return [file];
  const files = await usableFilesInZip(new Uint8Array(await file.arrayBuffer()));
  if (files.length === 0) throw new Error(`${file.name} has no .adf or .adz disk images in it.`);
  return files;
}

/** Works out what a file is: a disk image (.adf, gzipped .adz, extended ADF) or a save state. */
export async function readMedia(file: File): Promise<Media> {
  const name = file.name.toLowerCase();
  let data: Uint8Array = new Uint8Array(await file.arrayBuffer());
  if (name.endsWith(STATE_EXTENSION)) return { kind: 'state', bytes: data };
  if (name.endsWith('.dms')) throw new Error(`${file.name} is a DMS archive; unpack it to an .adf first (with xDMS, for example).`);
  if (name.endsWith('.ipf')) throw new Error(`${file.name} is an IPF image, which this emulator can't read; use an .adf.`);
  if (isGzip(data)) {
    data = await gunzip(data);
    // A gzipped save state (exported states are gzipped too) rather than a disk.
    if (data[0] === 0x7b) return { kind: 'state', bytes: new Uint8Array(await file.arrayBuffer()) };
  }
  return { kind: 'disk', disk: FloppyDisk.fromAdf(data, file.name) };
}

/** "Lemmings (Disk 1 of 2).adf" → "Lemmings (Disk 1 of 2)". */
export function titleFromFileName(name: string): string {
  return name.replace(/\.(adf|adz|zip)$/i, '').trim() || name;
}
