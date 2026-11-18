// Section heights for the scrolling sidebar. Pure, so node can test it
// (tests/ella-sidebar.test.mjs).

export const GRIP = 16; // the draggable strip under each section, also the gap
export const MIN = 80; // an open section never gets shorter than this

// How tall a section draws: its header when folded, else its remembered height.
export function heightOf(section, folded, heights) {
  if (folded[section.id]) return section.folded;
  return Math.max(MIN, Math.round(heights[section.id] ?? section.open));
}

// The height while dragging: start height plus how far the pointer moved, in
// layout px (pointer positions come in zoomed px).
export function dragTo(drag, y, zoom = 1) {
  return Math.max(MIN, Math.round(drag.h0 + (y - drag.y0) / (zoom || 1)));
}
