const enum ClockReg {
  Seconds1,
  Seconds10,
  Minutes1,
  Minutes10,
  Hours1,
  Hours10,
  Day1,
  Day10,
  Month1,
  Month10,
  Year1,
  Year10,
  Weekday,
  ControlD,
  ControlE,
  ControlF,
}

const CONTROL_F_24_HOURS = 0x4;
const HOURS10_PM = 0x4;

/**
 * The battery-backed clock of the A2000 and A500 Plus, an Oki MSM6242B at $DC0000: sixteen 4-bit
 * registers, one every four bytes (in the low nibble), holding the time as decimal digits. It
 * runs on the host's clock; setting the time keeps the difference from it.
 */
export class RealTimeClock {
  /** Milliseconds the Amiga's clock is ahead of the host's. */
  offsetMs = 0;
  private readonly control = [0, 0, CONTROL_F_24_HOURS];

  constructor(private readonly now: () => number = () => Date.now()) {}

  static handles(address: number): boolean {
    return address >= 0xdc0000 && address < 0xdd0000;
  }

  read(address: number): number {
    const reg = (address >> 2) & 15;
    if (reg >= ClockReg.ControlD) return this.control[reg - ClockReg.ControlD];
    return this.digits()[reg];
  }

  write(address: number, value: number): void {
    const reg = (address >> 2) & 15;
    value &= 0xf;
    if (reg >= ClockReg.ControlD) {
      this.control[reg - ClockReg.ControlD] = value;
      return;
    }
    const digits = this.digits();
    digits[reg] = value;
    this.setFrom(digits);
  }

  private get twentyFourHours(): boolean {
    return (this.control[2] & CONTROL_F_24_HOURS) !== 0;
  }

  /** The time as the registers' digits. */
  private digits(): number[] {
    const time = new Date(this.now() + this.offsetMs);
    let hours = time.getUTCHours();
    let pm = 0;
    if (!this.twentyFourHours) {
      pm = hours >= 12 ? HOURS10_PM : 0;
      hours = hours % 12 || 12;
    }
    const year = time.getUTCFullYear() % 100;
    const month = time.getUTCMonth() + 1;
    const day = time.getUTCDate();
    return [
      time.getUTCSeconds() % 10,
      Math.floor(time.getUTCSeconds() / 10),
      time.getUTCMinutes() % 10,
      Math.floor(time.getUTCMinutes() / 10),
      hours % 10,
      Math.floor(hours / 10) | pm,
      day % 10,
      Math.floor(day / 10),
      month % 10,
      Math.floor(month / 10),
      year % 10,
      Math.floor(year / 10),
      time.getUTCDay(),
    ];
  }

  /** Sets the clock to the time the digits say (years 78-99 are 1978-1999, 00-77 2000-2077). */
  private setFrom(digits: number[]): void {
    const two = (low: number, high: number) => (high & 3) * 10 + low;
    let hours = two(digits[ClockReg.Hours1], digits[ClockReg.Hours10]);
    if (!this.twentyFourHours) {
      hours %= 12;
      if (digits[ClockReg.Hours10] & HOURS10_PM) hours += 12;
    }
    const yy = (digits[ClockReg.Year10] % 10) * 10 + (digits[ClockReg.Year1] % 10);
    const year = yy >= 78 ? 1900 + yy : 2000 + yy;
    const set = Date.UTC(
      year,
      Math.max(0, two(digits[ClockReg.Month1], digits[ClockReg.Month10]) - 1),
      Math.max(1, two(digits[ClockReg.Day1], digits[ClockReg.Day10])),
      hours,
      (digits[ClockReg.Minutes10] % 6) * 10 + (digits[ClockReg.Minutes1] % 10),
      (digits[ClockReg.Seconds10] % 6) * 10 + (digits[ClockReg.Seconds1] % 10),
    );
    if (Number.isFinite(set)) this.offsetMs = set - this.now();
  }
}
