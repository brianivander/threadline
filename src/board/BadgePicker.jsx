// The toolbar control for inline badges: one button that opens the same
// swatches the link chips use, so a badge in the body and a chip in the params
// row are visibly the same vocabulary of colour.
//
// Nine colours and an explicit "none", in two rows of five. The none swatch is
// strictly a discoverability fix rather than new capability: re-clicking a
// badge's current colour has always removed it (see toggleBadge), but nothing
// on screen said so, so the only way to take a badge off was to guess. It
// leads the grid rather than trailing it because "no colour" is where you
// start, and because a control that removes something is easier to find at the
// origin than tucked after nine lookalike circles.
//
// Lives inside the MDXEditor toolbar, which renders inside the realm, so the
// active editor and the live selection are read straight off the realm's cells
// rather than being threaded down as props.

import { useMemo } from 'react'
import { Ban, Tag } from 'lucide-react'
import { activeEditor$, currentSelection$, useCellValues } from '@mdxeditor/editor'

import { cn } from '@/lib/utils'
import { TAG_COLORS, swatchStyle, tagColorLabel, tagStyle } from '@/board/linkTags'
import { badgeColorAtSelection, toggleBadge } from '@/board/badgeMarks'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export function BadgePicker() {
  // currentSelection$ is not read for its value — it's the signal that the
  // caret moved, which is when the active colour can have changed.
  const [editor, selection] = useCellValues(activeEditor$, currentSelection$)

  const active = useMemo(
    () => badgeColorAtSelection(editor),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, selection],
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Badge colour"
          title="Badge colour"
          data-state={active ? 'on' : 'off'}
          className={cn(
            'hover:bg-accent flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-transparent',
            !active && 'text-muted-foreground hover:text-foreground',
          )}
          // The Lexical selection survives the editor losing DOM focus, but the
          // visible highlight does not — and a colour picker the user can't see
          // their selection through is a worse picker. Keeping focus in the
          // editor keeps the selection painted.
          onMouseDown={(e) => e.preventDefault()}
          // The active colour rides on the button itself, so the current badge
          // is legible without opening the grid.
          style={active ? tagStyle(active) : undefined}
        >
          <Tag className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="grid w-max grid-cols-5 gap-1 p-1.5"
        aria-label="Badge colour"
      >
        {/* Remove. Disabled with no badge under the caret, so the control is
            never a no-op the user has to interpret. */}
        <button
          type="button"
          aria-label="No badge"
          aria-pressed={!active}
          title="No badge"
          disabled={!active}
          className={cn(
            'text-muted-foreground flex size-4 items-center justify-center rounded-full border',
            active ? 'hover:text-foreground cursor-pointer' : 'opacity-40',
          )}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toggleBadge(editor, '')}
        >
          <Ban className="size-3" />
        </button>
        {TAG_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={tagColorLabel(color)}
            aria-pressed={active === color}
            title={tagColorLabel(color)}
            className={cn(
              'size-4 cursor-pointer rounded-full border',
              active === color && 'ring-ring ring-2 ring-offset-1',
            )}
            style={swatchStyle(color)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleBadge(editor, color)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
