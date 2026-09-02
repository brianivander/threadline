// Link-tag colours. A link's stored `color` is a palette KEY ("purple"), never a
// literal — the fill and ink for each key live in index.css as --tag-<key> and
// --tag-<key>-ink. They are the same in both themes, deliberately: a badge is a
// colour the user picked by name, and a named colour that shifts under you when
// the theme flips is a worse colour. An unset or unrecognised key renders
// untinted, which is what a new link starts at.
//
// Every fill in the set is LIGHT, and that is load-bearing rather than
// incidental. It means one dark ink reads on all nine, and — the part that
// matters — one dark link-blue reads on all nine too, so a hyperlink inside a
// badge needs no per-key exception (see the --link-on-tag note in index.css).
// White, black and dark-blue are gone for exactly that reason: white was
// invisible on the page, and the two dark fills each needed light ink and would
// have needed a light link-blue to go with it.
//
// Grey first, then the eight hues in ascending order, which is also the order
// they appear in the picker grid.

export const TAG_COLORS = [
  'grey',
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'light-blue',
  'purple',
  'pink',
]

const KEYS = new Set(TAG_COLORS)

// "light-blue" → "light blue", for the swatch's tooltip and accessible name.
export function tagColorLabel(color) {
  return color.replace('-', ' ')
}

// The border is the fill nudged toward its own ink — enough of an edge that a
// pale chip is still visible on a pale surface, without a second variable.
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
