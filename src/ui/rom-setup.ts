import { isZip, readZip } from '../drive/zip';
import {
  KICKSTART_256K,
  KICKSTART_512K,
  NeedsRomKey,
  identifyKickstart,
  joinSplitKickstart,
  looksLikeKickstart,
  type Kickstart,
  type SystemRomStore,
} from '../roms/system-roms';

/** Files worth looking at in a zip: Kickstart-sized (whole, encrypted or half) or a rom.key. */
function interesting(name: string, size: number): boolean {
  const base = name.split('/').pop()!;
  if (base.startsWith('.') || name.startsWith('__MACOSX/')) return false;
  if (base.toLowerCase() === 'rom.key') return true;
  return [KICKSTART_256K, KICKSTART_512K, KICKSTART_256K / 2].includes(size) || size === KICKSTART_256K + 11 || size === KICKSTART_512K + 11;
}

async function expand(file: File): Promise<File[]> {
  const data = new Uint8Array(await file.arrayBuffer());
  if (!isZip(data)) return [file];
  const entries = readZip(data).filter((entry) => interesting(entry.name, entry.size));
  if (entries.length === 0) throw new Error(`${file.name} has no Kickstart ROM in it.`);
  return Promise.all(entries.map(async (entry) => new File([new Uint8Array(await entry.read())], entry.name.split('/').pop()!)));
}

export interface RomSetupOptions {
  /** Opened from a running Amiga: offers Back (resolves null) and restarts rather than starts. */
  whileRunning?: boolean;
}

/**
 * Shows the ROM setup panel in place of the screen until a Kickstart is
 * loaded and the user presses Start. Resolves with the Kickstart to use, or
 * null if the user went back to the running Amiga instead.
 */
export function askForKickstart(
  root: HTMLElement,
  store: SystemRomStore,
  initial: Kickstart | null,
  options: RomSetupOptions = {},
): Promise<Kickstart | null> {
  const query = <T extends HTMLElement>(selector: string) => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`ROM setup is missing ${selector}`);
    return element;
  };
  const fileInput = query<HTMLInputElement>('input[type="file"]');
  const startButton = query<HTMLButtonElement>('[data-action="start"]');
  const backButton = query<HTMLButtonElement>('[data-action="back"]');
  const forgetButton = query<HTMLButtonElement>('[data-action="forget-roms"]');
  const message = query<HTMLElement>('.rom-message');
  const heading = query<HTMLElement>('h1');
  const row = query<HTMLElement>('[data-rom="kickstart"]');
  const status = row.querySelector<HTMLElement>('.rom-status')!;
  const keyRow = query<HTMLElement>('[data-rom="key"]');
  heading.textContent = options.whileRunning ? 'Change the Kickstart ROM' : 'First, load a Kickstart ROM';
  startButton.textContent = options.whileRunning ? 'Restart the Amiga with this ROM' : 'Start the Amiga';
  backButton.hidden = !options.whileRunning;
  message.textContent = '';
  let kickstart = initial;
  let key: Uint8Array | null = null;
  /** An encrypted ROM waiting for its rom.key. */
  let encrypted: File | null = null;
  /** One half of a ROM dumped from its two chips, waiting for the other. */
  let half: File | null = null;
  const listeners = new AbortController();

  const render = () => {
    row.dataset.state = kickstart ? (kickstart.warning ? 'warning' : 'loaded') : 'missing';
    status.textContent = kickstart
      ? `Loaded: ${kickstart.title}, from ${kickstart.name}${kickstart.warning ? ` (${kickstart.warning})` : ''}`
      : 'Not loaded yet';
    keyRow.hidden = !encrypted;
    startButton.disabled = !kickstart;
    forgetButton.hidden = !kickstart;
  };

  const use = async (rom: Kickstart) => {
    kickstart = rom;
    encrypted = null;
    await store.save(rom);
  };

  const addFiles = async (chosen: File[]) => {
    const errors: string[] = [];
    const files: File[] = [];
    for (const file of chosen) {
      try {
        files.push(...(await expand(file)));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    // The key first, so an encrypted ROM in the same batch can use it.
    for (const file of files.filter((entry) => entry.name.toLowerCase().endsWith('.key'))) key = new Uint8Array(await file.arrayBuffer());
    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.key')) continue;
      const data = new Uint8Array(await file.arrayBuffer());
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
          await use(identifyKickstart(`${half.name} + ${file.name}`, joined));
          half = null;
          continue;
        }
        await use(identifyKickstart(file.name, data, key ?? undefined));
      } catch (error) {
        if (error instanceof NeedsRomKey) encrypted = file;
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (encrypted && key) {
      try {
        await use(identifyKickstart(encrypted.name, new Uint8Array(await encrypted.arrayBuffer()), key));
        errors.length = 0;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    message.textContent = errors.join(' ');
    render();
  };

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
    const close = (result: Kickstart | null) => {
      listeners.abort();
      root.hidden = true;
      document.body.classList.remove('needs-roms');
      resolve(result);
    };
    startButton.addEventListener('click', () => close(kickstart), { signal: listeners.signal });
    backButton.addEventListener('click', () => close(null), { signal: listeners.signal });
  });
}
