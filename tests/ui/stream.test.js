/*
 * Losing the live log, and the cost of drawing it. (#31, #32)
 *
 * The page exists so somebody can watch load being generated against a real system. Two ways it failed at
 * that quietly, both found by the audit:
 *
 *  · the event stream closed on the first error and said nothing, so a server that went away looked exactly
 *    like a run that had gone quiet — while a generator may still have been running;
 *  · the log was re-joined on every appended line: 760 MB of strings and 215 ms of join time over the 4000
 *    lines the server keeps, spent on the same machine that is generating the load.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { streamState, describeStream } from '../../gui/ui/src/lib/stream.js';
import { LineBuffer } from '../../gui/ui/src/lib/logbuffer.js';

// ── #31: the page must say when it has lost the stream ───────────────────────────────────────────────
test('a healthy stream says nothing: silence is for when there is nothing to report', () => {
  const s = streamState({ phase: 'open', attempts: 0 });
  assert.equal(s.tone, 'quiet');
  assert.equal(describeStream(s), null);
});

test('a dropped connection is visible immediately, and names what is unknown', () => {
  const s = streamState({ phase: 'retrying', attempts: 1 });
  assert.equal(s.tone, 'warn');
  const text = describeStream(s);
  assert.match(text, /lost the live log/i);
  assert.match(text, /reconnecting/i);
  // The distinction the whole issue is about.
  assert.match(text, /whether the run is still going is not known from here/i);
});

test('after enough failed attempts it stops claiming a reconnection is imminent', () => {
  const s = streamState({ phase: 'retrying', attempts: 9 });
  assert.equal(s.tone, 'bad');
  assert.match(describeStream(s), /server is not answering/i);
  assert.match(describeStream(s), /out\//, 'the archive is where the truth is');
});

test('a stream that ended because the run ended is not an error', () => {
  const s = streamState({ phase: 'ended', attempts: 0 });
  assert.equal(s.tone, 'quiet');
  assert.equal(describeStream(s), null);
});

test('reconnecting must not be reported as a run still running', () => {
  // The pill said "running" while the page had no idea. The state of the RUN and the state of the
  // CONNECTION are two different things, and only one of them is known after a drop.
  assert.equal(streamState({ phase: 'retrying', attempts: 1 }).runStateKnown, false);
  assert.equal(streamState({ phase: 'open', attempts: 0 }).runStateKnown, true);
  assert.equal(streamState({ phase: 'ended', attempts: 0 }).runStateKnown, true);
});

// ── #32: appending a line must cost the same at line 4000 as at line 10 ──────────────────────────────
test('lines are batched, so a fast run does not re-render per line', () => {
  const buf = new LineBuffer();
  for (let i = 0; i < 50; i++) buf.push(`line ${i}`);
  assert.equal(buf.pending(), 50, 'nothing is published until a flush');
  const flushed = buf.flush();
  assert.equal(flushed.length, 50);
  assert.equal(buf.pending(), 0);
  assert.equal(buf.flush().length, 0, 'a flush with nothing pending is not a render');
});

test('a reconnect replaces the log rather than appending the replay to it', () => {
  // The server replays everything it has when a client connects. Appending that after a reconnect would
  // show every line twice and make the tail meaningless.
  const buf = new LineBuffer();
  buf.push('a'); buf.push('b'); buf.flush();
  buf.snapshot(['a', 'b', 'c']);
  assert.deepEqual(buf.flush(), ['a', 'b', 'c']);
  assert.equal(buf.replaced, true, 'the consumer must know to replace, not concatenate');
});

test('the buffer bounds itself the way the server does, and says it dropped lines', () => {
  const buf = new LineBuffer({ max: 100 });
  for (let i = 0; i < 250; i++) buf.push(`line ${i}`);
  const out = buf.flush();
  assert.equal(out.length, 100);
  assert.equal(out[out.length - 1], 'line 249', 'the tail is what matters while a run is in flight');
  assert.ok(buf.dropped > 0);
  assert.match(buf.note(), /150 earlier lines/);
  assert.match(buf.note(), /out\//, 'and where the whole log is');
});

test('a bounded buffer keeps the truncation notice the server already emits', () => {
  // The server pushes its own "… log truncated" line at 4000. Dropping it in the client's own truncation
  // would hide that twice over.
  const buf = new LineBuffer({ max: 3 });
  buf.push('… log truncated: this run produced more output than the GUI keeps in memory.');
  buf.push('a'); buf.push('b'); buf.push('c');
  const out = buf.flush();
  assert.ok(out.some((l) => l.includes('log truncated')), out);
});
