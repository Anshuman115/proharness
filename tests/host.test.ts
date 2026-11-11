import { describe, expect, it } from 'vitest'
import { shq } from '../src/main/host/host'
import { parseSshConfigHosts } from '../src/main/host/ssh'

describe('shq', () => {
  it('quotes arguments containing spaces', () => {
    expect(shq('a b')).toBe("'a b'")
    expect(shq('/Users/me/My Projects')).toBe("'/Users/me/My Projects'")
  })

  it('escapes single quotes', () => {
    expect(shq("it's")).toBe("'it'\\''s'")
  })

  it('quotes the empty string', () => {
    expect(shq('')).toBe("''")
  })

  it('leaves safe tokens unquoted', () => {
    expect(shq('/usr/local/bin/omp')).toBe('/usr/local/bin/omp')
    expect(shq('user@host:/srv/app')).toBe('user@host:/srv/app')
  })
})

describe('parseSshConfigHosts', () => {
  it('reads every alias from Host lines and skips wildcards', () => {
    const config = [
      'Host devbox',
      '  HostName 203.0.113.10',
      '',
      'Host build-*.internal !jump ?single',
      '  User ci',
      '',
      'host alpha beta',
      '  Port 2222'
    ].join('\n')
    expect(parseSshConfigHosts(config)).toEqual(['devbox', 'alpha', 'beta'])
  })

  it('returns no hosts for an empty config', () => {
    expect(parseSshConfigHosts('')).toEqual([])
  })

  it('ignores Match and comments', () => {
    const config = '# Host commented-out\nMatch host example.com\n  User me\n'
    expect(parseSshConfigHosts(config)).toEqual([])
  })
})
