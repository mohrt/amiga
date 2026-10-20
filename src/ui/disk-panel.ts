export interface GameListing {
  title: string;
  credit?: string;
  license?: string;
  licenseHref?: string;
  sourceHref?: string;
  hint?: string;
}

export interface SaveDiskOption {
  id: string;
  name: string;
}

export interface DiskPanelCallbacks {
  /** A file was dropped or chosen for a drive (a disk image, a zip, or a save state). */
  onFile(file: File, drive: number): Promise<void>;
  onEject(drive: number): void;
  /** Forgets what games saved to the disk in the drive. */
  onRevert(drive: number): Promise<void>;
  /** Downloads the disk in the drive as it is now. */
  onDownload(drive: number): Promise<void>;
  /** Downloads one of the free games. */
  onGame(index: number): Promise<File>;
  /** Plays a free game: it goes into DF0 and the Amiga restarts. */
  onPlayGame(file: File): Promise<void>;
  onNewSaveDisk(drive: number): Promise<void>;
  onInsertSaveDisk(id: string, drive: number): Promise<void>;
  onExportSaveDisk(id: string): Promise<void>;
  onDeleteSaveDisk(id: string): Promise<void>;
  onWarp(enabled: boolean): void;
  focusScreen(): void;
}

function requireChild<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Disk panel is missing ${selector}`);
  return element;
}

/**
 * The floppy drives under the screen: what is in DF0 (and DF1), buttons to
 * insert, eject, revert and download disks, the other disks of a zip, the
 * free games and blank save disks. Files can be dropped anywhere on the page
 * (onto DF1's row to go in DF1).
 */
export class DiskPanel {
  private readonly fileInput: HTMLInputElement;
  private readonly message: HTMLElement;
  private readonly zipFiles: HTMLElement;
  private readonly zipButtons: HTMLElement;
  private readonly gamePicker: HTMLSelectElement;
  private readonly gameInfo: HTMLElement;
  private readonly saveDiskSelect: HTMLSelectElement;
  private readonly drives: HTMLElement[];
  private games: GameListing[] = [];
  private zipChoices: File[] = [];
  /** The drive the file picker was opened for. */
  private pickingFor = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly callbacks: DiskPanelCallbacks,
  ) {
    this.fileInput = requireChild(root, 'input[name="disk-file"]');
    this.message = requireChild(root, '.disk-message');
    this.zipFiles = requireChild(root, '.zip-files');
    this.zipButtons = requireChild(root, '.zip-buttons');
    this.gamePicker = requireChild(root, 'select[name="bundled-game"]');
    this.gameInfo = requireChild(root, '.game-info');
    this.saveDiskSelect = requireChild(root, 'select[name="save-disk"]');
    this.drives = [requireChild(root, '[data-drive="0"]'), requireChild(root, '[data-drive="1"]')];

    this.drives.forEach((row, drive) => {
      const button = (action: string) => requireChild<HTMLButtonElement>(row, `[data-action="${action}"]`);
      button('choose').addEventListener('click', () => {
        this.pickingFor = drive;
        this.fileInput.click();
      });
      button('eject').addEventListener('click', () => {
        this.callbacks.onEject(drive);
        this.callbacks.focusScreen();
      });
      button('revert').addEventListener('click', () => {
        if (confirm('Forget what games have saved to this disk?')) this.run(() => this.callbacks.onRevert(drive));
      });
      button('download').addEventListener('click', () => this.run(() => this.callbacks.onDownload(drive)));
    });
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (file) this.run(() => this.callbacks.onFile(file, this.pickingFor));
    });

    this.gamePicker.addEventListener('change', () => this.showGameInfo());
    requireChild<HTMLButtonElement>(root, '[data-action="play-game"]').addEventListener('click', () => {
      const index = Number(this.gamePicker.value);
      this.run(async () => this.callbacks.onPlayGame(await this.callbacks.onGame(index)));
    });

    const saveDrive = requireChild<HTMLSelectElement>(root, 'select[name="save-disk-drive"]');
    const driveChoice = () => Number(saveDrive.value) || 0;
    requireChild<HTMLButtonElement>(root, '[data-action="new-save-disk"]').addEventListener('click', () =>
      this.run(() => this.callbacks.onNewSaveDisk(driveChoice())),
    );
    requireChild<HTMLButtonElement>(root, '[data-action="insert-save-disk"]').addEventListener('click', () => {
      if (this.saveDiskSelect.value) this.run(() => this.callbacks.onInsertSaveDisk(this.saveDiskSelect.value, driveChoice()));
    });
    requireChild<HTMLButtonElement>(root, '[data-action="export-save-disk"]').addEventListener('click', () => {
      if (this.saveDiskSelect.value) this.run(() => this.callbacks.onExportSaveDisk(this.saveDiskSelect.value));
    });
    requireChild<HTMLButtonElement>(root, '[data-action="delete-save-disk"]').addEventListener('click', () => {
      const option = this.saveDiskSelect.selectedOptions[0];
      if (option && confirm(`Delete "${option.textContent}" and what is saved on it?`)) this.run(() => this.callbacks.onDeleteSaveDisk(option.value));
    });
    const warp = requireChild<HTMLInputElement>(root, 'input[name="warp"]');
    warp.addEventListener('change', () => {
      this.callbacks.onWarp(warp.checked);
      this.callbacks.focusScreen();
    });
    this.callbacks.onWarp(warp.checked);
    this.attachDragAndDrop();
  }

  /** Files can be dropped anywhere on the page; onto DF1's row they go in DF1. */
  private attachDragAndDrop(): void {
    let depth = 0;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
    document.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      depth++;
      this.root.classList.add('drag-over');
    });
    document.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) this.root.classList.remove('drag-over');
    });
    document.addEventListener('dragover', (event) => {
      if (hasFiles(event)) event.preventDefault();
    });
    document.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      this.root.classList.remove('drag-over');
      const onDf1 = !this.drives[1].hidden && event.target instanceof Node && this.drives[1].contains(event.target);
      const file = event.dataTransfer?.files[0];
      if (file) this.run(() => this.callbacks.onFile(file, onDf1 ? 1 : 0));
    });
  }

  private run(action: () => Promise<void>): void {
    this.showMessage('');
    action()
      .catch((error: unknown) => this.showMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => this.callbacks.focusScreen());
  }

  showMessage(text: string, isWarning = false): void {
    this.message.textContent = text;
    this.message.classList.toggle('warning', isWarning);
  }

  /** Shows the disk in a drive: its name, a line about it, and whether games' saves were put back. */
  showDisk(drive: number, name: string, detail: string, hasSavedChanges: boolean): void {
    const row = this.drives[drive];
    row.dataset.state = 'loaded';
    requireChild(row, '.disk-name').textContent = name;
    requireChild(row, '.disk-detail').textContent = detail;
    this.setSavedChanges(drive, hasSavedChanges);
  }

  showEmpty(drive: number): void {
    const row = this.drives[drive];
    row.dataset.state = 'empty';
    requireChild(row, '.disk-name').textContent = 'No disk';
    requireChild(row, '.disk-detail').textContent = '';
    this.setSavedChanges(drive, false);
  }

  /** The disk has games' saves on it: offer to revert it, and to download it. */
  setSavedChanges(drive: number, saved: boolean): void {
    const row = this.drives[drive];
    requireChild<HTMLElement>(row, '.disk-saved').hidden = !saved;
    requireChild<HTMLButtonElement>(row, '[data-action="revert"]').hidden = !saved;
  }

  setDriveConnected(drive: number, connected: boolean): void {
    this.drives[drive].hidden = !connected;
    requireChild<HTMLSelectElement>(this.root, 'select[name="save-disk-drive"]').hidden = !connected;
  }

  setLed(drive: number, on: boolean): void {
    this.drives[drive].classList.toggle('active', on);
  }

  /** Buttons for the disks of a zip, which go into DF0 (for swapping disks during a game). */
  setZipFiles(files: File[], current: string | null): void {
    this.zipChoices = files;
    this.zipFiles.hidden = files.length < 2;
    this.zipButtons.replaceChildren(
      ...files.map((file) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = file.name;
        button.classList.toggle('current', file.name === current);
        button.addEventListener('click', () => this.run(() => this.callbacks.onFile(file, 0)));
        return button;
      }),
    );
  }

  get zipContents(): File[] {
    return this.zipChoices;
  }

  setSaveDisks(disks: SaveDiskOption[]): void {
    requireChild<HTMLElement>(this.root, '.save-disk-list').hidden = disks.length === 0;
    const selected = this.saveDiskSelect.value;
    this.saveDiskSelect.replaceChildren(
      ...disks.map((disk) => {
        const option = document.createElement('option');
        option.value = disk.id;
        option.textContent = disk.name;
        return option;
      }),
    );
    if (disks.some((disk) => disk.id === selected)) this.saveDiskSelect.value = selected;
  }

  setGames(games: GameListing[]): void {
    this.games = games;
    requireChild<HTMLElement>(this.root, '.bundled-games').hidden = games.length === 0;
    this.gamePicker.replaceChildren(
      ...games.map((game, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = game.title;
        return option;
      }),
    );
    this.showGameInfo();
  }

  /** The chosen game's credit, licence, source and hint, with links. */
  private showGameInfo(): void {
    const game = this.games[Number(this.gamePicker.value)];
    this.gameInfo.replaceChildren();
    if (!game) return;
    const link = (href: string, text: string) => {
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.target = '_blank';
      anchor.rel = 'noopener';
      anchor.textContent = text;
      return anchor;
    };
    const parts: (string | Node)[] = [];
    if (game.credit) parts.push(game.credit);
    if (game.license) parts.push(game.licenseHref ? link(game.licenseHref, game.license) : game.license);
    if (game.sourceHref) parts.push(link(game.sourceHref, 'source'));
    if (game.hint) parts.push(game.hint);
    parts.forEach((part, i) => {
      if (i > 0) this.gameInfo.append(' · ');
      this.gameInfo.append(part);
    });
  }
}
