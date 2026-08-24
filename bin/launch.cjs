#!/usr/bin/env node
// Launches the Electron app from any working directory. `electron .` on its
// own resolves '.' against the CALLER's cwd, not this package's location —
// this script always spawns it with cwd pinned to the project root (one
// level up from bin/), so `threadline-electron` works the same whether
// you're sitting in this folder or anywhere else.

const { spawn } = require('node:child_process')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
// Requiring the 'electron' package from plain Node (not from inside an
// Electron process) resolves to the path of the electron binary itself.
const electronBin = require('electron')

const child = spawn(electronBin, ['.'], { cwd: projectRoot, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
