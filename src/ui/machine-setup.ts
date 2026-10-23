import type { VideoStandard } from '../amiga';
import { MODELS, memoryByKey, memoryOption, modelById, type ModelId, type ModelSpec } from '../models';
import type { MemoryConfig } from '../amiga';
import { isZip, readZip } from '../drive/zip';
import { HardDiskImage, isPartitionOnly } from '../ide/image';
import type { HardDiskInfo } from '../storage/hard-disks';
import {
  KICKSTART_1M,
  KICKSTART_256K,
  KICKSTART_512K,
  isCd32ExtendedRom,
  NeedsRomKey,
  identifyKickstart,
  hasIdeDriver,
  joinSplitKickstart,
  looksLikeKickstart,
  preferredKickstart,
  rankKickstarts,
  suitsModel,
  type Kickstart,
  type SystemRomStore,
} from '../roms/system-roms';

/** Files worth looking at in a zip: Kickstart-sized (whole, encrypted or half), a rom.key, or another zip. */
function interesting(name: string, size: number): boolean {
  const base = name.split('/').pop()!;
  if (base.startsWith('.') || name.startsWith('__MACOSX/')) return false;
  if (base.toLowerCase() === 'rom.key' || base.toLowerCase().endsWith('.zip')) return true;
  return [KICKSTART_256K, KICKSTART_512K, KICKSTART_1M, KICKSTART_256K / 2].includes(size) || size === KICKSTART_256K + 11 || size === KICKSTART_512K + 11;
}

/** ROM collections often hold a zip per ROM, so zips are opened this many levels down. */
const MAX_ZIP_DEPTH = 2;

async function expand(file: File, depth = 0): Promise<File[]> {
  const data = new Uint8Array(await file.arrayBuffer());
  if (!isZip(data)) return [file];
  if (depth >= MAX_ZIP_DEPTH) return [];
  const entries = readZip(data).filter((entry) => interesting(entry.name, entry.size));
  const files: File[] = [];
  for (const entry of entries) {
    files.push(...(await expand(new File([new Uint8Array(await entry.read())], entry.name.split('/').pop()!), depth + 1)));
  }
  if (depth === 0 && files.length === 0) throw new Error(`${file.name} has no Kickstart ROM in it.`);
  return files;
}

/** The first few problems, so a whole collection of unsuitable ROMs doesn't fill the panel. */
function summarise(errors: string[]): string {
  const shown = errors.slice(0, 3).join(' ');
  return errors.length > 3 ? `${shown} (and ${errors.length - 3} more files that aren't usable)` : shown;
}

/** How the machine is built; changing any of it means switching off and on. */
export interface MachineChoices {
  model: ModelId;
  standard: VideoStandard;
  memory: MemoryConfig;
  externalDrive: boolean;
  hardDrive: boolean;
}

export const DEFAULT_CHOICES: MachineChoices = {
  model: 'a500',
  standard: 'pal',
  memory: { chipKb: 512, slowKb: 512, fastKb: 0 },
  externalDrive: false,
  hardDrive: false,
};

/** What to do with the stored hard disk when the Amiga restarts. */
export type HardDiskChange = { kind: 'keep' } | { kind: 'new'; image: HardDiskImage; name: string } | { kind: 'delete' };

export interface MachineSetupOptions {
  /** Opened from a running Amiga: offers Back (resolves null) and restarts rather than starts. */
  whileRunning?: boolean;
  choices: MachineChoices;
  /** The hard disk kept in the browser, if there is one. */
  hardDisk: HardDiskInfo | null;
  /** Downloads the hard disk as it is now. */
  exportHardDisk(): Promise<void>;
}

export interface MachineSetup {
  kickstart: Kickstart;
  choices: MachineChoices;
  hardDisk: HardDiskChange;
}

/** How a memory setup reads in the menu, e.g. "512K chip + 512K slow". */
export function memoryLabel(memory: MemoryConfig): string {
  const size = (kb: number) => (kb >= 1024 ? `${kb / 1024}MB` : `${kb}K`);
  const parts = [`${size(memory.chipKb)} chip`];
  if (memory.slowKb) parts.push(`${size(memory.slowKb)} slow`);
  if (memory.fastKb) parts.push(`${size(memory.fastKb)} fast`);
  return parts.join(' + ');
}

/** A choice of memory for the model (its default if the choice isn't one of its setups). */
export function modelMemory(model: ModelSpec, memory: MemoryConfig): MemoryConfig {
  return memoryOption(model, memory).config;
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * Shows the Machine setup panel in place of the screen: the Kickstart (asked
 * for on the first visit), the TV standard, memory and external drive, and
 * the hard drive with its disk. Resolves when the user starts or restarts the
 * Amiga, or with null if they went back to the running Amiga instead (which
 * changes nothing but the Kickstart kept in the browser).
 */
export function askForMachine(root: HTMLElement, store: SystemRomStore, initial: Kickstart | null, options: MachineSetupOptions): Promise<MachineSetup | null> {
  const query = <T extends HTMLElement>(selector: string) => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`ROM setup is missing ${selector}`);
    return element;
  };
  const fileInput = query<HTMLInputElement>('input[name="rom-files"]');
  const modelSelect = query<HTMLSelectElement>('select[name="model"]');
  const romHint = query<HTMLElement>('.model-rom-hint');
  const standardSelect = query<HTMLSelectElement>('select[name="tv"]');
  const memorySelect = query<HTMLSelectElement>('select[name="memory"]');
  const externalDrive = query<HTMLInputElement>('input[name="external-drive"]');
  const hardDrive = query<HTMLInputElement>('input[name="hard-drive"]');
  const hdStatus = query<HTMLElement>('.hd-status');
  const hdNote = query<HTMLElement>('.hd-note');
  const hdSize = query<HTMLSelectElement>('select[name="hd-size"]');
  const hdFile = query<HTMLInputElement>('input[name="hdf-file"]');
  const exportButton = query<HTMLButtonElement>('[data-action="export-hard-disk"]');
  const deleteButton = query<HTMLButtonElement>('[data-action="delete-hard-disk"]');
  const startButton = query<HTMLButtonElement>('[data-action="start"]');
  const backButton = query<HTMLButtonElement>('[data-action="back"]');
  const forgetButton = query<HTMLButtonElement>('[data-action="forget-roms"]');
  const message = query<HTMLElement>('.rom-message');
  const heading = query<HTMLElement>('h1');
  const row = query<HTMLElement>('[data-rom="kickstart"]');
  const status = row.querySelector<HTMLElement>('.rom-status')!;
  const keyRow = query<HTMLElement>('[data-rom="key"]');
  const choiceRow = query<HTMLElement>('.rom-choice');
  const choiceSelect = query<HTMLSelectElement>('select[name="kickstart-choice"]');
  heading.textContent = options.whileRunning ? 'Machine setup' : 'First, load a Kickstart ROM';
  startButton.textContent = options.whileRunning ? 'Restart the Amiga with these settings' : 'Start the Amiga';
  modelSelect.replaceChildren(
    ...MODELS.map((model) => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.unavailable ? `${model.name} (coming: ${model.unavailable})` : `${model.name} (${model.year})`;
      option.disabled = !!model.unavailable;
      return option;
    }),
  );
  modelSelect.value = modelById(options.choices.model).id;
  /** The memory menu offers the model's setups, keeping the choice where the model has it. */
  const renderModel = (memory: MemoryConfig) => {
    const model = modelById(modelSelect.value);
    romHint.textContent = model.romHint;
    memorySelect.replaceChildren(
      ...model.memory.map(({ key, config }) => {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = memoryLabel(config);
        return option;
      }),
    );
    memorySelect.value = memoryOption(model, memory).key;
  };
  renderModel(options.choices.memory);
  standardSelect.value = options.choices.standard;
  externalDrive.checked = options.choices.externalDrive;
  hardDrive.checked = options.choices.hardDrive;
  let hardDiskChange: HardDiskChange = { kind: 'keep' };
  let hdWarning = '';
  backButton.hidden = !options.whileRunning;
  message.textContent = '';
  let kickstart = initial;
  let key: Uint8Array | null = null;
  /** An encrypted ROM waiting for its rom.key. */
  let encrypted: File | null = null;
  /** One half of a ROM dumped from its two chips, waiting for the other. */
  let half: File | null = null;
  /** The Kickstarts to switch between, when several came together (newest first). */
  let choices: Kickstart[] = [];
  const listeners = new AbortController();

  const render = () => {
    const model = modelById(modelSelect.value);
    const fits = !kickstart || suitsModel(kickstart, model);
    const required = kickstart?.requires ? modelById(kickstart.requires).name : '';
    const missingExtended = !!kickstart && fits && !!model.cd32 && !kickstart.extended;
    const note =
      kickstart?.warning ??
      (!fits
        ? `made for the ${required}; choose it as the model to start this Kickstart`
        : missingExtended
          ? 'the CD32 also needs its extended ROM (40.60); add it with the Kickstart, or a 1 MB file of both'
          : null);
    row.dataset.state = kickstart ? (note ? 'warning' : 'loaded') : 'missing';
    status.textContent = kickstart ? `Loaded: ${kickstart.title}, from ${kickstart.name}${note ? ` (${note})` : ''}` : 'Not loaded yet';
    keyRow.hidden = !encrypted;
    startButton.disabled = !kickstart || !fits || missingExtended;
    forgetButton.hidden = !kickstart;
    choiceRow.hidden = choices.length < 2;
    renderHardDisk();
    choiceSelect.replaceChildren(
      ...choices.map((choice, i) => {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = choice.title;
        option.selected = !!kickstart && choice.data.length === kickstart.data.length && choice.title === kickstart.title;
        return option;
      }),
    );
  };

  const whenStarted = options.whileRunning ? 'when the Amiga restarts' : 'when the Amiga starts';
  const renderHardDisk = () => {
    const stored = options.hardDisk;
    const disk =
      hardDiskChange.kind === 'new'
        ? `${hardDiskChange.name}, ${megabytes(hardDiskChange.image.bytes.length)} (made ${whenStarted})`
        : hardDiskChange.kind === 'delete' || !stored
          ? null
          : `${stored.name}, ${megabytes(stored.bytes)}`;
    hdStatus.textContent = disk ?? (hardDiskChange.kind === 'delete' ? `Deleted ${whenStarted}` : 'No hard disk yet');
    exportButton.disabled = hardDiskChange.kind !== 'keep' || !stored;
    deleteButton.disabled = !disk;
    const notes = [hdWarning];
    if (hardDrive.checked && !disk) notes.push('Make a new hard disk or import one, or the drive stays empty.');
    if (hardDrive.checked && kickstart && !hasIdeDriver(kickstart.data)) {
      notes.push(`${kickstart.title} has no driver for this drive; it needs Kickstart 3.1 or the A600's 2.05.`);
    }
    hdNote.textContent = notes.filter(Boolean).join(' ');
  };

  const useHardDisk = (image: HardDiskImage, name: string) => {
    if (options.hardDisk && hardDiskChange.kind === 'keep' && !confirm('Replace the hard disk kept in this browser? What is on it will be lost.')) return;
    hardDiskChange = { kind: 'new', image, name };
    hardDrive.checked = true;
    render();
  };

  const importHardDisk = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = HardDiskImage.fromHdf(bytes);
    hdWarning = isPartitionOnly(bytes)
      ? `${file.name} holds only a partition (no Rigid Disk Block), which Kickstart won't mount; use an image partitioned with HDToolBox.`
      : '';
    useHardDisk(image, file.name.replace(/\.hdf$/i, ''));
  };

  /** Uses a Kickstart, switching to the model it needs if it needs one (the A1200's ROMs). */
  const use = async (rom: Kickstart) => {
    kickstart = rom;
    encrypted = null;
    if (rom.requires && !suitsModel(rom, modelById(modelSelect.value))) {
      modelSelect.value = rom.requires;
      renderModel(memoryByKey(modelById(rom.requires), memorySelect.value));
    }
    await store.save(rom);
  };

  const addFiles = async (all: File[]) => {
    const errors: string[] = [];
    const files: File[] = [];
    // A hard disk image dropped on the panel goes to the hard drive.
    const hardDiskFile = all.find((file) => /\.hdf$/i.test(file.name));
    if (hardDiskFile) await importHardDisk(hardDiskFile).catch((error: unknown) => errors.push(error instanceof Error ? error.message : String(error)));
    const chosen = all.filter((file) => file !== hardDiskFile);
    for (const file of chosen) {
      try {
        files.push(...(await expand(file)));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    // The key first, so an encrypted ROM in the same batch can use it.
    for (const file of files.filter((entry) => entry.name.toLowerCase().endsWith('.key'))) key = new Uint8Array(await file.arrayBuffer());
    /** Every usable Kickstart in the batch; the best goes in. */
    const found: Kickstart[] = [];
    /** The CD32's extended ROM, which goes with its Kickstart. */
    let extended: Uint8Array | null = null;
    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.key')) continue;
      const data = new Uint8Array(await file.arrayBuffer());
      if (isCd32ExtendedRom(data)) {
        extended = data;
        continue;
      }
      try {
        // Half of a 512K ROM is the size of a whole 256K one, so only a file that isn't a Kickstart is taken as a half.
        if (data.length === KICKSTART_256K / 2 || (data.length === KICKSTART_512K / 2 && !looksLikeKickstart(data))) {
          if (!half) {
            half = file;
            errors.push(`${file.name} looks like half of a ROM dumped from its two chips; add the other half too.`);
            continue;
          }
          const joined = joinSplitKickstart(new Uint8Array(await half.arrayBuffer()), data);
          if (!joined) throw new Error(`${half.name} and ${file.name} don't make a Kickstart together.`);
          found.push(identifyKickstart(`${half.name} + ${file.name}`, joined));
          half = null;
          continue;
        }
        found.push(identifyKickstart(file.name, data, key ?? undefined));
      } catch (error) {
        if (error instanceof NeedsRomKey) encrypted ??= file;
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (encrypted && key) {
      try {
        found.push(identifyKickstart(encrypted.name, new Uint8Array(await encrypted.arrayBuffer()), key));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (extended) {
      const cd32 = found.filter((rom) => rom.requires === 'cd32');
      if (cd32.length) cd32.forEach((rom) => (rom.extended = extended!));
      else if (kickstart?.requires === 'cd32') await use({ ...kickstart, extended });
      else errors.push('That is the CD32 extended ROM; add it together with the CD32 Kickstart (40.60).');
    }
    if (found.length > 0) {
      // The other files of a batch (a collection's ROMs for other Amigas) don't matter once one fits.
      const model = modelById(modelSelect.value);
      choices = rankKickstarts(found, model);
      await store.saveChoices(choices.length > 1 ? choices : []);
      await use(preferredKickstart(found, model));
      half = null;
      errors.length = 0;
    }
    message.textContent = summarise(errors);
    render();
  };

  choiceSelect.addEventListener(
    'change',
    () => {
      const choice = choices[Number(choiceSelect.value)];
      if (choice) void use(choice).then(render);
    },
    { signal: listeners.signal },
  );
  void store.loadChoices().then((stored) => {
    choices = stored;
    render();
  });

  hardDrive.addEventListener('change', render, { signal: listeners.signal });
  modelSelect.addEventListener(
    'change',
    () => {
      const model = modelById(modelSelect.value);
      renderModel(memoryByKey(model, memorySelect.value));
      // Among the Kickstarts that came together, the model's own goes in (the A1200's for an A1200).
      const best = choices.length ? preferredKickstart(choices, model) : null;
      const better = best && suitsModel(best, model) && (!kickstart || !suitsModel(kickstart, model) || (best.requires === model.id && kickstart.requires !== model.id));
      if (better && best.title !== kickstart?.title) void use(best).then(render);
      else render();
    },
    { signal: listeners.signal },
  );
  query<HTMLButtonElement>('[data-action="new-hard-disk"]').addEventListener(
    'click',
    () => {
      hdWarning = '';
      useHardDisk(HardDiskImage.blank(Number(hdSize.value)), `Hard disk`);
    },
    { signal: listeners.signal },
  );
  query<HTMLButtonElement>('[data-action="import-hard-disk"]').addEventListener('click', () => hdFile.click(), { signal: listeners.signal });
  hdFile.addEventListener(
    'change',
    () => {
      const file = hdFile.files?.[0];
      hdFile.value = '';
      if (file) {
        void importHardDisk(file).catch((error: unknown) => {
          message.textContent = error instanceof Error ? error.message : String(error);
        });
      }
    },
    { signal: listeners.signal },
  );
  exportButton.addEventListener('click', () => void options.exportHardDisk(), { signal: listeners.signal });
  deleteButton.addEventListener(
    'click',
    () => {
      if (hardDiskChange.kind === 'new') hardDiskChange = { kind: 'keep' };
      else if (confirm('Delete the hard disk kept in this browser? What is on it will be lost.')) hardDiskChange = { kind: 'delete' };
      hdWarning = '';
      render();
    },
    { signal: listeners.signal },
  );

  root.querySelectorAll<HTMLButtonElement>('[data-action="choose-roms"]').forEach((button) =>
    button.addEventListener('click', () => fileInput.click(), { signal: listeners.signal }),
  );
  fileInput.addEventListener(
    'change',
    () => {
      const files = [...(fileInput.files ?? [])];
      fileInput.value = '';
      void addFiles(files);
    },
    { signal: listeners.signal },
  );
  forgetButton.addEventListener(
    'click',
    () => {
      kickstart = null;
      encrypted = half = null;
      choices = [];
      message.textContent = '';
      void store.forget().then(render);
    },
    { signal: listeners.signal },
  );

  // Captured and stopped so the disk panel's page-wide drop handling doesn't also see ROM files.
  const dragOptions = { signal: listeners.signal, capture: true };
  const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
  let dragDepth = 0;
  window.addEventListener(
    'dragenter',
    (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dragDepth++;
      root.classList.add('drag-over');
    },
    dragOptions,
  );
  window.addEventListener(
    'dragover',
    (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    },
    dragOptions,
  );
  window.addEventListener(
    'dragleave',
    (event) => {
      if (!hasFiles(event)) return;
      event.stopImmediatePropagation();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) root.classList.remove('drag-over');
    },
    dragOptions,
  );
  window.addEventListener(
    'drop',
    (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dragDepth = 0;
      root.classList.remove('drag-over');
      void addFiles([...(event.dataTransfer?.files ?? [])]);
    },
    dragOptions,
  );

  document.body.classList.add('needs-roms');
  root.hidden = false;
  render();
  root.scrollIntoView({ block: 'start' });

  return new Promise((resolve) => {
    const close = (result: MachineSetup | null) => {
      listeners.abort();
      root.hidden = true;
      document.body.classList.remove('needs-roms');
      resolve(result);
    };
    const choices = (): MachineChoices => {
      const model = modelById(modelSelect.value);
      return {
        model: model.id,
        standard: standardSelect.value === 'ntsc' ? 'ntsc' : 'pal',
        memory: memoryByKey(model, memorySelect.value),
        externalDrive: externalDrive.checked,
        hardDrive: hardDrive.checked,
      };
    };
    startButton.addEventListener(
      'click',
      () => {
        if (kickstart) close({ kickstart, choices: choices(), hardDisk: hardDiskChange });
      },
      { signal: listeners.signal },
    );
    backButton.addEventListener('click', () => close(null), { signal: listeners.signal });
  });
}
