/**
 * Who started the program that runs on the board (D-17). Closing the Run tab stops a program only when the Run command started
 * it; the bridge state alone cannot tell, because a program that was already running at connect (a `main.py`) looks the same.
 *
 * The Run command brackets each `run` call with `begin()` and `end()`. The window is exactly the time the bridge executes our
 * program, so it does not cover the question "A program may already be running. Stop it and run?" (that program is not ours).
 */
export class RunTracker {
  private owned = false;
  private stopClaimed = false;

  /** A `run` call is about to be sent. */
  begin(): void {
    this.owned = true;
    this.stopClaimed = false;
  }

  /** The `run` call settled (finished, failed or was stopped). Always call it, also after an error. */
  end(): void {
    this.owned = false;
    this.stopClaimed = false;
  }

  /** True while a program that Run started may be running. */
  get active(): boolean {
    return this.owned;
  }

  /** True the first time it is asked for the current run, false afterwards: one close sends one Stop, however often it is closed. */
  claimStop(): boolean {
    if (!this.owned || this.stopClaimed) {
      return false;
    }
    this.stopClaimed = true;
    return true;
  }
}
