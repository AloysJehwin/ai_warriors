import { EventEmitter } from "node:events";
import type { StreamEvent } from "../domain/types.js";

export class Bus {
  private ee = new EventEmitter();
  private seq = 0;
  constructor() {
    this.ee.setMaxListeners(200);
  }
  emit(e: StreamEvent): void {
    this.seq += 1;
    this.ee.emit("event", this.seq, e);
  }
  on(fn: (id: number, e: StreamEvent) => void): () => void {
    this.ee.on("event", fn);
    return () => this.ee.off("event", fn);
  }
}
