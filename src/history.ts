/** A reversible mutation. Commands own exactly the memory they need to swap state back and forth. */
export interface HistoryCommand {
  label: string;
  /** Approximate retained memory, used for the history budget. */
  bytes: number;
  undo(): void;
  redo(): void;
}

export interface HistoryOptions { frames: number; bytes: number }

export class History {
  private undoStack: HistoryCommand[] = [];
  private redoStack: HistoryCommand[] = [];
  private retained = 0;
  constructor(public options: HistoryOptions = { frames: 100, bytes: 256 * 1024 * 1024 }) {}

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get size() { return this.undoStack.length; }
  get bytes() { return this.retained; }

  push(command: HistoryCommand) {
    for (const dropped of this.redoStack) this.retained -= dropped.bytes;
    this.redoStack = [];
    this.undoStack.push(command); this.retained += command.bytes;
    this.trim();
  }
  configure(options: Partial<HistoryOptions>) { Object.assign(this.options, options); this.trim(); }
  /** Oldest frames are dropped first; the newest frame is always kept so the last edit can be undone. */
  private trim() {
    while (this.undoStack.length > Math.max(0, this.options.frames) ||
      (this.retained > this.options.bytes && this.undoStack.length > 1)) {
      const dropped = this.undoStack.shift();
      if (!dropped) break;
      this.retained -= dropped.bytes;
    }
  }
  undo() { const command = this.undoStack.pop(); if (!command) return undefined; command.undo(); this.redoStack.push(command); return command; }
  redo() { const command = this.redoStack.pop(); if (!command) return undefined; command.redo(); this.undoStack.push(command); return command; }
  clear() { this.undoStack = []; this.redoStack = []; this.retained = 0; }
}

export function compound(label: string, commands: HistoryCommand[]): HistoryCommand {
  return {
    label, bytes: commands.reduce((sum, command) => sum + command.bytes, 0),
    undo() { for (let i = commands.length - 1; i >= 0; i--) commands[i].undo(); },
    redo() { for (const command of commands) command.redo(); }
  };
}
