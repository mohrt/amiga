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

Drop an `.adf`, `.adz` or `.zip` onto the page to put it in a drive. PAL and NTSC machines are both available.

## Keys and controllers

- **Keyboard:** keys type on the Amiga as labelled. Home and End are the left and right Amiga keys (Cmd stays with the browser), Insert or Page Down is Help, and Ctrl with both Amiga keys resets the Amiga. Pause pauses the emulator.
- **Mouse:** in port 1. Click the screen to capture the mouse; Esc lets it go.
- **Joysticks:** most games use port 2. Choose keys for it under the screen: the numpad, the arrow keys with Space, or W A S D with F. Keys used by a joystick don't type on the Amiga, so set it back to No keys for typing. Port 1 can hold a joystick instead of the mouse.
- **Gamepads:** they work without taking any keys. Choose which gamepad goes in which port.
- **Sound:** the stereo slider sets how far apart the left channels (0 and 3) and the right channels (1 and 2) are. The Amiga's own separation is fully apart. The power light switches the "LED" low-pass filter, as on the real machine.

## The machine

The toolbar has pause, reset (Ctrl-Amiga-Amiga), power cycle and full screen, plus the machine's setup:

- **TV:** PAL (50 Hz) or NTSC (60 Hz).
- **Memory:** 512K chip RAM plus the 512K "slow" RAM of the trapdoor expansion (the most compatible), 512K only, or 1MB of chip RAM.
- **DF1:** an external second drive.

Changing the setup switches the Amiga off and on. Save states keep the whole machine, disks included, in the browser, and can be exported and imported as `.amigastate` files. A state only loads with the Kickstart it was saved with.

## ROMs

No ROM or game files are included in this repository.

- **Kickstart:** the Amiga's operating system ROM is still under copyright, so the site never serves it. On the first visit the page shows a setup panel in place of the screen, asking for a Kickstart image. Kickstart 1.3 is the A500's own and runs the most games; 1.2, 2.04 and 3.1 for the A500 work too.
  - The panel recognises Commodore's originals by checksum. It turns away ROMs made for later Amigas, such as those for the A1200, A3000, A4000 and CD32, which need a newer CPU.
  - It also accepts byte-swapped dumps, overdumps (a 256K ROM repeated twice), dumps of the two ROM chips, and Amiga Forever's encrypted ROMs together with their `rom.key`.
  - The ROM is kept in the browser's IndexedDB, with persistent storage requested, so later visits start straight away. **System ROMs...** in the toolbar changes or forgets it.
- **AROS:** the free replacement ROMs (AROS Public License) are downloaded by `npm run fetch:roms`. Only the tests use them.

## Disks

`.adf` disk images go in as they are. `.adz` (gzipped) and `.zip` work too; the other disks of a zip get buttons, for swapping disks during a game. Extended ADFs (`UAE-1ADF`) with raw MFM tracks, as copy-protected disks need, also work. DMS and IPF images aren't supported; unpack DMS archives to `.adf` first.

Your disk images are never changed. What games write to a disk is kept in the browser (only the sectors that changed) and put back whenever that image is inserted again. **Revert** forgets it, and **Download .adf** gives you the disk as it is now. **New blank disk** makes an empty disk for games that want a save disk of their own. Format it from the game or from Workbench.

**Fast loading** runs the Amiga flat out while a drive's motor is on, and the sound is skipped meanwhile.

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
npm run fetch:roms       # optional: the AROS ROMs, for the AROS boot test
npm run fetch:m68k       # optional: the 68000 SingleStepTests (about 200 MB)
npm run fetch:hw-tests   # optional: vAmigaTS chipset tests (`-- 30` takes more per group, `-- all` all of them)
```

The tests that boot Kickstart use your own ROMs, put in `roms/` (never committed) as `kick13.rom`, `kick12.rom`, `kick204.rom` and `kick31.rom`. `npm test` also boots the free games and any `.adf` you put in `disks/`. `SHOTS=/tmp/shots npm test` saves screenshots, `M68K=ADD.w,DIVU npm test` runs only some of the 68000 tests, and `HW=<id>,<id>` only some vAmigaTS tests.

## Deploying

`.github/workflows/pages.yml` downloads the free games, the AROS ROMs and the 68000 tests, tests and builds the site, and deploys it to GitHub Pages on every push to `main` (Pages source: "GitHub Actions").
