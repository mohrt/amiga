import type { ChipRam } from '../memory/chip-ram';

/** Below this period the hardware can't fetch fast enough anyway; it keeps a stray tiny period from stalling the emulator. */
const MIN_PERIOD = 16;
/** The A500's fixed output filter, about 4.4 kHz, and the switchable "LED" filter, about 3.3 kHz. */
const FIXED_FILTER_HZ = 4400;
const LED_FILTER_HZ = 3300;
/** Largest a channel's output gets: a full-scale sample at volume 64. */
const CHANNEL_FULL_SCALE = 128 * 64;

class Channel {
  lc = 0;
  len = 0;
  per = 0;
  vol = 0;
  dat = 0;
  dmaOn = false;
  /** Playing a word (from DMA or written by the CPU). */
  playing = false;
  ptr = 0;
  remaining = 0;
  word = 0;
  /** 0 for the high byte, 1 for the low. */
  byte = 0;
  counter = 0;
  /** A word the CPU wrote while the channel was busy, played next. */
  pending = false;
  output = 0;
  /** This channel modulates the next one's volume (bit 0) or period (bit 1) instead of being heard. */
  modulates = 0;
  /** Which modulation word comes next when it does both (0 volume, 1 period). */
  modulationPhase = 0;
}

/** A biquad low-pass, the second-order Butterworth of the LED filter. */
class LowPass2 {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;

  configure(cutoff: number, rate: number): void {
    const w = Math.tan((Math.PI * cutoff) / rate);
    const q = Math.SQRT1_2;
    const norm = 1 / (1 + w / q + w * w);
    this.b0 = w * w * norm;
    this.b1 = 2 * this.b0;
    this.b2 = this.b0;
    this.a1 = 2 * (w * w - 1) * norm;
    this.a2 = (1 - w / q + w * w) * norm;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * Paula's four sound channels: each plays 8-bit samples from chip RAM by DMA
 * (or words the CPU writes), at its period and volume, raising its interrupt
 * at the start of each block; a channel can modulate the next one's volume
 * or period instead. Channels 0 and 3 are on the left, 1 and 2 on the right.
 * The output goes through the A500's filters and is resampled for the speakers.
 */
export class PaulaAudio {
  readonly channels = [new Channel(), new Channel(), new Channel(), new Channel()];
  /** The power LED's filter (CIA-A's LED line low). */
  ledFilter = false;
  /** How far apart the left and right channels are, from 0 (mono) to 1 (the Amiga's hard stereo). */
  separation = 0.7;

  private cckRate = 3546895;
  private sampleRate = 48000;
  private phase = 0;
  private sumLeft = 0;
  private sumRight = 0;
  private count = 0;
  private fixedLeft = 0;
  private fixedRight = 0;
  private fixedAlpha = 0;
  private readonly ledLeft = new LowPass2();
  private readonly ledRight = new LowPass2();
  private buffer = new Float32Array(8192);
  private length = 0;

  constructor(
    private readonly chip: ChipRam,
    /** Raises a channel's interrupt (AUD0-AUD3). */
    private readonly raise: (channel: number) => void,
    private readonly dmaEnabled: (channel: number) => boolean,
  ) {
    this.setRates(this.cckRate, this.sampleRate);
  }

  setRates(cckRate: number, sampleRate: number): void {
    this.cckRate = cckRate;
    this.sampleRate = sampleRate;
    this.fixedAlpha = 1 - Math.exp((-2 * Math.PI * FIXED_FILTER_HZ) / sampleRate);
    this.ledLeft.configure(LED_FILTER_HZ, sampleRate);
    this.ledRight.configure(LED_FILTER_HZ, sampleRate);
  }

  reset(): void {
    for (const channel of this.channels) {
      Object.assign(channel, new Channel());
    }
  }

  writeRegister(index: number, offset: number, value: number): void {
    const channel = this.channels[index];
    switch (offset) {
      case 0x0:
        channel.lc = ((value << 16) | (channel.lc & 0xffff)) & 0x1ffffe;
        break;
      case 0x2:
        channel.lc = ((channel.lc & 0xffff0000) | value) & 0x1ffffe;
        break;
      case 0x4:
        channel.len = value;
        break;
      case 0x6:
        channel.per = value;
        break;
      case 0x8:
        channel.vol = Math.min(64, value & 0x7f);
        break;
      case 0xa:
        channel.dat = value;
        if (!channel.dmaOn) {
          if (channel.playing) channel.pending = true;
          else this.startWord(index, value);
        }
        break;
    }
  }

  /** ADKCON's modulation bits: channel n modulates channel n+1's volume (bit n) or period (bit n+4). */
  setModulation(adkcon: number): void {
    for (let n = 0; n < 3; n++) this.channels[n].modulates = ((adkcon >> n) & 1) | (((adkcon >> (n + 4)) & 1) << 1);
  }

  /** DMACON changed: channels whose DMA was switched on start their block, those switched off stop. */
  updateDma(): void {
    this.channels.forEach((channel, n) => {
      const on = this.dmaEnabled(n);
      if (on === channel.dmaOn) return;
      channel.dmaOn = on;
      if (on) {
        channel.ptr = channel.lc;
        channel.remaining = channel.len || 0x10000;
        this.raise(n);
        this.startWord(n, this.fetch(n));
      } else {
        channel.playing = false;
        channel.output = 0;
      }
    });
  }

  private fetch(n: number): number {
    const channel = this.channels[n];
    const word = this.chip.read16(channel.ptr);
    channel.ptr = (channel.ptr + 2) & 0x1ffffe;
    if (--channel.remaining <= 0) {
      channel.ptr = channel.lc;
      channel.remaining = channel.len || 0x10000;
      this.raise(n);
    }
    return word;
  }

  private startWord(n: number, word: number): void {
    const channel = this.channels[n];
    channel.word = word;
    channel.byte = 0;
    channel.playing = true;
    channel.counter = Math.max(MIN_PERIOD, channel.per);
    if (channel.modulates) this.modulate(n, word);
    else channel.output = ((word >> 8) << 24 >> 24) * channel.vol;
  }

  private modulate(n: number, word: number): void {
    const channel = this.channels[n];
    const target = this.channels[n + 1];
    channel.output = 0;
    const kind = channel.modulates === 3 ? channel.modulationPhase : channel.modulates - 1;
    channel.modulationPhase ^= 1;
    if (kind === 0) target.vol = Math.min(64, word & 0x7f);
    else target.per = word;
    // A modulating channel spends one period on each word.
    channel.byte = 1;
  }

  /** One colour clock. */
  tick(): void {
    const channels = this.channels;
    for (let n = 0; n < 4; n++) {
      const channel = channels[n];
      if (!channel.playing || --channel.counter > 0) continue;
      channel.counter = Math.max(MIN_PERIOD, channel.per);
      if (channel.byte === 0) {
        channel.byte = 1;
        channel.output = ((channel.word << 24) >> 24) * channel.vol;
        continue;
      }
      // The word is done: on to the next one.
      if (channel.dmaOn) {
        this.startWord(n, this.fetch(n));
      } else if (channel.pending) {
        channel.pending = false;
        this.raise(n);
        this.startWord(n, channel.dat);
      } else {
        channel.playing = false;
        this.raise(n);
      }
    }
    this.sumLeft += channels[0].output + channels[3].output;
    this.sumRight += channels[1].output + channels[2].output;
    this.count++;
    this.phase += this.sampleRate;
    if (this.phase >= this.cckRate) {
      this.phase -= this.cckRate;
      this.emit();
    }
  }

  private emit(): void {
    const scale = 1 / (this.count * CHANNEL_FULL_SCALE * 2);
    let left = this.sumLeft * scale;
    let right = this.sumRight * scale;
    this.sumLeft = this.sumRight = this.count = 0;
    this.fixedLeft += (left - this.fixedLeft) * this.fixedAlpha;
    this.fixedRight += (right - this.fixedRight) * this.fixedAlpha;
    left = this.fixedLeft;
    right = this.fixedRight;
    if (this.ledFilter) {
      left = this.ledLeft.process(left);
      right = this.ledRight.process(right);
    } else {
      this.ledLeft.process(left);
      this.ledRight.process(right);
    }
    const mix = (1 - this.separation) / 2;
    if (this.length + 2 > this.buffer.length) {
      const bigger = new Float32Array(this.buffer.length * 2);
      bigger.set(this.buffer);
      this.buffer = bigger;
    }
    this.buffer[this.length++] = left * (1 - mix) + right * mix;
    this.buffer[this.length++] = right * (1 - mix) + left * mix;
  }

  /** The samples made since the last call (interleaved left and right). */
  takeSamples(): Float32Array {
    const samples = this.buffer.slice(0, this.length);
    this.length = 0;
    return samples;
  }
}
