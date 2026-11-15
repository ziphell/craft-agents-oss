/**
 * Tests for the shared "at the bottom" judgement.
 *
 * The sticky-follow behaviour and the return-to-bottom button both read this,
 * so the boundary has to be one answer rather than two.
 */

import { describe, it, expect } from 'bun:test'
import {
  AT_BOTTOM_THRESHOLD,
  distanceFromBottom,
  isScrolledToBottom,
} from '../scroll-position'

const viewport = { scrollHeight: 2000, clientHeight: 800 }

describe('distanceFromBottom', () => {
  it('is zero at the very bottom', () => {
    expect(distanceFromBottom({ ...viewport, scrollTop: 1200 })).toBe(0)
  })

  it('measures the gap when scrolled up', () => {
    expect(distanceFromBottom({ ...viewport, scrollTop: 0 })).toBe(1200)
  })

  it('clamps content shorter than the viewport to zero', () => {
    expect(distanceFromBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 800 })).toBe(0)
  })
})

describe('isScrolledToBottom', () => {
  it('is true at rest at the bottom', () => {
    expect(isScrolledToBottom({ ...viewport, scrollTop: 1200 })).toBe(true)
  })

  it('tolerates sub-pixel shortfall from fractional heights', () => {
    expect(isScrolledToBottom({ scrollHeight: 2000.4, clientHeight: 800, scrollTop: 1199.6 })).toBe(true)
  })

  it('is true exactly at the threshold, false one pixel past it', () => {
    const atThreshold = { ...viewport, scrollTop: 1200 - AT_BOTTOM_THRESHOLD }
    expect(isScrolledToBottom(atThreshold)).toBe(true)
    expect(isScrolledToBottom({ ...atThreshold, scrollTop: atThreshold.scrollTop - 1 })).toBe(false)
  })

  it('is false after scrolling a screen up', () => {
    expect(isScrolledToBottom({ ...viewport, scrollTop: 400 })).toBe(false)
  })

  it('is true for a conversation shorter than the viewport', () => {
    expect(isScrolledToBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 800 })).toBe(true)
  })

  it('honours a caller-supplied threshold', () => {
    const metrics = { ...viewport, scrollTop: 1200 - 100 }
    expect(isScrolledToBottom(metrics)).toBe(false)
    expect(isScrolledToBottom(metrics, 100)).toBe(true)
  })
})
