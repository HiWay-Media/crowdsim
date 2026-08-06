/*
 * Keyboard activation. (#33)
 *
 * The History rows and the knee-plot points carried `onClick` and nothing else — no tabindex, no role, no
 * key handler — so choosing a run to read was mouse-only, while the comparison checkboxes beside them were
 * focusable. Half a panel reachable from the keyboard is worse than either whole answer: it looks usable
 * until the moment it is not.
 *
 * This is a console people open next to a terminal, often mid-typing, sometimes over a share on a call.
 */

/**
 * Does this key press mean "activate the thing that has focus"?
 *
 * Enter and Space, the two a native button responds to. A modified press is the browser being asked to do
 * something else — open in a new tab, scroll — and taking it would steal that.
 */
export function activatesOn(event) {
  if (!event) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar';
}
