import type { RingBuffer } from "./types";

export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  const items: T[] = [];

  return {
    push(item: T): void {
      if (items.length >= capacity) {
        items.shift();
      }
      items.push(item);
    },

    toArray(): T[] {
      return [...items];
    },

    get size(): number {
      return items.length;
    },

    get capacity(): number {
      return capacity;
    },

    clear(): void {
      items.length = 0;
    },
  };
}
