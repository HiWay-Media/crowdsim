/*
 * drawn.js — whether the page offers a drawn page, and what it says when it does not.
 *
 * The trend and the delta are produced by the CLI and handed through (#90), so nothing about what they
 * MEAN is decided here. What is decided here is whether to offer them at all, and that decision can be
 * wrong in the direction this whole tool refuses: presenting a picture of something that is not there.
 *
 *  · a trend through one run is a straight line through one point — the knee's own refusal, one level up;
 *  · a delta `compare` has refused must not be offered as a drawing, or the page invites somebody to read
 *    two different experiments off one pair of axes.
 *
 * Both return a reason rather than just hiding a button: a control that vanishes teaches nothing, and the
 * reason is the same one the command line gives.
 */

/** The archive, drawn over time. `rows` are history records as the API returns them. */
export function trendOffer(rows) {
  const runs = Array.isArray(rows) ? rows : [];
  if (runs.length >= 2) return { offered: true, reason: null };
  if (runs.length === 1) {
    return {
      offered: false,
      reason: 'A trend needs more than one run: through a single point it is a straight line, which is '
        + 'the same reason a knee is refused from one completed step.',
    };
  }
  return {
    offered: false,
    reason: 'There are no runs in this archive yet, so there is nothing to draw over time.',
  };
}

/**
 * The delta between two runs, drawn. `result` is what `crowdsim compare --json` returned through the API.
 *
 * A refusal there is the whole answer, so it is also the answer here: the server would refuse the drawing
 * too (422), and a button that leads to a refusal is a button that wastes somebody's attention at the
 * moment they are deciding something.
 */
export function deltaOffer(result) {
  const r = result || {};
  const refused = Array.isArray(r.refused) ? r.refused : null;
  if (!refused) {
    return {
      offered: false,
      reason: 'Pick two runs to compare, and the delta can be drawn once `compare` agrees they are the '
        + 'same experiment.',
    };
  }
  if (refused.length) {
    return {
      offered: false,
      reason: 'These two runs were refused by `crowdsim compare`, so there is no delta to draw: the '
        + 'reasons above are the answer, and two different experiments on one pair of axes would not be.',
    };
  }
  return { offered: true, reason: null };
}
