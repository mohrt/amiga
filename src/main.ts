import type { MemoryConfig } from './amiga';
import { trackGameLoaded } from './analytics';
import { AudioOutput } from './audio/audio-output';
import { FloppyDisk } from './drive/adf';
import { STATE_EXTENSION, filesFrom, firstDisk, readMedia, titleFromFileName } from './drive/load';
import { Emulator } from './emulator';
import type { HardDiskImage } from './ide/image';
import { fetchGame, loadGameManifest, type BundledGame } from './games';
import { BrowserInput, type KeySetName } from './io/browser-input';
import { GamepadManager, padName, readGamepad } from './io/gamepad-input';
import type { Port1Device } from './io/ports';
import { Screen } from './render/screen';
import { SystemRomStore, type Kickstart, type StoredRom } from './roms/system-roms';
import { DiskSaves, type DiskSaveRecord, type SaveDiskRecord } from './storage/disk-saves';
import { HardDisks } from './storage/hard-disks';
import { SaveStates, decodeSession, encodeSession, type SaveStateRecord, type Session } from './storage/save-states';
import { memoryStores, openBrowserStores, type KeyValueStore } from './storage/store';
import { DiskPanel } from './ui/disk-panel';
import { downloadFile } from './ui/download';
import { DEFAULT_CHOICES, askForMachine, memoryLabel, modelMemory, type MachineChoices, type MachineSetup } from './ui/machine-setup';
import { memoryByKey, modelById } from './models';
import { JsonRecord, Settings } from './ui/settings';
import { attachToolbar } from './ui/toolbar';
import { crc32 } from './util/crc32';

/** Form fields whose values are remembered between visits. */
const REMEMBERED_SETTINGS = [
  'port1-device',
  'port1-keys',
  'port1-pad',
  'port2-keys',
  'port2-pad',
  'warp',
  'sound',
  'volume',
  'separation',
];

/** How often games' saves to their disks are written to browser storage. */
const DISK_SAVE_INTERVAL_MS = 2000;
const DRIVES = 2;

/** How the machine was set up last time (earlier versions of the page kept some of it with the other settings). */
function rememberedChoices(record: JsonRecord<MachineChoices>, settings: Settings): MachineChoices {
  const older: Partial<MachineChoices> = {};
  if (settings.get('tv') === 'ntsc') older.standard = 'ntsc';
  const olderKey = settings.get('memory');
  if (typeof olderKey === 'string') older.memory = memoryByKey(modelById('a500'), olderKey);
  if (settings.get('external-drive') === true) older.externalDrive = true;
  const choices = { ...DEFAULT_CHOICES, ...older, ...record.read() };
  // Earlier choices had no model (an A500) and no fast RAM.
  const model = modelById(choices.model);
  const memory: MemoryConfig = { ...choices.memory, fastKb: choices.memory.fastKb ?? 0 };
  return { ...choices, model: model.id, memory: modelMemory(model, memory) };
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Page is missing ${selector}`);
  return element;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'amiga';


/** A line about a disk: what kind it is, from its first sectors. */
function describeDisk(disk: FloppyDisk): string {
  const { sectors } = disk;
  if (sectors[0] === 0x44 && sectors[1] === 0x4f && sectors[2] === 0x53) return 'AmigaDOS disk';
  if (sectors.subarray(0, 1024).every((byte) => byte === 0)) return 'blank disk';
  return 'custom disk (its own loader)';
}

async function main(): Promise<void> {
  const canvas = requireElement<HTMLCanvasElement>('#screen');
  const status = requireElement<HTMLParagraphElement>('#status');
  const screenFrame = requireElement<HTMLElement>('.screen-frame');
  const romSetup = requireElement<HTMLElement>('#rom-setup');

  try {
    const settings = new Settings();
    settings.bind(document, REMEMBERED_SETTINGS);

    // --- Kickstart -------------------------------------------------------------------
    let storageWorks = true;
    const stores = await openBrowserStores(() => {
      status.textContent = "Waiting for the browser's storage: if this Amiga is open in another tab, close or reload that tab.";
    }).catch((error: unknown) => {
      console.warn('Browser storage is unavailable; saves will last until the page is closed.', error);
      storageWorks = false;
      return memoryStores();
    });
    if (!storageWorks) {
      requireElement<HTMLElement>('.rom-storage-note').textContent =
        "This browser isn't letting the page store files, so the ROM will be forgotten when you close it.";
    }
    const romStore = new SystemRomStore(stores.systemRoms as KeyValueStore<StoredRom>);
    const machineRecord = new JsonRecord<MachineChoices>('amiga-machine');
    let choices = rememberedChoices(machineRecord, settings);
    const hardDisks = new HardDisks(stores.hardDisk);
    /** The hard disk while it is attached (loaded from storage when the drive is on). */
    let hardDiskImage: HardDiskImage | null = null;
    let hardDiskName = 'Hard disk';

    const exportHardDisk = async () => {
      if (hardDiskImage) await hardDisks.persist(hardDiskImage);
      const image = hardDiskImage ?? (await hardDisks.load());
      const info = await hardDisks.info();
      if (image) downloadFile(image.bytes, `${slug(info?.name ?? 'hard disk')}.hdf`);
    };
    /** Carries out what the setup panel asked for the stored hard disk, then loads it if the drive is on. */
    const applyHardDisk = async (setup: MachineSetup) => {
      if (hardDiskImage) await hardDisks.persist(hardDiskImage);
      if (setup.hardDisk.kind === 'new') await hardDisks.replace(setup.hardDisk.image, setup.hardDisk.name);
      if (setup.hardDisk.kind === 'delete') await hardDisks.delete();
      hardDiskImage = setup.hardDisk.kind === 'new' ? setup.hardDisk.image : null;
      if (setup.choices.hardDrive && !hardDiskImage) hardDiskImage = await hardDisks.load();
      hardDiskName = (await hardDisks.info())?.name ?? 'Hard disk';
    };

    let kickstart: Kickstart | null = await romStore.load();
    if (!kickstart) {
      status.textContent = 'Load a Kickstart ROM above to switch the Amiga on.';
      const setup = await askForMachine(romSetup, romStore, null, { choices, hardDisk: await hardDisks.info(), exportHardDisk });
      if (!setup) throw new Error('No Kickstart ROM.');
      kickstart = setup.kickstart;
      choices = setup.choices;
      machineRecord.write(choices);
      await applyHardDisk(setup);
    } else if (choices.hardDrive) {
      hardDiskImage = await hardDisks.load();
      hardDiskName = (await hardDisks.info())?.name ?? 'Hard disk';
    }
    let kickstartCrc = crc32(kickstart.data);

    // --- The machine -----------------------------------------------------------------
    const screen = new Screen(canvas);
    screen.onAspect = (aspect) => document.documentElement.style.setProperty('--screen-aspect', aspect.toFixed(4));
    screen.onAspect(screen.aspect);
    const emulator = new Emulator(screen);
    const amiga = emulator.amiga;
    amiga.setKickstart(kickstart.data);
    const audio = await AudioOutput.create().catch((error: unknown) => {
      console.warn('Audio is unavailable:', error);
      return null;
    });
    if (audio) amiga.setSampleRate(audio.sampleRate);

    let paused = false;
    /** While the ROM setup is open over the running Amiga. */
    let changingRoms = false;
    const focusScreen = () => canvas.focus();

    const updateStatus = () => {
      const parts = [amiga.model.name, kickstart!.title, amiga.standard.toUpperCase(), memoryLabel(amiga.memory)];
      if (amiga.drives[1].connected) parts.push('DF1');
      if (amiga.gayle) parts.push(`DH0 ${megabytes(amiga.gayle.drive.image.bytes.length)}`);
      status.textContent = parts.join(' · ');
    };

    const applyMachine = (choices: MachineChoices) => {
      amiga.setModel(modelById(choices.model));
      amiga.setStandard(choices.standard);
      screen.setStandard(choices.standard);
      amiga.setMemory(choices.memory);
      amiga.setExternalDrive(choices.externalDrive);
      diskPanel.setDriveConnected(1, choices.externalDrive);
      if (!choices.externalDrive) {
        diskSaves.eject(1);
        diskPanel.showEmpty(1);
      }
      const attached = choices.hardDrive ? hardDiskImage : null;
      amiga.attachHardDisk(attached);
      diskPanel.showHardDisk(choices.hardDrive, attached ? hardDiskName : null, attached ? megabytes(attached.bytes.length) : '');
    };

    const powerCycle = () => {
      amiga.powerOn();
      emulator.resetTiming();
      audio?.flush();
      updateStatus();
    };

    // --- Disks and their saves -------------------------------------------------------
    const diskSaves = new DiskSaves(
      stores.diskSaves as KeyValueStore<DiskSaveRecord>,
      stores.saveDisks as KeyValueStore<SaveDiskRecord>,
    );
    /** The names shown for the disks in the drives (also used to label save states). */
    const diskLabels: (string | null)[] = [null, null];

    const refreshSaveDisks = async () => diskPanel.setSaveDisks(await diskSaves.listSaveDisks());

    /** Stores what games have written to a drive's disk. */
    const persistDisk = async (drive: number) => {
      const disk = amiga.drives[drive].disk;
      if (!disk || !disk.dirty) return;
      await diskSaves.persist(drive, disk);
      if (diskSaves.origin(drive)?.kind === 'image') diskPanel.setSavedChanges(drive, true);
    };
    const persistHardDisk = async () => {
      if (hardDiskImage) await hardDisks.persist(hardDiskImage);
    };
    const persistAll = () => Promise.all([...[0, 1].map((drive) => persistDisk(drive)), persistHardDisk()]);
    setInterval(() => {
      for (let drive = 0; drive < DRIVES; drive++) {
        // Wait for the motor to stop, so a track being written is finished.
        if (!amiga.drives[drive].motor) void persistDisk(drive).catch((error: unknown) => console.warn('Could not keep the disk:', error));
      }
      // And for the hard drive to go quiet, so a file being written is complete.
      if (amiga.gayle && amiga.gayle.drive.activity === 0) void persistHardDisk().catch((error: unknown) => console.warn('Could not keep the hard disk:', error));
    }, DISK_SAVE_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void persistAll();
    });
    window.addEventListener('pagehide', () => void persistAll());

    const insertDisk = async (drive: number, image: FloppyDisk, label: string) => {
      await persistDisk(drive);
      const { disk, hasSavedChanges } = await diskSaves.openImage(drive, image);
      amiga.insertDisk(drive, disk);
      diskLabels[drive] = label;
      diskPanel.showDisk(drive, label, describeDisk(disk), hasSavedChanges);
    };

    const eject = (drive: number) => {
      void persistDisk(drive).then(() => {
        diskSaves.eject(drive);
        amiga.insertDisk(drive, null);
        diskLabels[drive] = null;
        diskPanel.showEmpty(drive);
      });
    };

    // --- Save states -----------------------------------------------------------------
    const saveStates = new SaveStates(stores.saveStates as KeyValueStore<SaveStateRecord>);
    const sessionName = () => diskLabels[0] ?? kickstart!.title;
    const currentSession = async (): Promise<Session> => {
      await persistAll();
      return {
        machine: amiga.saveState(),
        kickstartCrc,
        kickstartTitle: kickstart!.title,
        model: amiga.model.id,
        standard: amiga.standard,
        memory: amiga.memory,
        externalDrive: amiga.drives[1].connected,
        disks: amiga.drives.slice(0, DRIVES).map((drive, i) =>
          drive.disk ? { name: diskLabels[i] ?? drive.disk.name, adf: drive.disk.toAdf(), origin: diskSaves.origin(i) } : null,
        ),
      };
    };
    const restoreSession = async (session: Session) => {
      if (session.kickstartCrc !== kickstartCrc) {
        throw new Error(`That state was saved with ${session.kickstartTitle}; load that Kickstart (Machine setup...) to use it.`);
      }
      await persistAll();
      choices = {
        ...choices,
        model: modelById(session.model).id,
        standard: session.standard,
        memory: { ...session.memory, fastKb: session.memory.fastKb ?? 0 } as MemoryConfig,
        externalDrive: session.externalDrive,
      };
      machineRecord.write(choices);
      applyMachine(choices);
      session.disks.forEach((saved, drive) => {
        const disk = saved ? FloppyDisk.fromAdf(saved.adf, saved.name) : null;
        // In without the disk-change signal: the restored drive state says whether it was changed.
        amiga.drives[drive].disk = disk;
        diskSaves.adopt(drive, saved?.origin ?? null);
        diskLabels[drive] = saved?.name ?? null;
        if (disk && saved) diskPanel.showDisk(drive, saved.name, describeDisk(disk), saved.origin?.kind === 'image' && disk.dirty);
        else diskPanel.showEmpty(drive);
      });
      amiga.loadState(session.machine);
      emulator.resetTiming();
      audio?.flush();
      updateStatus();
    };

    // --- Panels ----------------------------------------------------------------------
    let bundledGames: BundledGame[] = [];
    /** Puts one disk image in a drive, or loads a save state. Disk swaps aren't counted as new games. */
    const openDisk = async (file: File, drive: number, newGame = false) => {
      const media = await readMedia(file);
      if (media.kind === 'state') {
        await restoreSession(await decodeSession(media.bytes));
        toolbar.showMessage('Save state loaded');
        return;
      }
      const game = bundledGames.find((entry) => entry.file.split('/').pop() === file.name);
      await insertDisk(drive, media.disk, game?.title ?? titleFromFileName(file.name));
      diskPanel.markSetDisk(drive, file.name);
      if (newGame) trackGameLoaded('amiga500', game?.title);
    };

    /** Files dropped or chosen together: every disk in them gets a button, and the first goes in. */
    const openFiles = async (chosen: File[], drive: number) => {
      const files = (await Promise.all(chosen.map((file) => filesFrom(file)))).flat();
      if (chosen.length > 1) files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const first = firstDisk(files);
      diskPanel.setZipFiles(files.length > 1 ? files : []);
      await openDisk(first, drive, true);
    };

    const diskPanel = new DiskPanel(requireElement('#disk-panel'), {
      onFiles: openFiles,
      onSwapDisk: openDisk,
      onEject: eject,
      onRevert: async (drive) => {
        const disk = await diskSaves.revert(drive);
        if (!disk) return;
        amiga.insertDisk(drive, disk);
        diskPanel.setSavedChanges(drive, false);
      },
      onDownload: async (drive) => {
        const disk = amiga.drives[drive].disk;
        if (!disk) return;
        if (!disk.savableAsAdf) diskPanel.showMessage('This disk has tracks in its own format; the .adf only has the AmigaDOS ones.', true);
        downloadFile(disk.toAdf(), `${slug(diskLabels[drive] ?? disk.name)}.adf`);
      },
      onGame: (index) => fetchGame(import.meta.env.BASE_URL, bundledGames[index]),
      onPlayGame: async (file) => {
        await openFiles([file], 0);
        amiga.reset();
        emulator.resetTiming();
        audio?.flush();
      },
      onNewSaveDisk: async (drive) => {
        await persistDisk(drive);
        const { disk, name } = await diskSaves.createSaveDisk(drive);
        amiga.insertDisk(drive, disk);
        diskLabels[drive] = name;
        diskPanel.showDisk(drive, name, 'blank disk: format it from the game or Workbench', false);
        await refreshSaveDisks();
      },
      onInsertSaveDisk: async (id, drive) => {
        await persistDisk(drive);
        const opened = await diskSaves.openSaveDisk(drive, id);
        if (!opened) throw new Error('That save disk no longer exists.');
        amiga.insertDisk(drive, opened.disk);
        diskLabels[drive] = opened.name;
        diskPanel.showDisk(drive, opened.name, describeDisk(opened.disk), false);
      },
      onExportSaveDisk: async (id) => {
        await persistAll();
        const bytes = await diskSaves.saveDiskBytes(id);
        const name = (await diskSaves.listSaveDisks()).find((disk) => disk.id === id)?.name ?? 'save disk';
        if (bytes) downloadFile(bytes, `${slug(name)}.adf`);
      },
      onDeleteSaveDisk: async (id) => {
        for (let drive = 0; drive < DRIVES; drive++) {
          const origin = diskSaves.origin(drive);
          if (origin?.kind === 'saveDisk' && origin.id === id) {
            amiga.insertDisk(drive, null);
            diskLabels[drive] = null;
            diskPanel.showEmpty(drive);
          }
        }
        await diskSaves.deleteSaveDisk(id);
        await refreshSaveDisks();
      },
      onWarp: (enabled) => (emulator.warpWhileLoading = enabled),
      focusScreen,
    });

    const refreshStates = async () => toolbar.setStates(await saveStates.list());
    const toolbar = attachToolbar(requireElement('#toolbar'), {
      onPause: (pause) => {
        paused = pause;
        screenFrame.classList.toggle('paused', pause);
        emulator.resetTiming();
        audio?.flush();
      },
      onReset: () => {
        amiga.reset();
        audio?.flush();
      },
      onPowerCycle: powerCycle,
      onFullscreen: () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void screenFrame.requestFullscreen().then(focusScreen);
      },
      onSaveState: async () => {
        await saveStates.add(sessionName(), await currentSession());
        await refreshStates();
        toolbar.showMessage('State saved');
      },
      onLoadState: async (id) => {
        const session = await saveStates.load(id);
        if (!session) throw new Error('That save state no longer exists.');
        await restoreSession(session);
        toolbar.showMessage('State loaded');
      },
      onDeleteState: async (id) => {
        await saveStates.delete(id);
        await refreshStates();
      },
      onExportState: async () => {
        downloadFile(await encodeSession(await currentSession()), `${slug(sessionName())}${STATE_EXTENSION}`);
      },
      onImportState: async (file) => {
        await restoreSession(await decodeSession(new Uint8Array(await file.arrayBuffer())));
        toolbar.showMessage('Save state loaded');
      },
      focusScreen,
    });
    await refreshStates();
    await refreshSaveDisks();

    void loadGameManifest(import.meta.env.BASE_URL).then((games) => {
      bundledGames = games;
      const href = (link?: string) => (link?.startsWith('games/') ? `${import.meta.env.BASE_URL}${link}` : link);
      diskPanel.setGames(games.map((game) => ({ ...game, licenseHref: href(game.licenseUrl), sourceHref: href(game.sourceUrl) })));
    });

    /** Shows Machine setup over the paused Amiga; what it sets takes effect with a power cycle. */
    const openMachineSetup = async () => {
      if (changingRoms) return;
      changingRoms = true;
      audio?.flush();
      await persistHardDisk();
      const setup = await askForMachine(romSetup, romStore, await romStore.load(), {
        whileRunning: true,
        choices,
        hardDisk: await hardDisks.info(),
        exportHardDisk,
      });
      changingRoms = false;
      if (setup) {
        await persistAll();
        await applyHardDisk(setup);
        kickstart = setup.kickstart;
        kickstartCrc = crc32(setup.kickstart.data);
        amiga.setKickstart(setup.kickstart.data);
        choices = setup.choices;
        machineRecord.write(choices);
        applyMachine(choices);
        powerCycle();
      }
      focusScreen();
    };
    requireElement<HTMLButtonElement>('[data-action="machine-setup"]').addEventListener('click', () => void openMachineSetup());

    // --- Inputs ----------------------------------------------------------------------
    const input = new BrowserInput(amiga, canvas);
    input.attach(window);
    const mouseLabel = requireElement<HTMLElement>('.mouse-label');
    input.onMouseCapture = (captured) => (mouseLabel.hidden = captured || amiga.ports.port1 !== 'mouse');
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Pause') toolbar.setPaused(!toolbar.paused);
    });

    const port1Device = requireElement<HTMLSelectElement>('select[name="port1-device"]');
    const port1Keys = requireElement<HTMLSelectElement>('select[name="port1-keys"]');
    const port1Pad = requireElement<HTMLSelectElement>('select[name="port1-pad"]');
    const port2Keys = requireElement<HTMLSelectElement>('select[name="port2-keys"]');
    const port2Pad = requireElement<HTMLSelectElement>('select[name="port2-pad"]');
    const applyPorts = () => {
      const device = port1Device.value as Port1Device;
      amiga.ports.port1 = device;
      port1Keys.hidden = port1Pad.hidden = device !== 'joystick';
      input.setJoystickKeys(0, device === 'joystick' ? (port1Keys.value as KeySetName) : 'off');
      input.setJoystickKeys(1, port2Keys.value as KeySetName);
      if (device !== 'mouse') input.exitCapture();
      mouseLabel.hidden = device !== 'mouse';
    };
    for (const select of [port1Device, port1Keys, port2Keys]) {
      select.addEventListener('change', () => {
        applyPorts();
        focusScreen();
      });
    }
    applyPorts();

    const gamepads = new GamepadManager();
    gamepads.attach(window);
    const gamepadStatus = requireElement<HTMLElement>('.gamepad-status');
    let lastPadNames = '';
    const pollGamepads = () => {
      const pads = gamepads.connected();
      const choices = [amiga.ports.port1 === 'joystick' ? port1Pad.value : 'off', port2Pad.value];
      choices.forEach((choice, port) => {
        const pad = choice === 'off' ? undefined : pads[Number(choice)];
        if (pad) amiga.ports.joysticks[port].set('gamepad', readGamepad(pad));
        else amiga.ports.joysticks[port].clear('gamepad');
      });
      const names = pads.map((pad, i) => `Gamepad ${i + 1}: ${padName(pad)}`).join(' · ');
      if (names !== lastPadNames) {
        lastPadNames = names;
        gamepadStatus.textContent = names;
      }
    };

    const sound = requireElement<HTMLInputElement>('input[name="sound"]');
    const volume = requireElement<HTMLInputElement>('input[name="volume"]');
    const separation = requireElement<HTMLInputElement>('input[name="separation"]');
    const soundHint = requireElement<HTMLElement>('.sound-hint');
    const applySound = () => {
      audio?.setEnabled(sound.checked);
      audio?.setVolume(Number(volume.value));
      amiga.paula.audio.separation = Number(separation.value);
    };
    sound.addEventListener('change', applySound);
    volume.addEventListener('input', applySound);
    separation.addEventListener('input', applySound);
    applySound();
    if (!audio) {
      sound.disabled = volume.disabled = true;
      soundHint.textContent = 'Sound is not supported in this browser';
      soundHint.hidden = false;
    } else if (!audio.running) {
      soundHint.hidden = false;
      audio.resumeOnGesture(window, () => (soundHint.hidden = true));
    }

    // --- Main loop -------------------------------------------------------------------
    const leds = [false, false];
    let hardDiskLed = false;
    let last = performance.now();
    let wasWarped = false;
    const frame = (now: number) => {
      const elapsed = now - last;
      last = now;
      pollGamepads();
      if (!paused && !changingRoms) {
        emulator.run(elapsed);
        // Warped sound would play many times too fast, so it is dropped.
        const samples = emulator.takeAudioSamples();
        if (emulator.warped !== wasWarped) audio?.flush();
        wasWarped = emulator.warped;
        if (!emulator.warped) audio?.play(samples);
      }
      for (let drive = 0; drive < DRIVES; drive++) {
        const on = amiga.drives[drive].motor && amiga.drives[drive].disk !== null;
        if (on !== leds[drive]) {
          leds[drive] = on;
          diskPanel.setLed(drive, on);
        }
      }
      const hardDiskOn = (amiga.gayle?.drive.activity ?? 0) > 0;
      if (hardDiskOn !== hardDiskLed) {
        hardDiskLed = hardDiskOn;
        diskPanel.setHardDiskLed(hardDiskOn);
      }
      screen.present();
      requestAnimationFrame(frame);
    };

    applyMachine(choices);
    diskPanel.showEmpty(0);
    diskPanel.showEmpty(1);
    powerCycle();
    focusScreen();
    requestAnimationFrame(frame);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

void main();
