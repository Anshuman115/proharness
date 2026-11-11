#!/usr/bin/env node
const { chmodSync, copyFileSync, existsSync, mkdirSync } = require('node:fs')
const path = require('node:path')
// electron-builder's Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4.
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return
  const arch = ARCH_NAMES[context.arch] || String(context.arch)
  if (arch !== 'x64') {
    console.warn(`[proharness] only the Linux x64 Claude binary is staged; skipping ${arch}.`)
    return
  }
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
