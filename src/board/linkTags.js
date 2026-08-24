// Link-tag colours. A link's stored `color` is a palette KEY ("purple"), never a
// literal — the fill and ink for each key live in index.css as --tag-<key> and
// --tag-<key>-ink. They are the same in both themes: the set includes white and
// black, so these are absolute colours rather than theme-adaptive ones. An unset
// or unrecognised key renders untinted, which is what a new link starts at.
//
// Three neutrals first, then the nine hues in ascending order, which is also the
// order they appear in the picker grid.

export const TAG_COLORS = [
  'white',
  'grey',
  'black',
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'light-blue',
  'dark-blue',
  'purple',
  'pink',
]

const KEYS = new Set(TAG_COLORS)

// "light-blue" → "light blue", for the swatch's tooltip and accessible name.
export function tagColorLabel(color) {
  return color.replace('-', ' ')
}

// The border is the fill nudged toward its own ink — enough of an edge that a
// white chip is still visible on a white surface, without a second variable.
function border(color) {
  return `color-mix(in oklab, var(--tag-${color}) 78%, var(--tag-${color}-ink))`
}

export function tagStyle(color) {
  if (!KEYS.has(color)) return undefined
  return {
    color: `var(--tag-${color}-ink)`,
    backgroundColor: `var(--tag-${color})`,
    borderColor: border(color),
  }
}

// A solid circle of the fill, for the swatches in the picker.
export function swatchStyle(color) {
  if (!KEYS.has(color)) return undefined
  return {
    backgroundColor: `var(--tag-${color})`,
    borderColor: border(color),
  }
}
