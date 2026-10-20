import type { MemoryConfig, VideoStandard } from '../amiga';
import type { SaveStateInfo } from '../storage/save-states';

/** The machine setup the toolbar offers; a change means switching off and on. */
export interface MachineChoices {
  standard: VideoStandard;
  memory: MemoryConfig;
  externalDrive: boolean;
}

export interface ToolbarCallbacks {
  onPause(paused: boolean): void;
  /** Ctrl-Amiga-Amiga. */
  onReset(): void;
  /** Switches the Amiga off and on, keeping the disks in. */
  onPowerCycle(): void;
  onFullscreen(): void;
  onMachine(choices: MachineChoices): void;
  onSaveState(): Promise<void>;
  onLoadState(id: string): Promise<void>;
  onDeleteState(id: string): Promise<void>;
  onExportState(): Promise<void>;
  onImportState(file: File): Promise<void>;
  /** Gives keyboard focus back to the emulator screen. */
  focusScreen(): void;
}

export interface Toolbar {
  readonly paused: boolean;
  readonly choices: MachineChoices;
  setPaused(paused: boolean): void;
  showChoices(choices: MachineChoices): void;
  setStates(states: SaveStateInfo[]): void;
  showMessage(text: string, isError?: boolean): void;
}

function requireChild<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Toolbar is missing ${selector}`);
  return element;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });

const MEMORY_CHOICES: Record<string, MemoryConfig> = {
  '512+512': { chipKb: 512, slowKb: 512 },
  '512': { chipKb: 512, slowKb: 0 },
  '1024': { chipKb: 1024, slowKb: 0 },
};

const memoryValue = (memory: MemoryConfig) =>
  Object.entries(MEMORY_CHOICES).find(([, config]) => config.chipKb === memory.chipKb && config.slowKb === memory.slowKb)?.[0] ?? '512+512';

/** The row of machine controls under the screen. */
export function attachToolbar(root: HTMLElement, callbacks: ToolbarCallbacks): Toolbar {
  const slots = requireChild<HTMLSelectElement>(root, 'select[name="state-slot"]');
  const fileInput = requireChild<HTMLInputElement>(root, 'input[name="state-file"]');
  const message = requireChild<HTMLElement>(root, '.toolbar-message');
  const standard = requireChild<HTMLSelectElement>(root, 'select[name="tv"]');
  const memory = requireChild<HTMLSelectElement>(root, 'select[name="memory"]');
  const externalDrive = requireChild<HTMLInputElement>(root, 'input[name="external-drive"]');
  const pauseButton = requireChild<HTMLButtonElement>(root, '[data-action="pause"]');
  const stateButtons = ['load-state', 'delete-state'].map((action) => requireChild<HTMLButtonElement>(root, `[data-action="${action}"]`));
  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  let paused = false;

  const showMessage = (text: string, isError = false) => {
    clearTimeout(messageTimer);
    message.textContent = text;
    message.classList.toggle('error', isError);
    if (!isError) messageTimer = setTimeout(() => (message.textContent = ''), 4000);
  };

  const run = (action: () => Promise<void>) => {
    action()
      .catch((error: unknown) => showMessage(error instanceof Error ? error.message : String(error), true))
      .finally(() => callbacks.focusScreen());
  };
  const onClick = (action: string, handler: () => Promise<void>) =>
    requireChild<HTMLButtonElement>(root, `[data-action="${action}"]`).addEventListener('click', () => run(handler));

  const setPaused = (value: boolean) => {
    paused = value;
    pauseButton.textContent = paused ? 'Resume' : 'Pause';
    callbacks.onPause(paused);
  };
  onClick('pause', async () => setPaused(!paused));
  onClick('reset', async () => callbacks.onReset());
  onClick('power', async () => callbacks.onPowerCycle());
  onClick('fullscreen', async () => callbacks.onFullscreen());

  const readChoices = (): MachineChoices => ({
    standard: standard.value === 'ntsc' ? 'ntsc' : 'pal',
    memory: MEMORY_CHOICES[memory.value] ?? MEMORY_CHOICES['512+512'],
    externalDrive: externalDrive.checked,
  });
  for (const field of [standard, memory, externalDrive]) {
    field.addEventListener('change', () => {
      callbacks.onMachine(readChoices());
      callbacks.focusScreen();
    });
  }

  onClick('save-state', () => callbacks.onSaveState());
  onClick('load-state', async () => {
    if (slots.value) await callbacks.onLoadState(slots.value);
  });
  onClick('delete-state', async () => {
    const option = slots.selectedOptions[0];
    if (option && confirm(`Delete the save state "${option.textContent}"?`)) await callbacks.onDeleteState(option.value);
  });
  onClick('export-state', () => callbacks.onExportState());
  onClick('import-state', async () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) run(() => callbacks.onImportState(file));
  });

  return {
    get paused() {
      return paused;
    },
    get choices() {
      return readChoices();
    },
    setPaused,
    showChoices: (choices) => {
      standard.value = choices.standard;
      memory.value = memoryValue(choices.memory);
      externalDrive.checked = choices.externalDrive;
    },
    setStates: (states) => {
      slots.replaceChildren(
        ...states.map((state) => {
          const option = document.createElement('option');
          option.value = state.id;
          option.textContent = `${state.name}, ${timeFormat.format(state.created)}`;
          return option;
        }),
      );
      const empty = states.length === 0;
      slots.disabled = empty;
      stateButtons.forEach((button) => (button.disabled = empty));
      if (empty) {
        const option = document.createElement('option');
        option.textContent = 'No save states yet';
        slots.append(option);
      }
    },
    showMessage,
  };
}
