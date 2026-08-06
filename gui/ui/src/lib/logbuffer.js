/*
 * Batching the live log. (#32)
 *
 * The log used to be `{log.join('\n')}` re-evaluated on every appended line. Measured over the 4000 lines
 * the server keeps: 760 MB of strings built and 215 ms of pure join time, before React reconciles a 371 KB
 * text node — once per line. Joining once is 0 ms.
 *
 * That cost lands on the machine generating the load, which is the machine whose spare capacity the whole
 * measurement depends on. A page that competes with the generator is a page that changes the number.
 *
 * So lines accumulate here and are published in batches. Two details that are not incidental:
 *  · a reconnect brings a full replay from the server, which must REPLACE the log rather than double it;
 *  · when the buffer bounds itself it says how many lines it dropped and where the whole log lives — the
 *    same honesty the server applies at 4000.
 */

const DEFAULT_MAX = 4000;   // what the server keeps; keeping more here would be keeping what nobody has

export class LineBuffer {
  constructor(opts) {
    const o = opts || {};
    this.max = o.max || DEFAULT_MAX;
    this.lines = [];
    this.queued = [];
    this.dropped = 0;
    this.replaced = false;
  }

  push(line) {
    this.queued.push(line);
  }

  /** A full replay: what the server has, which is the whole truth for this run. */
  snapshot(lines) {
    this.lines = [];
    this.queued = (lines || []).slice();
    this.replaced = true;
  }

  pending() {
    return this.queued.length;
  }

  /**
   * Publish what has accumulated. Returns the lines to render — the whole list, so the caller can render a
   * tail without keeping its own copy — or an empty array when there is nothing new, which the caller uses
   * to skip a render entirely.
   */
  flush() {
    if (!this.queued.length) return [];
    this.lines = this.lines.concat(this.queued);
    this.queued = [];
    if (this.lines.length > this.max) {
      const cut = this.lines.length - this.max;
      // The server's own truncation notice is kept: dropping it while truncating again would hide the
      // fact twice.
      const notice = this.lines.slice(0, cut).find((l) => l.includes('log truncated'));
      this.lines = this.lines.slice(cut);
      if (notice) this.lines.unshift(notice);
      this.dropped += cut;
    }
    return this.lines;
  }

  /** What to show above the log when this buffer has dropped lines of its own. */
  note() {
    if (!this.dropped) return null;
    return `… ${this.dropped} earlier lines are not shown here. The full log of this run is in the driver's `
      + 'own file, under out/.';
  }
}
