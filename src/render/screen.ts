import { FRAME_WIDTH, MAX_FRAME_ROWS } from '../denise/denise';
import type { VideoStandard } from '../agnus/agnus';

/** The width of a hires pixel over the height of an interlaced line on a TV, from the pixel clock and the TV's square-pixel rate. */
const PIXEL_ASPECT: Record<VideoStandard, number> = { pal: 14.75 / 14.1876, ntsc: 12.2727 / 14.3182 };

/** Turns finished frames into canvas pixels: 720 wide, two rows per line. */
export class Screen {
  private readonly context: CanvasRenderingContext2D;
  private image!: ImageData;
  private pixels!: Uint32Array;
  private rows = 0;
  private standard: VideoStandard = 'pal';
  private hasNewFrame = false;
  /** Called with the width / height ratio the canvas should be shown at, whenever it changes. */
  onAspect: (aspect: number) => void = () => {};

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is not available');
    this.context = context;
    this.resize(568);
  }

  get aspect(): number {
    return (FRAME_WIDTH * PIXEL_ASPECT[this.standard]) / this.rows;
  }

  setStandard(standard: VideoStandard): void {
    if (standard === this.standard) return;
    this.standard = standard;
    this.onAspect(this.aspect);
  }

  private resize(rows: number): void {
    if (this.image && rows === this.rows) return;
    this.rows = Math.min(rows, MAX_FRAME_ROWS);
    this.canvas.width = FRAME_WIDTH;
    this.canvas.height = this.rows;
    this.image = this.context.createImageData(FRAME_WIDTH, this.rows);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.hasNewFrame = true;
    this.onAspect(this.aspect);
  }

  /** Copies a finished frame. */
  capture(framebuffer: Uint32Array, rows: number): void {
    this.resize(rows);
    this.pixels.set(framebuffer.subarray(0, FRAME_WIDTH * this.rows));
    this.hasNewFrame = true;
  }

  /** A dark screen with a faint scanline pattern, shown while the Amiga is off. */
  showIdle(): void {
    const { pixels } = this;
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i / FRAME_WIDTH) & 2 ? 0xff141414 : 0xff1c1c1c;
    this.hasNewFrame = true;
  }

  present(): void {
    if (!this.hasNewFrame) return;
    this.context.putImageData(this.image, 0, 0);
    this.hasNewFrame = false;
  }
}
