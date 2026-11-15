import { describe, expect, it } from 'bun:test'
import { describeMediaFailure } from '../media-error'

const t = (key: string) => key

describe('what a media failure tells the person', () => {
  it('turns a missing key into a settings trip', () => {
    const notice = describeMediaFailure(
      { code: 'missing_credentials', message: '生成失败：没有密钥' },
      t,
    )
    expect(notice.text).toBe('mediaError.missingCredentials')
    expect(notice.settings).toBe(true)
  })

  it('keeps the provider sentence when it is more specific', () => {
    const detail = '「MiniMax」的 MiniMax-H3 不支持duration「7」。可选：4 / 5 / 6。'
    const notice = describeMediaFailure(
      { code: 'invalid_request', field: 'duration', message: detail },
      t,
    )
    expect(notice.text).toBe(detail)
    expect(notice.settings).toBeUndefined()
  })

  it('localises a network failure instead of repeating the transport error', () => {
    const notice = describeMediaFailure({ code: 'network', message: 'fetch failed' }, t)
    expect(notice.text).toBe('mediaError.network')
  })

  it('falls back to a generic sentence for an unclassified failure', () => {
    expect(describeMediaFailure({ message: '' }, t).text).toBe('mediaError.generic')
    expect(describeMediaFailure({ uncertain: true }, t).text).toBe('mediaError.uncertain')
  })
})
