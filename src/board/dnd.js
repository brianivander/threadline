// The in-flight drag payload for the board's tree rows and case tabs.
//
// This is a module singleton rather than React state on purpose: the HTML5
// drag & drop spec blocks `dataTransfer.getData()` during `dragover`, so a
// drop target cannot read what is being dragged while deciding whether to
// accept it. Every implementation needs a side channel; this is it.
//
// Drop indicators are NOT tracked here — they are ordinary local state in the
// component that renders the row or tab.

let dragState = null

/** Record that a drag started. `state`: { nodeType, nodeId } */
export function setDrag(state) {
  dragState = state
}

/** The in-flight drag, or null. */
export function getDrag() {
  return dragState
}

/** Clear the drag (dragend / drop). */
export function clearDrag() {
  dragState = null
}
