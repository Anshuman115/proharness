#!/usr/bin/env node
/*
 * Cross-build helper: stage the Linux Claude Code binary for electron-builder.
 * On Linux, pnpm normally installs the matching optional SDK package itself.
 * On macOS this script downloads the same npm artifact explicitly.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const stage = join(root, '.cache', 'linux-sdk')
const target = join(stage, 'claude')
const tarPath = join(stage, 'package.tgz')

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

if (process.platform === 'darwin' || process.platform === 'linux') {
  const sdkDir = join(root, 'node_modules/@anthropic-ai/claude-agent-sdk')
  const manifest = JSON.parse(readFileSync(join(sdkDir, 'manifest.json'), 'utf8'))
  const expected = manifest.platforms?.['linux-x64']?.checksum
  if (!expected) throw new Error('The SDK manifest has no linux-x64 checksum.')

  if (existsSync(target)) {
    if (sha256(target) === expected) {
      console.log('[proharness] Linux Claude Code binary already staged:', target)
      process.exit(0)
    }
    console.warn('[proharness] staged binary does not match the SDK manifest; downloading again.')
    rmSync(target, { force: true })
  }

  const sdkPackage = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8'))
  const version = sdkPackage.optionalDependencies?.['@anthropic-ai/claude-agent-sdk-linux-x64']
  if (!version) throw new Error('Could not determine the Linux SDK binary version.')

  const registry = process.env.npm_config_registry || 'https://registry.npmjs.org'
  const meta = await fetch(`${registry}/@anthropic-ai%2Fclaude-agent-sdk-linux-x64/${version}`).then((res) => {
    if (!res.ok) throw new Error(`Registry lookup failed: ${res.status}`)
    return res.json()
  })
  const tarball = meta.dist?.tarball
  if (!tarball) throw new Error('Registry did not return a tarball URL.')

  mkdirSync(stage, { recursive: true })
  console.log(`[proharness] downloading Linux Claude Code ${version}…`)
  const response = await fetch(tarball)
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tarPath))

  const extract = join(stage, 'extract')
  rmSync(extract, { recursive: true, force: true })
  mkdirSync(extract, { recursive: true })
  execFileSync('tar', ['-xzf', tarPath, '-C', extract, '--strip-components=1'], { stdio: 'inherit' })
  const candidate = join(extract, 'claude')
  if (!existsSync(candidate)) throw new Error('The Linux SDK tarball did not contain a claude binary.')
  const actual = sha256(candidate)
  if (actual !== expected) {
    rmSync(extract, { recursive: true, force: true })
    throw new Error(`Checksum mismatch for the Linux Claude binary (expected ${expected}, got ${actual}).`)
  }
  execFileSync('cp', [candidate, target])
  execFileSync('chmod', ['+x', target])
  rmSync(extract, { recursive: true, force: true })
  rmSync(tarPath, { force: true })
  writeFileSync(join(stage, 'version.txt'), version)
  console.log('[proharness] staged Linux Claude Code binary:', target)
} else {
  console.log('[proharness] Not staging the Linux binary on this host.')
}
