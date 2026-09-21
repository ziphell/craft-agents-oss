import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type {
  LoadedWebsite,
  WebsiteActionDescriptor,
  WebsiteActionRequest,
  WebsiteActionResult,
  WebsiteDataSnapshot,
  WebsiteKind,
  WebsiteRenderLease,
} from '@craft-agent/shared/websites/types'
import { isWebsiteGrantUsable } from '@craft-agent/shared/websites/types'
import {
  WebsiteActionRateLimiter,
  buildWebsiteActionResultMessage,
  buildWebsiteDataMessage,
  buildWebsiteGrantsMessage,
  buildWebsiteInitMessage,
  descriptorEquals,
  grantIdsEqual,
  isMutatingInvocation,
  isSafeExternalUrl,
  parseWebsiteBridgeMessage,
  reconcileGrantSummaries,
  toGrantSummary,
  type WebsiteBridgeIncoming,
  type WebsiteGrantRequestEntry,
  type WebsiteGrantSummary,
} from '../../../shared/website-bridge'
import { WebsiteGrantRequestDialog } from './WebsiteGrantRequestDialog'

/**
 * The dedicated sandboxed Website renderer + trusted bridge host.
 *
 * Security posture (per the Websites design, §7):
 * - `sandbox`: static websites get the empty set (no scripts at all);
 *   interactive/live get exactly `allow-scripts allow-forms`.
 *   NEVER `allow-same-origin` — scripts + same-origin would let website JS reach
 *   this document and the electronAPI adapter. The frame's origin is opaque.
 * - The srcDoc content is rendered EXACTLY as returned by `websites:createLease`
 *   (the lease is bound to that content's digest); nothing is injected.
 *   The lease nonce travels via postMessage `init` after load, and the website
 *   echoes it on every privileged request.
 * - Every incoming message must come from this frame's contentWindow with an
 *   opaque origin and parse against the strict schema in shared/website-bridge.
 * - Mutating actions (api non-GET) additionally require fresh user activation,
 *   which real clicks inside the frame propagate to this window.
 * - Grant requests never mint anything by themselves: the approval dialog in
 *   THIS window is the user consent, and `websites:issueGrant` binds the grant to
 *   the current content digest server-side. Denied descriptors are remembered
 *   per render so a website cannot re-prompt in a loop.
 * - Per-frame budget: bounded in-flight actions and a 30/minute window. The
 *   server-side WebsiteActionBroker independently re-validates lease, nonce,
 *   replay, grant, and timeout — this component is the first gate, not the
 *   only one.
 */

interface WebsiteFrameProps {
  workspaceId: string
  website: LoadedWebsite
  lease: WebsiteRenderLease
  /** Exact content string returned with the lease (digest-bound) */
  content: string
  /**
   * Data snapshot handed to the website in `init`. Live websites also receive
   * replacement snapshots via `data` messages when this prop changes.
   */
  snapshot: WebsiteDataSnapshot | null
  className?: string
}

function sandboxForKind(kind: WebsiteKind): string {
  return kind === 'static' ? '' : 'allow-scripts allow-forms'
}

/** Transient user activation, propagated from clicks inside the frame. */
function hasUserActivation(): boolean {
  const nav = navigator as Navigator & { userActivation?: { isActive?: boolean } }
  return nav.userActivation?.isActive === true
}

/** Stable identity for deny-memory and dedupe. */
function descriptorSignature(d: WebsiteActionDescriptor): string {
  if (d.kind === 'mcp') return `mcp:${d.sourceSlug}:${d.toolName}`
  if (d.kind === 'script') return `script:${d.script}:${d.runtime ?? 'bun'}:${(d.args ?? []).join('\u0000')}`
  return `api:${d.sourceSlug}:${d.method}:${d.pathPattern}`
}

export function WebsiteFrame({ workspaceId, website, lease, content, snapshot, className }: WebsiteFrameProps) {
  const { t } = useTranslation()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const snapshotRef = useRef(snapshot)
  const limiterRef = useRef<WebsiteActionRateLimiter | null>(null)
  if (!limiterRef.current) limiterRef.current = new WebsiteActionRateLimiter()

  const websiteSlug = website.config.slug
  const kind = website.config.kind

  // ------------------------------------------------------------------
  // Grants (usable = bound to the rendered digest and not expired).
  // Seeded from config at mount; grows via in-dialog approvals and via
  // config updates (e.g. grants issued from another surface).
  // ------------------------------------------------------------------
  const usableConfigGrants = useCallback((): WebsiteGrantSummary[] => {
    const now = Date.now()
    return (website.config.grants ?? [])
      .filter(g => isWebsiteGrantUsable(g, lease.contentDigest, now))
      .map(toGrantSummary)
  }, [website.config.grants, lease.contentDigest])

  const [grants, setGrants] = useState<WebsiteGrantSummary[]>(usableConfigGrants)
  const grantsRef = useRef(grants)
  grantsRef.current = grants

  const [pendingRequest, setPendingRequest] = useState<WebsiteGrantRequestEntry[] | null>(null)
  const [issueBusy, setIssueBusy] = useState(false)
  const deniedRef = useRef<Set<string>>(new Set())
  /** Approvals from this render the config watcher hasn't confirmed yet. */
  const locallyIssuedRef = useRef<Set<string>>(new Set())

  const postToFrame = useCallback((message: Record<string, unknown>) => {
    // '*' is required: an opaque-origin frame cannot be addressed by origin.
    // The payload never contains credentials, and only THIS frame's window
    // object receives it.
    iframeRef.current?.contentWindow?.postMessage(message, '*')
  }, [])

  const postInit = useCallback(() => {
    postToFrame(
      buildWebsiteInitMessage({ slug: websiteSlug, kind }, lease.nonce, snapshotRef.current, grantsRef.current),
    )
  }, [postToFrame, websiteSlug, kind, lease.nonce])

  const postGrants = useCallback(
    (next: WebsiteGrantSummary[]) => {
      setGrants(next)
      grantsRef.current = next
      postToFrame(buildWebsiteGrantsMessage(next))
    },
    [postToFrame],
  )

  // Reconcile against the config (the source of truth): grants issued from
  // other surfaces appear, revoked grants disappear — so website buttons disable
  // live. In-dialog approvals the watcher hasn't confirmed yet are kept via
  // locallyIssuedRef (reconcileGrantSummaries releases them on confirmation).
  useEffect(() => {
    const next = reconcileGrantSummaries(grantsRef.current, usableConfigGrants(), locallyIssuedRef.current)
    if (!grantIdsEqual(next, grantsRef.current)) {
      postGrants(next)
    }
  }, [usableConfigGrants, postGrants])

  // Live websites get replacement snapshots; interactive websites keep their
  // init-time snapshot (per the kind contract).
  useEffect(() => {
    const changed = snapshotRef.current !== snapshot
    snapshotRef.current = snapshot
    if (changed && kind === 'live') {
      postToFrame(buildWebsiteDataMessage(snapshot))
    }
  }, [snapshot, kind, postToFrame])

  const handleAction = useCallback(
    async (msg: Extract<WebsiteBridgeIncoming, { type: 'action' }>) => {
      const limiter = limiterRef.current!
      const reject = (error: string) =>
        postToFrame(
          buildWebsiteActionResultMessage({ requestId: msg.requestId, ok: false, error, durationMs: 0 }),
        )

      if (msg.nonce !== lease.nonce) {
        reject('nonce-mismatch: request nonce does not match the render lease')
        return
      }
      const mutating = isMutatingInvocation(msg.invocation)
      if (mutating && !hasUserActivation()) {
        reject('user-activation-required: mutating actions need a fresh user gesture')
        return
      }
      const limited = limiter.canStart(Date.now(), mutating)
      if (limited) {
        reject(`${limited}: too many website actions in flight`)
        return
      }

      limiter.start(msg.requestId, Date.now(), mutating)
      try {
        const request: WebsiteActionRequest = {
          requestId: msg.requestId,
          websiteSlug,
          leaseId: lease.leaseId,
          nonce: msg.nonce,
          grantId: msg.grantId,
          invocation: msg.invocation,
        }
        const result: WebsiteActionResult = await window.electronAPI.executeWebsiteAction(workspaceId, request)
        postToFrame(buildWebsiteActionResultMessage(result))
      } catch (err) {
        reject(err instanceof Error ? err.message : 'Action failed')
      } finally {
        limiter.finish(msg.requestId)
      }
    },
    [workspaceId, websiteSlug, lease.leaseId, lease.nonce, postToFrame],
  )

  const handleGrantRequest = useCallback(
    (msg: Extract<WebsiteBridgeIncoming, { type: 'grant-request' }>) => {
      if (msg.nonce !== lease.nonce) return
      const current = grantsRef.current
      const remaining = msg.requests.filter(
        req =>
          !current.some(g => descriptorEquals(g.action, req.action)) &&
          !deniedRef.current.has(descriptorSignature(req.action)),
      )
      // Nothing new to ask (all satisfied or already denied this render), or a
      // dialog is already up: answer with the current state instead of stacking
      // prompts — the website reconciles by descriptor.
      if (remaining.length === 0 || pendingRequest !== null) {
        postToFrame(buildWebsiteGrantsMessage(current))
        return
      }
      setPendingRequest(remaining)
    },
    [lease.nonce, pendingRequest, postToFrame],
  )

  const handleApprove = useCallback(async () => {
    if (!pendingRequest) return
    setIssueBusy(true)
    const issued: WebsiteGrantSummary[] = []
    let failed = false
    for (const entry of pendingRequest) {
      try {
        const grant = await window.electronAPI.issueWebsiteGrant(workspaceId, websiteSlug, {
          action: entry.action,
          ...(entry.description !== undefined ? { description: entry.description } : {}),
        })
        issued.push(toGrantSummary(grant))
        locallyIssuedRef.current.add(grant.id)
      } catch (err) {
        failed = true
        toast.error(t('toast.websiteGrantFailed'), {
          description: err instanceof Error ? err.message : String(err),
        })
        break
      }
    }
    if (issued.length > 0 && !failed) {
      toast.success(t('toast.websiteGrantsIssued'))
    }
    postGrants([...grantsRef.current, ...issued])
    setPendingRequest(null)
    setIssueBusy(false)
  }, [pendingRequest, workspaceId, websiteSlug, postGrants, t])

  const handleDeny = useCallback(() => {
    if (pendingRequest) {
      for (const entry of pendingRequest) {
        deniedRef.current.add(descriptorSignature(entry.action))
      }
    }
    setPendingRequest(null)
    postGrants(grantsRef.current)
  }, [pendingRequest, postGrants])

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow
      if (!frameWindow || event.source !== frameWindow) return
      // No allow-same-origin → the frame's origin is opaque, serialized 'null'.
      if (event.origin !== 'null') return
      const msg = parseWebsiteBridgeMessage(event.data)
      if (!msg) return

      switch (msg.type) {
        case 'ready':
          postInit()
          break
        case 'action':
          void handleAction(msg)
          break
        case 'action-cancel':
          if (msg.nonce === lease.nonce) {
            void window.electronAPI.cancelWebsiteAction(workspaceId, msg.requestId)
          }
          break
        case 'open-url':
          // Only real link-outs: correct nonce, http(s), and a live user gesture.
          if (msg.nonce === lease.nonce && isSafeExternalUrl(msg.url) && hasUserActivation()) {
            void window.electronAPI.openUrl(msg.url)
          }
          break
        case 'grant-request':
          handleGrantRequest(msg)
          break
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [handleAction, handleGrantRequest, postInit, lease.nonce, workspaceId])

  // Abort anything still in flight when the render goes away; the lease
  // release (WebsiteView) invalidates the rest server-side.
  useEffect(() => {
    const limiter = limiterRef.current!
    return () => {
      for (const requestId of limiter.inFlightIds) {
        void window.electronAPI.cancelWebsiteAction(workspaceId, requestId)
      }
    }
  }, [workspaceId])

  return (
    <>
      <iframe
        ref={iframeRef}
        title={website.config.name}
        sandbox={sandboxForKind(kind)}
        referrerPolicy="no-referrer"
        srcDoc={content}
        onLoad={postInit}
        className={className ?? 'h-full w-full border-0 bg-white'}
      />
      <WebsiteGrantRequestDialog
        websiteName={website.config.name}
        requests={pendingRequest}
        busy={issueBusy}
        onApprove={handleApprove}
        onDeny={handleDeny}
      />
    </>
  )
}
