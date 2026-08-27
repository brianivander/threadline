// The MDXEditor plugin set shared by every markdown surface in the app: the
// case editor (CaseEditor.jsx) and a standalone .md file opened as a browser
// tab (MarkdownTab.jsx). One list, so a plugin added for one surface can't
// silently go missing from the other, and both toolbars stay identical.
//
// Anything specific to a single surface — the case editor's comment marks —
// is passed in as `extra` rather than added here. It sits after the shortcut
// plugin and before the toolbar, which is where commentMarksPlugin was
// declared when this list was one inline array.

import {
  codeBlockPlugin,
  codeMirrorPlugin,
  headingsPlugin,
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
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  Separator as MdxSeparator,
  UndoRedo,
} from '@mdxeditor/editor'

import { codeMirrorTheme } from '@/board/codeMirrorTheme'

export function markdownPlugins(extra = []) {
  return [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    thematicBreakPlugin(),
    linkPlugin(),
    linkDialogPlugin(),
    tablePlugin(),
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
          <InsertTable />
          <InsertThematicBreak />
        </>
      ),
    }),
  ]
}
