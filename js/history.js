// Undo / redo as a list of whole-scene snapshots. A snapshot is taken after
// each finished change; camera moves don't count because the camera isn't
// part of the snapshot.

export class History {
  // capture() -> { key, ... }: `key` is compared to skip no-op commits.
  // restore(snapshot) puts the app back into that state.
  constructor({ capture, restore, limit = 100 }) {
    this.capture = capture;
    this.restoreFn = restore;
    this.limit = limit;
    this.stack = [];
    this.index = -1;
  }

  commit() {
    const snap = this.capture();
    const current = this.stack[this.index];
    if (current && current.key === snap.key) {
      current.extra = snap.extra; // keep the latest selection for this state
      return false;
    }
    this.stack.splice(this.index + 1);
    this.stack.push(snap);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
    return true;
  }

  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.stack.length - 1; }

  undo() {
    if (!this.canUndo) return false;
    this.index--;
    this.restoreFn(this.stack[this.index]);
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    this.index++;
    this.restoreFn(this.stack[this.index]);
    return true;
  }
}
