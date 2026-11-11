import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const config = readFileSync(join(import.meta.dirname, '..', 'electron-builder.yml'), 'utf8')
const mac = config.split(/^mac:\s*$/m)[1]?.split(/^\S/m)[0] ?? ''

describe('macOS packaging config', () => {
  it('opts in to ad-hoc signing instead of skipping signing', () => {
    // null skips signing and leaves the Electron linker signature on a changed bundle,
    // which makes `codesign --verify --deep --strict` fail.
    expect(mac).toMatch(/^\s+identity:\s*["']-["']\s*(?:#.*)?$/m)
  })
})
