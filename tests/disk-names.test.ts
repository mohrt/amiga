import { describe, expect, it } from 'vitest';
import { firstDisk } from '../src/drive/load';
import { shortLabels } from '../src/ui/disk-panel';

const workbench31 = [1, 2, 3, 4, 5, 6].map(
  (n) =>
    `Workbench v3.1 rev 40.42 (1996)(ESCOM)(M10)(Disk ${n} of 6)(${['Install', 'Workbench', 'Extras', 'Storage', 'Locale', 'Fonts'][n - 1]}).adf`,
);

describe('disks given together', () => {
  it('labels each disk by what sets it apart from the others', () => {
    expect(shortLabels(workbench31)).toEqual([
      'Disk 1 of 6 (Install)',
      'Disk 2 of 6 (Workbench)',
      'Disk 3 of 6 (Extras)',
      'Disk 4 of 6 (Storage)',
      'Disk 5 of 6 (Locale)',
      'Disk 6 of 6 (Fonts)',
    ]);
    expect(shortLabels(['Lemmings (Disk 1 of 2).adf', 'Lemmings (Disk 2 of 2).adf'])).toEqual(['Disk 1 of 2', 'Disk 2 of 2']);
    expect(shortLabels(['AWESOME1.ADF', 'AWESOME2.ADF'])).toEqual(['AWESOME1', 'AWESOME2']);
    expect(shortLabels(['game.adf'])).toEqual(['game']);
  });

  it('puts the Workbench disk of a Workbench set in first, otherwise the first one', () => {
    const files = workbench31.map((name) => new File([], name));
    expect(firstDisk(files).name).toContain('(Disk 2 of 6)(Workbench)');
    const game = ['Game (Disk 1 of 2).adf', 'Game (Disk 2 of 2).adf'].map((name) => new File([], name));
    expect(firstDisk(game).name).toBe('Game (Disk 1 of 2).adf');
  });
});
