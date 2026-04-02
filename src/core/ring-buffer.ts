/**
 * Ring buffer for storing recent output lines.
 */
export class RingBuffer {
  private buffer: string[];
  private writeIndex = 0;
  private count = 0;

  constructor(public readonly capacity: number = 1000) {
    this.buffer = new Array(capacity);
  }

  push(line: string): void {
    this.buffer[this.writeIndex] = line;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  getLines(n?: number): string[] {
    const total = n === undefined ? this.count : Math.min(n, this.count);
    const result: string[] = new Array(total);
    const start = (this.writeIndex - total + this.capacity) % this.capacity;
    for (let i = 0; i < total; i++) {
      result[i] = this.buffer[(start + i) % this.capacity];
    }
    return result;
  }

  clear(): void {
    this.writeIndex = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }
}
