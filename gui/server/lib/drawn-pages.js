/*
 * drawn-pages.js — the pages the CLI can draw, and which of them the GUI hands over.
 *
 * WHY THIS EXISTS — the page offered `report --html` and nothing else. `history --html` (the knee over
 * time) and `compare a b --html` (the delta) shipped in 1.38.0 and the page could hand over neither,
 * although it already plots the archive and already knows which runs are comparable.
 *
 * The fourth recurrence of one shape: #53 was two flags the CLI had and the page did not, #78 was six
 * summary blocks, #79 was six flags, this was two subcommands. Every one of them was the page tracking
 * the CLI by hand. The two that stopped recurring are the two that got a test — so these tables are
 * exhaustive over what `bin/crowdsim` can draw, and tests/gui/drawn-pages.test.js asks the driver itself.
 *
 * A page is HANDED OVER, never re-rendered here. The CLI writes it and the server sends the bytes: a
 * second renderer is a second opinion about what a run means, and the first time the two disagree the
 * wrong one is in somebody's incident document.
 */

/**
 * What the page offers. `route` is matched against app.js by the test, so a route that is renamed and not
 * updated here fails rather than 404ing for a user.
 */
export const DRAWN_PAGES = [
  {
    subcommand: 'report',
    draws: 'one run',
    route: '/api/history/:runId/report',
    why: 'the run somebody just finished, with the caveats attached to the numbers.',
  },
  {
    subcommand: 'history',
    draws: 'the archive over time',
    route: '/api/history/trend',
    why: 'does the knee move — the only question `history` exists to answer, and the only claim here '
      + 'that survives the caveat about absolutes being optimistic.',
  },
  {
    subcommand: 'compare',
    draws: 'a delta between two runs',
    route: '/api/compare/page',
    why: 'the delta is what a change should be judged on, and it is drawn only when `compare` agrees '
      + 'the two runs are the same experiment.',
  },
];

/**
 * Pages deliberately not offered. Empty today, and kept because "we chose not to" and "nobody noticed"
 * are different states and the tests can only tell them apart if one of them is written down.
 */
export const DELIBERATELY_NOT_OFFERED = [];
