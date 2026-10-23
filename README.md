# Amiga in the browser

**Play it at [mohrt.github.io/amiga](https://mohrt.github.io/amiga/)**

A Commodore Amiga emulator written from scratch in TypeScript: the Amiga 500, and in **Machine setup...** the Amiga 1000, 2000, 500 Plus, 600, 1200, 3000, 4000 and CD32. It has:

- **CPU:** a 68000 that passes Tom Harte's SingleStepTests for every instruction, cycle counts included. It is the same core as the [Genesis emulator](https://mohrt.github.io/genesis/). It waits for the chip bus as the real one does, and its interrupts, branches and returns make their bus accesses in the real CPU's order. For the A1200 it becomes a 68EC020 at twice the speed: the 68020's addressing modes, instructions (32-bit multiply and divide, bit fields, CAS, CHK2, MOVEC and the rest) and exception frames, with the vector base register. For the A3000 and A4000 it is a 68030 at 25 MHz with all 32 address bits, its data cache bits and its MMU's registers (Kickstart leaves the MMU off, so addresses aren't translated), and a 68882 FPU: FMOVE in every format, FMOVEM, the constant ROM, the arithmetic and transcendental operations, the conditional branches, sets and traps, and FSAVE/FRESTORE (its registers are doubles, rather than 80 bits).
- **Agnus:** the original chipset's (OCS) DMA controller, the ECS Super Agnus, and the A1200's AGA Alice with its 32- and 64-bit fetches (FMODE), eight bitplanes and scan doubling. Each memory cycle of a line goes to refresh, disk, sound, sprites or bitplanes, then to the Copper, then the blitter, and the CPU gets the cycle if it is still free. Bitplane fetching runs the hardware's DDF logic (the hardware start and stop, the last fetch unit with its modulos, the vertical window flip-flop), and register writes take effect after the few cycles they take on the real chips.
- **The Copper**, with WAIT, SKIP and the danger bit, its comparator two cycles ahead of the beam, and the cycle $E0 it can't have.
- **The blitter:** all 256 logic functions, shifts, masks, descending mode, inclusive and exclusive fill, and line drawing with textures and one dot per line, cycle by cycle as the Hardware Reference Manual's timing table has it (the CPU gets the idle cycles, even with BLTPRI). ECS's larger blits too.
- **Denise:** lores and hires, up to six bitplanes scrolled per playfield, dual playfield, hold-and-modify (on either playfield mode) and extra half-brite, the invalid plane counts and priorities, eight sprites (attached in pairs for 15 colours), collisions and interlace. The horizontal display window is the hardware's flip-flop. ECS Denise adds super-hires and the border blank; the A1200's Lisa has 256 colours from a 24-bit palette, HAM8, colour banks for the playfields and sprites, readable colour registers, and sprites 32 and 64 pixels wide.
- **Paula:** four sound channels with modulation and the A500's two filters, the interrupt controller (whose level reaches the CPU three cycles later, as on the hardware), and the disk controller.
- **Everything else:** two 8520 CIAs, the keyboard, a mouse and joysticks, and the internal drive DF0 with an optional external DF1; the battery-backed clock of the A2000, A500 Plus, A3000 and A4000, and fast RAM (Zorro II, the A1200's trapdoor, or the A3000's and A4000's 32-bit RAM on the main board, with their Ramsey and Gary chips). The A3000's SCSI controller (its SDMAC and WD33C93) runs the SCSI bus phases, with the hard drive at ID 0.
- **The CD32's Akiko chip:** its CD drive (the TOC, data sectors by DMA into its 16 buffers, audio tracks played into the sound, the drive's command and result rings with their checksums), the chunky-to-planar converter, and the 1 KB save memory (a 24C08 EEPROM on I2C, kept in the browser). CD images go in as an `.iso`, or a `.cue` with its `.bin` (or `.wav`) files, dropped on the page or chosen together.
- **A hard drive:** an IDE drive on the A600's and A1200's Gayle port or the A4000's own port (added on for the other models), or a SCSI drive on the A3000, which Kickstart 3.x's own driver uses.

Drop an `.adf`, `.adz` or `.zip` onto the page to put it in a drive. PAL and NTSC machines are both available.

## Keys and controllers

- **Keyboard:** keys type on the Amiga as labelled. Home and End are the left and right Amiga keys (Cmd stays with the browser), Insert or Page Down is Help, and Ctrl with both Amiga keys resets the Amiga. Pause pauses the emulator.
- **Mouse:** in port 1. Click the screen to capture the mouse; Esc lets it go.
- **Joysticks:** most games use port 2. Choose keys for it under the screen: the numpad, the arrow keys with Space, or W A S D with F. Keys used by a joystick don't type on the Amiga, so set it back to No keys for typing. Port 1 can hold a joystick instead of the mouse.
- **Gamepads:** they work without taking any keys. Choose which gamepad goes in which port.
- **The CD32 pad:** on the CD32, port 2 has its seven-button pad. On a gamepad, A is red, B blue, X green, Y yellow, the shoulder buttons are reverse and forward, and Start is play. With keys, the joystick's fire is red and its second button blue, and Enter is play, Q and E reverse and forward, R green and T yellow.
- **Sound:** the Amiga plays channels 0 and 3 only on the left and channels 1 and 2 only on the right. The Stereo slider blends them: at the Mono end all the sound is in the middle, and at the Amiga end the sides are fully apart, as on the real machine. On headphones, a setting towards Mono is easier on the ears. The power light switches the "LED" low-pass filter, as on the real machine.

## The machine

The toolbar has pause, reset (Ctrl-Amiga-Amiga), power cycle and full screen. **Machine setup...** opens the setup panel over the screen:

- **Kickstart:** the ROM (see below).
- **Model:** the Amiga to be. Choosing the Amiga 1200, 3000 or 4000 switches to its own Kickstart if one came with the ROMs, and loading an A1200, A3000 or A4000 Kickstart chooses that model.

  | Model | Year | Chips | Memory | Kickstart |
  | --- | --- | --- | --- | --- |
  | Amiga 500 | 1987 | OCS | 512K chip, with 512K slow RAM or as 1MB chip | 1.3 (1.2, 2.04 and 3.1 work too) |
  | Amiga 1000 | 1985 | OCS | 256K or 512K chip | 1.0 to 1.3 (an image, rather than the Kickstart disk) |
  | Amiga 2000 | 1987 | OCS, battery clock | 1MB chip, with 2 to 8MB of Zorro II fast RAM | 1.3 (2.04 and 3.1 work too) |
  | Amiga 500 Plus | 1991 | ECS, battery clock | 1MB or 2MB chip | 2.04 |
  | Amiga 600 | 1992 | ECS, IDE | 1MB or 2MB chip | 2.05 (3.1 works too) |
  | Amiga 1200 | 1992 | 68EC020, AGA, IDE | 2MB chip, with 4 or 8MB of trapdoor fast RAM | 3.0 or 3.1 for the A1200 (the A500's 1.3 works too) |
  | Amiga 3000 | 1990 | 68030 and 68882, ECS, SCSI, battery clock | 1MB or 2MB chip, with 4 to 16MB of fast RAM on the main board | 3.1 for the A3000 |
  | Amiga 4000 | 1992 | 68030 and 68882, AGA, IDE, battery clock | 2MB chip, with 4 to 16MB of fast RAM on the main board | 3.0 or 3.1 for the A4000 |
  | Amiga CD32 | 1993 | 68EC020, AGA, Akiko, CD drive | 2MB chip | 3.1 (40.60) for the CD32, with its extended ROM |

- **TV:** PAL (50 Hz) or NTSC (60 Hz).
- **Memory:** the model's choices above. For the A500, 512K chip RAM plus the 512K "slow" RAM of the trapdoor expansion is the most compatible.
- **DF1:** an external second drive.
- **Hard drive:** DH0, with **New hard disk** (20 to 250 MB), **Import .hdf...**, **Export .hdf** and **Delete**.

Nothing changes until **Restart the Amiga with these settings**, which switches it off and on. Save states keep the whole machine, floppy disks included, in the browser, and can be exported and imported as `.amigastate` files. A state only loads with the Kickstart it was saved with. The hard disk's contents aren't part of a save state, so loading an old state doesn't undo what was written to it.

## Hard drive

The drive is an IDE one, as on an A600, A1200 or A4000, or on the A3000 a SCSI one. Kickstart 3.1 (and the A600's 2.05) find it with their own `scsi.device`; 1.3 and 2.04 have no driver for it. The hard disk is kept in the browser (in 1 MB pieces, saving only the ones that changed), and shows under the screen as DH0 with its activity light. **Export .hdf** downloads it in the format WinUAE and FS-UAE use, and their `.hdf` files can be imported if they were partitioned with HDToolBox (an image of a single partition won't mount).

Installing Workbench 3.1 on it:

1. In **Machine setup...**, use Kickstart 3.1 (the A1200's or A4000's on those models), tick **IDE hard drive**, choose a size and press **New hard disk**, then restart.
2. Boot the **Install** disk of Workbench 3.1. Open **HDTools**, then **HDToolBox**. It lists the drive as unknown: choose **Change Drive Type**, **Define New...** and **Read Configuration**, OK your way back, then press **Save Changes to Drive**. The partitions it suggests are fine, or change them in **Partition Drive** first.
3. Restart. The new partitions appear on the Workbench as `DH0:NDOS`; select one, choose **Format Disk...** from the Icons menu, name it (System for DH0) and use **Quick Format**.
4. From the Install disk, run **Install3.1** in the language you want and choose **Install Release 3.1** onto DH0 when it asks. Swap in the disks it asks for with the disk buttons (load all six Workbench disks at once).
5. Take the floppy out and restart: the Amiga boots Workbench from the hard drive.

## ROMs

No Kickstart or game files are included in this repository; the only ROMs in it are the free AROS ones the tests use.

- **Kickstart:** the Amiga's operating system ROM is still under copyright, so the site never serves it. On the first visit the page shows a setup panel in place of the screen, asking for a Kickstart image. Kickstart 1.3 is the A500's own and runs the most games; 1.2, 2.04 and 3.1 for the A500 work too.
  - The panel recognises Commodore's originals by checksum. The A1200's, A3000's and A4000's 3.0 and 3.1 only start on their own models. The CD32 needs its extended ROM too: choose both files together, or a 1 MB file holding the two. It turns away ROMs made for Amigas not emulated yet, the A4000T's, and the A3000's older SuperKickstart ones.
  - It also accepts byte-swapped dumps, overdumps (a 256K ROM repeated twice), dumps of the two ROM chips, and Amiga Forever's encrypted ROMs together with their `rom.key`.
  - A whole ROM collection works too, even one with a zip for each ROM inside a zip. The panel uses the newest Kickstart for the A500 in it (3.1, then 2.05, 2.04, 1.3 and 1.2), or the model's own 3.1 or 3.0 for an Amiga 1200, 3000 or 4000. Its **Use** menu switches to any of the others found, and they're kept for later visits too. Kickstart 1.3 runs the most A500 games.
  - The ROM is kept in the browser's IndexedDB, with persistent storage requested, so later visits start straight away. **Machine setup...** in the toolbar changes or forgets it.
- **AROS:** the free replacement ROMs (AROS Public License) are in `tests/fixtures/aros/`. Only the tests use them; the site never serves them.

## Disks

`.adf` disk images go in as they are. `.adz` (gzipped) and `.zip` work too. Several files dropped or chosen at once, or a zip holding several disks, give each drive a **Swap disk** menu for changing disks during a game; the menu marks the disks that are already in a drive. The first disk by name goes in first, or the Workbench disk of a Workbench set, since a set's first disk is often its installer. Extended ADFs (`UAE-1ADF`) with raw MFM tracks, as copy-protected disks need, also work. DMS and IPF images aren't supported; unpack DMS archives to `.adf` first.

Your disk images are never changed. What games write to a disk is kept in the browser (only the sectors that changed) and put back whenever that image is inserted again. **Revert** forgets it, and **Download .adf** gives you the disk as it is now. **New blank disk** makes an empty disk for games that want a save disk of their own. Format it from the game or from Workbench.

**Fast loading** runs the Amiga flat out while a disk is being read (disk DMA within the last half second, with the motor on), and the sound is skipped meanwhile. Many games leave the motor on once they've loaded, so the motor alone doesn't count.

## Free games

`npm run fetch:games` downloads the freely licensed games listed in `scripts/games-catalog.json` into `public/games/`, where they appear in a "Free games" picker. Each entry has its credit, licence, source and checksum. To offer other games, list them in `public/games/index.json` the same way: `{ "games": [{ "title": "Some Game", "file": "some-game.adf" }] }`.

## Accuracy

Kickstart 1.2, 1.3, 2.04, 3.0, 3.1 and AROS all start, and each model reaches its insert-disk screen with its own Kickstart. AmigaDOS boots from disk, the free games and demos such as Mandarine's System Zoetrope run, Workbench 3.1 starts on the A1200, A3000 and A4000 (with the AGA screen modes on the A1200 and A4000), and on the CD32, games boot from their CDs (Gloom and Banshee, with its CD audio music, were tried).

The chips are run up to the CPU's time whenever it touches the chip bus, and the CPU waits for a cycle the DMA, the Copper and the blitter leave free. Within an instruction, the CPU's internal cycles are counted per instruction; only interrupts, branches and returns place them between the memory accesses as the real CPU does.

`npm run fetch:hw-tests` downloads a sample of the chipset tests from Dirk Hoffmann's vAmigaTS suite, a few from each group (`-- 30` takes thirty). Each test is a disk with a screenshot from vAmiga, a cycle-exact emulator checked against real Amigas (some screenshots were taken with vAmiga's gamma correction on, which the comparison allows for). 45 of the 47 A500 tests in the default sample match vAmiga's picture, and 208 of the 236 in the larger one. The rest are mostly CPU-timed code a cycle or two off, a bitplane pointer written while it is being fetched, and sprites switched in the middle of a line. `-- aga` adds the tests vAmiga runs on an A1200, 69 of whose 77 match: of the rest, four time the 68EC020 against the blitter, and in four (FMODE 2) vAmiga's picture differs from the photo of a real A1200 that comes with the test, which ours matches. They are listed with the reason in `tests/hardware.test.ts`, which expects them to fail, so one that starts matching shows up. `HW_REPORT=1` prints how much of each picture matches, and with `SHOTS=<dir>` saves a picture of ours, vAmiga's and the difference.

Not covered: the 68EC020's and 68030's own instruction timings (they run on the 68000's, at their clock) and their caches, the 68030's address translation and the 68040, ECS's and AGA's productivity modes (super-hires shows every other pixel), the serial and parallel ports, PCMCIA, and DMS and IPF images. Not yet: the FPU's exceptions and full 80-bit precision, and the CD32's CD+G graphics.

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
