// The MDXEditor plugin set shared by every markdown surface in the app: the
// case editor (CaseEditor.jsx) and a standalone .md file opened as a browser
// tab (MarkdownTab.jsx). One list, so a plugin added for one surface can't
// silently go missing from the other, and both toolbars stay identical.
//
// Anything specific to a single surface — the case editor's comment marks —
// is passed in as `extra` rather than added here. It sits after the shortcut
// plugin and before the toolbar, which is where commentMarksPlugin was
// declared when this list was one inline array.
//
// The options are per-surface for the same reason. `images`: storing a pasted
// image needs to know WHICH document is being edited, since the file goes next
// to that document's repo. A surface that can't answer that passes nothing,
// and then pasting an image is simply not offered — no upload handler means
// MDXEditor leaves an image paste to the browser, and no Insert Image button
// appears in the toolbar. `onOpenLink`: where a link goes when it's clicked is
// the host's decision (a story resolves relative paths against its own
// folder), so a surface that has no answer gets the browser's own behaviour
// for http URLs and nothing for a local path. See LinkPopover.jsx.

import {
  codeBlockPlugin,
  codeMirrorPlugin,
  headingsPlugin,
  imagePlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CodeToggle,
  CreateLink,
  InsertCodeBlock,
  InsertImage,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  Separator as MdxSeparator,
  UndoRedo,
} from '@mdxeditor/editor'

import { codeMirrorTheme } from '@/board/codeMirrorTheme'
import { badgeMarksPlugin } from '@/board/badgeMarksPlugin'
import { blankLinesPlugin } from '@/board/blankLinesPlugin'
import { imageSizePlugin } from '@/board/imageSizePlugin'
import { BadgePicker } from '@/board/BadgePicker'
import { LinkPopover } from '@/board/LinkPopover'

export function markdownPlugins(extra = [], { images = null, onOpenLink = null } = {}) {
  return [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    thematicBreakPlugin(),
    linkPlugin(),
    // The app's own popover in place of the stock dialog, so a local file link
    // opens in the doc panel rather than a new OS window, and so every link
    // gets the same right-arrow to go there. onClickLinkCallback is the realm
    // cell LinkPopover reads that from.
    linkDialogPlugin({ LinkDialog: LinkPopover, onClickLinkCallback: onOpenLink }),
    tablePlugin(),
    // Paste, drop and the toolbar button all funnel through imageUploadHandler;
    // imagePreviewHandler turns the relative link that gets STORED into
    // something an <img> on an http page can load. See useImageAssets.js.
    ...(images
      ? [imagePlugin({ imageUploadHandler: images.upload, imagePreviewHandler: images.preview })]
      : []),
    // Unconditional, unlike imagePlugin: an image can be resized in any
    // document that already contains one, whether or not this surface can
    // accept a new paste — and a resize that can't be undone is the bug it
    // exists to fix. See imageSize.js.
    imageSizePlugin(),
    // Unconditional for the same reason as imageSizePlugin: markdown cannot
    // hold a blank line, and a body that loses its spacing on reload does so
    // whichever surface opened it. See blankLines.js.
    blankLinesPlugin(),
    // Unconditional as well, and for the third time the same reason: an empty
    // badge is undeletable wherever it is opened, and the ones already saved
    // into a story file are cleaned on the way in. See badges.js.
    badgeMarksPlugin(),
    codeBlockPlugin({ defaultCodeBlockLanguage: 'text' }),
    codeMirrorPlugin({
      codeBlockLanguages: { text: 'Text', js: 'JavaScript', java: 'Java', json: 'JSON' },
      // Overrides the light-only theme MDXEditor bundles — see codeMirrorTheme.js.
      codeMirrorExtensions: codeMirrorTheme,
    }),
    markdownShortcutPlugin(),
    ...extra,
    toolbarPlugin({
      toolbarContents: () => (
        <>
          {/* Grouped history / block / inline / list / insert, one
              separator per group boundary. */}
          <UndoRedo />
          <MdxSeparator />
          <BlockTypeSelect />
          <MdxSeparator />
          <BoldItalicUnderlineToggles />
          <CodeToggle />
          {/* A badge is an inline format like the ones beside it — a
              background colour on a run of text — so it belongs in this
              group rather than with the insert buttons. It stacks with a
              link instead of replacing one; see badges.js. */}
          <BadgePicker />
          <MdxSeparator />
          <ListsToggle />
          <MdxSeparator />
          <CreateLink />
          <InsertCodeBlock />
          {images ? <InsertImage /> : null}
          <InsertTable />
          <InsertThematicBreak />
        </>
      ),
    }),
  ]
}
