#!/usr/bin/env node
/*
 * Electron 45 ships its downloader as a bin instead of a postinstall hook.
 * Run it explicitly so `pnpm install` leaves behind a runnable desktop app.
 */
const { existsSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const electronDir = path.dirname(require.resolve('electron/package.json', { paths: [root] }))
const marker = path.join(electronDir, 'path.txt')

if (existsSync(marker)) {
  process.exit(0)
}

const cache = process.env.electron_config_cache || path.join(root, '.cache', 'electron')

try {
  console.log('[proharness] downloading Electron runtime…')
  execFileSync(process.execPath, [path.join(electronDir, 'install.js')], {
    stdio: 'inherit',
    env: { ...process.env, electron_config_cache: cache }
  })
} catch (error) {
  console.warn('[proharness] Electron download failed:', error.message)
  console.warn('[proharness] Run `node node_modules/electron/install.js` manually before `pnpm dev`.')
}
