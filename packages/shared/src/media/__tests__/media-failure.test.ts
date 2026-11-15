import { describe, expect, it } from 'bun:test'
import { MediaFailure } from '../index.ts'

describe('a media failure says what to do about it', () => {
  it('keeps the layer label and the detail', () => {
    const failure = new MediaFailure('generate', '没有可用模型')
    expect(failure.message).toBe('生成失败：没有可用模型')
    expect(failure.layer).toBe('generate')
    expect(failure.detail).toBe('没有可用模型')
    expect(failure.code).toBeUndefined()
    expect(failure.retryable).toBe(false)
    expect(failure.uncertain).toBe(false)
  })

  it('carries a code, a field and a retry hint when the caller knows them', () => {
    const failure = new MediaFailure('upload', '上传超时', {
      code: 'network',
      field: 'reference',
      retryable: true,
      cause: new Error('ETIMEDOUT'),
    })
    expect(failure.code).toBe('network')
    expect(failure.field).toBe('reference')
    expect(failure.retryable).toBe(true)
    expect(failure.cause).toBeInstanceOf(Error)
  })

  it('can say that the provider may already be working', () => {
    const failure = new MediaFailure('generate', '提交结果未知', { uncertain: true })
    expect(failure.uncertain).toBe(true)
  })
})
