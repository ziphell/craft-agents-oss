/**
 * Turn a media failure into something a person can act on.
 *
 * The server already sends a precise sentence; what a code adds is the *next step*. A missing key
 * is not a generation failure — it is a settings visit, so the toast offers one. Everything else
 * keeps the provider's own sentence, because it is more specific than any generic label.
 */

import type { MediaFailureCode } from '@craft-agent/shared/media/types'

type Translate = (key: string, options?: Record<string, unknown>) => string

export interface MediaFailureLike {
  message?: string
  code?: MediaFailureCode
  field?: string
  retryable?: boolean
  uncertain?: boolean
}

export interface MediaFailureNotice {
  text: string
  /** The fix lives in settings, so the caller can offer a "go to settings" action. */
  settings?: boolean
}

export function describeMediaFailure(
  failure: MediaFailureLike,
  t: Translate,
): MediaFailureNotice {
  const detail = failure.message?.trim()
  switch (failure.code) {
    case 'missing_credentials':
      return { text: t('mediaError.missingCredentials'), settings: true }
    case 'missing_model':
      return { text: t('mediaError.missingModel'), settings: true }
    case 'network':
    case 'timeout':
      return { text: t('mediaError.network') }
    case 'rate_limited':
      return { text: t('mediaError.rateLimited') }
    case 'invalid_request':
      return { text: detail || t('mediaError.invalidRequest') }
    case 'upload_failed':
      return { text: detail || t('mediaError.uploadFailed') }
    case 'provider_rejected':
      return { text: detail || t('mediaError.providerRejected') }
    case 'unsupported':
      return { text: detail || t('mediaError.unsupported') }
    default:
      if (failure.uncertain) return { text: detail || t('mediaError.uncertain') }
      return { text: detail || t('mediaError.generic') }
  }
}
