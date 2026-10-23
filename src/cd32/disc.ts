import type { CdDisc } from './akiko';

const RAW_SECTOR = 2352;
const DATA_SECTOR = 2048;
/** Sector numbers count from the end of the two-second lead-in. */
const LEAD_IN = 150;
/** TOC control bits: a data track (audio tracks have none). */
const CONTROL_DATA = 0x04;
const ADR_POSITION = 0x01;
const POINT_FIRST_TRACK = 0xa0;
const POINT_LAST_TRACK = 0xa1;
const POINT_LEAD_OUT = 0xa2;

interface Track {
  number: number;
  audio: boolean;
  /** Where it starts on the disc, and how many sectors it has. */
  start: number;
  length: number;
  /** Its sectors in the image file: from this offset, raw (2352 bytes) or data only (2048). */
  file: Uint8Array;
  offset: number;
  sectorBytes: number;
}

const bcd = (value: number) => ((Math.floor(value / 10) % 10) << 4) | value % 10;

/** Minutes, seconds and frames (75 a second) of a sector number, lead-in included. */
function msf(lsn: number): [number, number, number] {
  const frames = lsn + LEAD_IN;
  return [Math.floor(frames / (60 * 75)), Math.floor(frames / 75) % 60, frames % 75];
}

/**
 * A CD image for the CD32's drive: an ISO (one data track of 2048-byte
 * sectors), or a CUE sheet with its BIN files (data and audio tracks, raw or
 * data-only). Data sectors without their raw framing get it made up: the sync
 * pattern and the header with the sector's address (the CD32 reads them raw).
 */
export class CdImage implements CdDisc {
  readonly toc: Uint8Array[];
  readonly sectorCount: number;

  private constructor(private readonly tracks: Track[]) {
    const last = tracks[tracks.length - 1];
    this.sectorCount = last.start + last.length;
    this.toc = this.buildToc();
  }

  static fromIso(bytes: Uint8Array): CdImage {
    const length = Math.floor(bytes.length / DATA_SECTOR);
    return new CdImage([{ number: 1, audio: false, start: 0, length, file: bytes, offset: 0, sectorBytes: DATA_SECTOR }]);
  }

  /**
   * A CUE sheet and the files it names (by name, case aside). Each FILE's
   * tracks follow one another in it; an INDEX 01 marks where a track starts
   * (INDEX 00 pregaps are part of the track before).
   */
  static fromCue(sheet: string, files: Map<string, Uint8Array>): CdImage {
    const byName = new Map([...files].map(([name, data]) => [baseName(name).toLowerCase(), data]));
    const tracks: Track[] = [];
    let file: Uint8Array | null = null;
    let fileStart = 0;
    let pending: { number: number; audio: boolean; sectorBytes: number } | null = null;
    /** The disc position where the current file's sectors begin. */
    const startOfFiles: { file: Uint8Array; discStart: number; tracks: Track[] }[] = [];
    for (const raw of sheet.split(/\r?\n/)) {
      const line = raw.trim();
      const fileMatch = /^FILE\s+"?(.+?)"?\s+\w+$/i.exec(line);
      if (fileMatch) {
        const data = byName.get(baseName(fileMatch[1]).toLowerCase());
        if (!data) throw new Error(`The CUE sheet needs ${fileMatch[1]}; add it along with the .cue file.`);
        file = data;
        fileStart = startOfFiles.length ? startOfFiles[startOfFiles.length - 1].discStart + fileSectors(startOfFiles[startOfFiles.length - 1]) : 0;
        startOfFiles.push({ file, discStart: fileStart, tracks: [] });
        continue;
      }
      const trackMatch = /^TRACK\s+(\d+)\s+(\S+)$/i.exec(line);
      if (trackMatch) {
        const mode = trackMatch[2].toUpperCase();
        pending = { number: Number(trackMatch[1]), audio: mode === 'AUDIO', sectorBytes: mode.endsWith('/2048') ? DATA_SECTOR : RAW_SECTOR };
        continue;
      }
      const indexMatch = /^INDEX\s+01\s+(\d+):(\d+):(\d+)$/i.exec(line);
      if (indexMatch && pending && file) {
        const sectorInFile = (Number(indexMatch[1]) * 60 + Number(indexMatch[2])) * 75 + Number(indexMatch[3]);
        const group = startOfFiles[startOfFiles.length - 1];
        const offset = byteOffset(group.tracks, sectorInFile, pending.sectorBytes);
        const track: Track = { ...pending, start: group.discStart + sectorInFile, length: 0, file, offset };
        group.tracks.push(track);
        tracks.push(track);
        pending = null;
      }
    }
    if (!tracks.length) throw new Error('The CUE sheet has no tracks in it.');
    // A track runs to the next one in its file, or to the file's end.
    for (const group of startOfFiles) {
      group.tracks.forEach((track, i) => {
        const next = group.tracks[i + 1];
        track.length = next ? next.start - track.start : Math.floor((group.file.length - track.offset) / track.sectorBytes);
      });
    }
    return new CdImage(tracks);
  }

  readSector(lsn: number, into: Uint8Array): boolean {
    const track = this.tracks.find((candidate) => lsn >= candidate.start && lsn < candidate.start + candidate.length);
    if (!track) return false;
    const at = track.offset + (lsn - track.start) * track.sectorBytes;
    if (track.sectorBytes === RAW_SECTOR) {
      into.set(track.file.subarray(at, at + RAW_SECTOR));
      return true;
    }
    into.fill(0);
    into.fill(0xff, 1, 11);
    const [minutes, seconds, frames] = msf(lsn);
    into[12] = bcd(minutes);
    into[13] = bcd(seconds);
    into[14] = bcd(frames);
    into[15] = 1;
    into.set(track.file.subarray(at, at + DATA_SECTOR), 16);
    return true;
  }

  /** The TOC as the drive sends it: the first and last track, the lead-out, then each track. */
  private buildToc(): Uint8Array[] {
    const first = this.tracks[0];
    const last = this.tracks[this.tracks.length - 1];
    const entry = (control: number, point: number, minutes: number, seconds: number, frames: number) => {
      const data = new Uint8Array(13);
      data[1] = ADR_POSITION | (control << 4);
      data[3] = point;
      data[8] = bcd(minutes);
      data[9] = bcd(seconds);
      data[10] = bcd(frames);
      return data;
    };
    const control = (track: Track) => (track.audio ? 0 : CONTROL_DATA);
    return [
      entry(control(first), POINT_FIRST_TRACK, first.number, 0, 0),
      entry(control(last), POINT_LAST_TRACK, last.number, 0, 0),
      entry(control(last), POINT_LEAD_OUT, ...msf(this.sectorCount)),
      ...this.tracks.map((track) => entry(control(track), bcd(track.number), ...msf(track.start))),
    ];
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop()!;
}

/** Sectors a file holds, by its tracks' sector size (the first track's, for a file with none yet). */
function fileSectors(group: { file: Uint8Array; tracks: Track[] }): number {
  const size = group.tracks[0]?.sectorBytes ?? RAW_SECTOR;
  return Math.floor(group.file.length / size);
}

/** Where a track's sector falls in its file, after the file's earlier tracks (which may have another sector size). */
function byteOffset(earlier: Track[], sectorInFile: number, sectorBytes: number): number {
  if (!earlier.length) return sectorInFile * sectorBytes;
  const previous = earlier[earlier.length - 1];
  const previousStartInFile = previous.offset / previous.sectorBytes;
  return previous.offset + (sectorInFile - previousStartInFile) * previous.sectorBytes;
}
