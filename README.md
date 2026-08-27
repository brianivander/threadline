# Threadline

A visual board for organizing project context — stories, comments, and code threads — with an Electron shell that keeps a real authenticated session for embedded panels.

## Features

- **Board view** — drag-and-drop stories, code, and notes on an infinite canvas
- **Threadline panel** — hierarchical thread view for structured context
- **Comments** — inline comments with CodeMirror-powered rich text
- **Pasted images** — paste or drop a screenshot straight into an editor; it's written to `.threadline/img` in the repo that owns the document and linked relatively, so it travels with a clone and renders on GitHub too. Images a document no longer shows are removed when it's saved
- **Workspace sync** — git-backed persistence, story files (`*.s.md`) live in your repo alongside your other markdown
- **Electron shell** — embedded browser panels with real authenticated sessions (Figma, Google Docs, etc.)

## Tech Stack

- **Frontend:** React 18 + Vite, Tailwind CSS, shadcn/ui components
- **Desktop:** Electron 32, electron-builder
- **Editor:** MDX Editor (Lexical), CodeMirror
- **Storage:** sql.js (SQLite in-browser), git-backed workspace sync

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

### Install

```bash
git clone https://github.com/brianivander/threadline.git
cd threadline
npm install
```

### Development

```bash
npm run dev
```

Opens the Vite dev server at [localhost:5173](http://localhost:5173).

### Electron

```bash
npm start
```

Launches the Electron desktop app.

### Build

```bash
# Windows
npm run build:win

# macOS
npm run build:mac
```

### Test

```bash
npm test
```

## Project Structure

```
threadline/
├── electron/          # Electron main process & preload
├── packages/
│   ├── core/          # Core library (story files, repo utils)
│   └── vite-plugin/   # Vite plugin for Threadline API routes
├── src/
│   ├── board/         # Board canvas, panels, DnD, comments
│   ├── components/    # UI components (shadcn/ui)
│   └── lib/           # Utilities
├── bin/               # CLI entry point
├── index.html
├── vite.config.js
└── package.json
```

## License

[MIT](LICENSE)
