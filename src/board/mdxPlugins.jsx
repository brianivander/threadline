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
// `images` is the one option, and it is per-surface for a reason: storing a
// pasted image needs to know WHICH document is being edited, since the file
// goes next to that document's repo. A surface that can't answer that passes
// nothing, and then pasting an image is simply not offered — no upload
// handler means MDXEditor leaves an image paste to the browser, and no
// Insert Image button appears in the toolbar.

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
import { imageSizePlugin } from '@/board/imageSizePlugin'

export function markdownPlugins(extra = [], { images = null } = {}) {
  return [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    thematicBreakPlugin(),
    linkPlugin(),
    linkDialogPlugin(),
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
