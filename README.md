# Amiga 500 in the browser

**Play it at [mohrt.github.io/amiga500](https://mohrt.github.io/amiga500/)**

A Commodore Amiga 500 emulator written from scratch in TypeScript. It has:

- **CPU:** a 68000 that passes Tom Harte's SingleStepTests for every instruction, cycle counts included. It is the same core as the [Genesis emulator](https://mohrt.github.io/genesis/).
- **Agnus:** the original chipset's (OCS) DMA controller. It gives each memory cycle of a line to refresh, disk, sound, sprites or bitplanes, and what's left to the Copper, the blitter and the CPU, which waits for a free cycle on the chip bus.
- **The Copper**, with WAIT, SKIP and the danger bit.
- **The blitter:** all 256 logic functions, shifts, masks, descending mode, inclusive and exclusive fill, and line drawing with textures and one dot per line.
- **Denise:** lores and hires, up to six bitplanes scrolled per playfield, dual playfield, hold-and-modify and extra half-brite, eight sprites (attached in pairs for 15 colours), collisions and interlace.
- **Paula:** four sound channels with modulation and the A500's two filters, the interrupt controller, and the disk controller.
- **Everything else:** two 8520 CIAs, the keyboard, a mouse and joysticks, and the internal drive DF0 with an optional external DF1.
- **A hard drive:** an IDE drive on an A600-style Gayle port, which Kickstart 3.1's own driver uses.

Drop an `.adf`, `.adz` or `.zip` onto the page to put it in a drive. PAL and NTSC machines are both available.

## Keys and controllers

- **Keyboard:** keys type on the Amiga as labelled. Home and End are the left and right Amiga keys (Cmd stays with the browser), Insert or Page Down is Help, and Ctrl with both Amiga keys resets the Amiga. Pause pauses the emulator.
- **Mouse:** in port 1. Click the screen to capture the mouse; Esc lets it go.
- **Joysticks:** most games use port 2. Choose keys for it under the screen: the numpad, the arrow keys with Space, or W A S D with F. Keys used by a joystick don't type on the Amiga, so set it back to No keys for typing. Port 1 can hold a joystick instead of the mouse.
- **Gamepads:** they work without taking any keys. Choose which gamepad goes in which port.
- **Sound:** the Amiga plays channels 0 and 3 only on the left and channels 1 and 2 only on the right. The Stereo slider blends them: at the Mono end all the sound is in the middle, and at the Amiga end the sides are fully apart, as on the real machine. On headphones, a setting towards Mono is easier on the ears. The power light switches the "LED" low-pass filter, as on the real machine.

## The machine

The toolbar has pause, reset (Ctrl-Amiga-Amiga), power cycle and full screen. **Machine setup...** opens the setup panel over the screen:

- **Kickstart:** the ROM (see below).
- **TV:** PAL (50 Hz) or NTSC (60 Hz).
- **Memory:** 512K chip RAM plus the 512K "slow" RAM of the trapdoor expansion (the most compatible), 512K only, or 1MB of chip RAM.
- **DF1:** an external second drive.
- **Hard drive:** DH0, with **New hard disk** (20 to 250 MB), **Import .hdf...**, **Export .hdf** and **Delete**.

Nothing changes until **Restart the Amiga with these settings**, which switches it off and on. Save states keep the whole machine, floppy disks included, in the browser, and can be exported and imported as `.amigastate` files. A state only loads with the Kickstart it was saved with. The hard disk's contents aren't part of a save state, so loading an old state doesn't undo what was written to it.

## Hard drive

The drive is an IDE one, as on an A600. Kickstart 3.1 (and the A600's 2.05) find it with their own `scsi.device`; 1.3 and 2.04 have no driver for it. The hard disk is kept in the browser (in 1 MB pieces, saving only the ones that changed), and shows under the screen as DH0 with its activity light. **Export .hdf** downloads it in the format WinUAE and FS-UAE use, and their `.hdf` files can be imported if they were partitioned with HDToolBox (an image of a single partition won't mount).

Installing Workbench 3.1 on it:

1. In **Machine setup...**, use Kickstart 3.1, tick **IDE hard drive**, choose a size and press **New hard disk**, then restart.
2. Boot the **Install** disk of Workbench 3.1. Open **HDTools**, then **HDToolBox**. It lists the drive as unknown: choose **Change Drive Type**, **Define New...** and **Read Configuration**, OK your way back, then press **Save Changes to Drive**. The partitions it suggests are fine, or change them in **Partition Drive** first.
3. Restart. The new partitions appear on the Workbench as `DH0:NDOS`; select one, choose **Format Disk...** from the Icons menu, name it (System for DH0) and use **Quick Format**.
4. From the Install disk, run **Install3.1** in the language you want and choose **Install Release 3.1** onto DH0 when it asks. Swap in the disks it asks for with the disk buttons (load all six Workbench disks at once).
5. Take the floppy out and restart: the Amiga boots Workbench from the hard drive.

## ROMs

No Kickstart or game files are included in this repository; the only ROMs in it are the free AROS ones the tests use.

- **Kickstart:** the Amiga's operating system ROM is still under copyright, so the site never serves it. On the first visit the page shows a setup panel in place of the screen, asking for a Kickstart image. Kickstart 1.3 is the A500's own and runs the most games; 1.2, 2.04 and 3.1 for the A500 work too.
  - The panel recognises Commodore's originals by checksum. It turns away ROMs made for later Amigas, such as those for the A1200, A3000, A4000 and CD32, which need a newer CPU.
  - It also accepts byte-swapped dumps, overdumps (a 256K ROM repeated twice), dumps of the two ROM chips, and Amiga Forever's encrypted ROMs together with their `rom.key`.
  - A whole ROM collection works too, even one with a zip for each ROM inside a zip. The panel uses the newest Kickstart for the A500 in it (3.1, then 2.05, 2.04, 1.3 and 1.2). Its **Use** menu switches to any of the others found, and they're kept for later visits too. Kickstart 1.3 runs the most A500 games.
  - The ROM is kept in the browser's IndexedDB, with persistent storage requested, so later visits start straight away. **Machine setup...** in the toolbar changes or forgets it.
- **AROS:** the free replacement ROMs (AROS Public License) are in `tests/fixtures/aros/`. Only the tests use them; the site never serves them.

## Disks

`.adf` disk images go in as they are. `.adz` (gzipped) and `.zip` work too. Several files dropped or chosen at once, or a zip holding several disks, give each drive a **Swap disk** menu for changing disks during a game; the menu marks the disks that are already in a drive. The first disk by name goes in first, or the Workbench disk of a Workbench set, since a set's first disk is often its installer. Extended ADFs (`UAE-1ADF`) with raw MFM tracks, as copy-protected disks need, also work. DMS and IPF images aren't supported; unpack DMS archives to `.adf` first.

Your disk images are never changed. What games write to a disk is kept in the browser (only the sectors that changed) and put back whenever that image is inserted again. **Revert** forgets it, and **Download .adf** gives you the disk as it is now. **New blank disk** makes an empty disk for games that want a save disk of their own. Format it from the game or from Workbench.

**Fast loading** runs the Amiga flat out while a disk is being read (disk DMA within the last half second, with the motor on), and the sound is skipped meanwhile. Many games leave the motor on once they've loaded, so the motor alone doesn't count.

## Free games

`npm run fetch:games` downloads the freely licensed games listed in `scripts/games-catalog.json` into `public/games/`, where they appear in a "Free games" picker. Each entry has its credit, licence, source and checksum. To offer other games, list them in `public/games/index.json` the same way: `{ "games": [{ "title": "Some Game", "file": "some-game.adf" }] }`.

## Accuracy

Kickstart 1.2, 1.3, 2.04, 3.1 and AROS all start. AmigaDOS boots from disk, and the free games and demos such as Mandarine's System Zoetrope run.

The chips are run up to the CPU's time whenever it touches the chip bus, so DMA delays the CPU to the memory cycle. The CPU's own internal cycles are counted per instruction, though, not placed between its memory accesses.

`npm run fetch:hw-tests` downloads a sample of the chipset tests from Dirk Hoffmann's vAmigaTS suite, a few from each group. Each test is a disk with a screenshot from vAmiga, a cycle-exact emulator checked against real Amigas. 17 of the 49 A500 tests in the sample match vAmiga's picture. The others still differ, mostly by a few cycles of DMA, interrupt or display window timing. They are listed in `tests/hardware.test.ts`, which expects them to fail, so one that starts matching shows up.

Not covered: the ECS and AGA chipsets (and so the A500+, A600 and A1200), hard drives, Fast RAM, the serial and parallel ports, and DMS and IPF images.

## Development

```sh
npm install
npm run fetch:games      # optional: free games into public/games/
npm run dev              # http://localhost:5173
npm test                 # tests needing downloaded files or your ROMs skip when they're missing
npm run fetch:m68k       # optional: the 68000 SingleStepTests (about 200 MB)
npm run fetch:hw-tests   # optional: vAmigaTS chipset tests (`-- 30` takes more per group, `-- all` all of them)
```

The tests that boot Kickstart use your own ROMs, put in `roms/` (never committed) as `kick13.rom`, `kick12.rom`, `kick204.rom` and `kick31.rom`. `npm test` also boots the free games and any `.adf` you put in `disks/`. `SHOTS=/tmp/shots npm test` saves screenshots, `M68K=ADD.w,DIVU npm test` runs only some of the 68000 tests, and `HW=<id>,<id>` only some vAmigaTS tests.

## Deploying

`.github/workflows/pages.yml` downloads the free games and the 68000 tests, tests and builds the site, and deploys it to GitHub Pages on every push to `main` (Pages source: "GitHub Actions").
