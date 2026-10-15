// A tiny event emitter. `on` gives back a function that removes the listener.
export class Emitter {
  constructor() {
    this.map = new Map();
  }
  on(name, fn) {
    if (!this.map.has(name)) this.map.set(name, new Set());
    this.map.get(name).add(fn);
    return () => this.map.get(name)?.delete(fn);
  }
  emit(name, ...args) {
    for (const fn of [...(this.map.get(name) || [])]) {
      try {
        fn(...args);
      } catch (e) {
        console.error(`[jlb-ide] a "${name}" listener failed:`, e);
      }
    }
  }
}
