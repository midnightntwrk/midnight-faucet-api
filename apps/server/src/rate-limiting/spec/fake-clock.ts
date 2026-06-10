import { Clock } from "../rate-limiting.js";

export class FakeClock implements Clock {
  constructor(public currentTime: Date) {}

  moveByMs(amount: number) {
    this.currentTime = new Date(this.currentTime.getTime() + amount);
  }

  now() {
    return this.currentTime;
  }
}
