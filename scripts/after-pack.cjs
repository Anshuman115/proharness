#!/usr/bin/env node
const { chmodSync, copyFileSync, existsSync, mkdirSync } = require('node:fs')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return
  const source = path.join(context.packager.projectDir, '.cache', 'linux-sdk', 'claude')
  if (!existsSync(source)) {
    console.warn('[proharness] Linux Claude Code binary is not staged; the app will need an explicit executable path.')
    return
  }
  const resources = path.join(context.appOutDir, 'resources')
  mkdirSync(resources, { recursive: true })
  const destination = path.join(resources, 'claude')
  copyFileSync(source, destination)
  chmodSync(destination, 0o755)
  console.log('[proharness] bundled Linux Claude Code binary:', destination)
}
