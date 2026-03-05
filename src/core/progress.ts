// ---------------------------------------------------------------------------
// Progress reporting for CLI output
// ---------------------------------------------------------------------------

/**
 * Interface for reporting scan progress.
 * Implementations control how progress messages are displayed.
 *
 * - `update()` writes an in-place update (overwritten by the next update)
 * - `complete()` finalises a phase with a new line
 * - `warn()` writes a warning on its own line
 */
export interface ProgressReporter {
  /** In-place update for an active phase (overwritten on next call) */
  update(phase: string, message: string): void;
  /** Finalise a phase — writes a permanent line */
  complete(phase: string, message: string): void;
  /** Warning — always writes a permanent line */
  warn(phase: string, message: string): void;
}

/**
 * Writes progress to a writable stream (default: stderr).
 *
 * - In TTY mode: uses carriage returns for in-place updates.
 * - In non-TTY mode: only writes completed phases and warnings (no flickering).
 */
export class ScanProgressReporter implements ProgressReporter {
  private isTTY: boolean;
  private lastLineLength = 0;

  constructor(private stream: NodeJS.WriteStream = process.stderr) {
    this.isTTY = stream.isTTY ?? false;
  }

  update(phase: string, message: string): void {
    const line = `[${phase}] ${message}`;
    if (this.isTTY) {
      this.clearLine();
      this.stream.write(line);
      this.lastLineLength = line.length;
    }
    // Non-TTY: skip transient updates — only completions are written
  }

  complete(phase: string, message: string): void {
    const line = `[${phase}] ${message}`;
    if (this.isTTY) {
      this.clearLine();
    }
    this.stream.write(line + "\n");
    this.lastLineLength = 0;
  }

  warn(phase: string, message: string): void {
    const line = `[${phase}] ${message}`;
    if (this.isTTY) {
      this.clearLine();
    }
    this.stream.write(line + "\n");
    this.lastLineLength = 0;
  }

  private clearLine(): void {
    if (this.lastLineLength > 0) {
      this.stream.write("\r" + " ".repeat(this.lastLineLength) + "\r");
      this.lastLineLength = 0;
    }
  }
}

/**
 * No-op reporter — used when `--quiet` flag is active.
 */
export class QuietProgressReporter implements ProgressReporter {
  update(): void { /* noop */ }
  complete(): void { /* noop */ }
  warn(): void { /* noop */ }
}
