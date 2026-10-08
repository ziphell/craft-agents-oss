import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type {
  LoadedDesign,
  DesignActionDescriptor,
  DesignActionRequest,
  DesignActionResult,
  DesignDataSnapshot,
  DesignRenderLease,
} from '@craft-agent/shared/designs/types'
import { isDesignGrantUsable } from '@craft-agent/shared/designs/types'
import { DESIGN_FRAME_SANDBOX } from '@craft-agent/shared/designs/sandbox'
import {
  DesignActionRateLimiter,
  buildDesignActionResultMessage,
  buildDesignDataMessage,
  buildDesignGrantsMessage,
  buildDesignInitMessage,
  descriptorEquals,
  grantIdsEqual,
  isMutatingInvocation,
  isSafeExternalUrl,
  parseDesignBridgeMessage,
  reconcileGrantSummaries,
  toGrantSummary,
  type DesignBridgeIncoming,
  type DesignGrantRequestEntry,
  type DesignGrantSummary,
} from '../../../shared/design-bridge'
import { DesignGrantRequestDialog } from './DesignGrantRequestDialog'

/**
 * The dedicated sandboxed Design renderer + trusted bridge host.
 *
 * Security posture (per the Designs design, §7):
 * - `sandbox`: exactly `allow-scripts allow-forms` for every design (see
 *   @craft-agent/shared/designs/sandbox for why there is no scripts-off class).
 *   NEVER `allow-same-origin` — scripts + same-origin would let design JS reach
 *   this document and the electronAPI adapter. The frame's origin is opaque.
 * - The srcDoc content is rendered EXACTLY as returned by `designs:createLease`
 *   (the lease is bound to that content's digest); nothing is injected.
 *   The lease nonce travels via postMessage `init` after load, and the design
 *   echoes it on every privileged request.
 * - Every incoming message must come from this frame's contentWindow with an
 *   opaque origin and parse against the strict schema in shared/design-bridge.
 * - Mutating actions (api non-GET) additionally require fresh user activation,
 *   which real clicks inside the frame propagate to this window.
 * - Grant requests never mint anything by themselves: the approval dialog in
 *   THIS window is the user consent, and `designs:issueGrant` binds the grant to
 *   the current content digest server-side. Denied descriptors are remembered
 *   per render so a design cannot re-prompt in a loop.
 * - Per-frame budget: bounded in-flight actions and a 30/minute window. The
 *   server-side DesignActionBroker independently re-validates lease, nonce,
 *   replay, grant, and timeout — this component is the first gate, not the
 *   only one.
 */

interface DesignFrameProps {
  workspaceId: string
  design: LoadedDesign
  lease: DesignRenderLease
  /** Exact content string returned with the lease (digest-bound) */
  content: string
  /**
   * The design folder's own address, when the host serves it (see
   * design-preview-host). Loading from the address is what makes a design a
   * folder rather than one inlined file, and what makes its fragment real —
   * measured: on this address an anchor navigates and a reload keeps the
   * fragment, while a `srcDoc` document refuses both.
   */
  previewUrl?: string
  /**
   * Data snapshot handed to the design in `init`. Live designs also receive
   * replacement snapshots via `data` messages when this prop changes.
   */
  snapshot: DesignDataSnapshot | null
  /**
   * A deck reporting its slide count + position over the bridge (type `deck`).
   * Display state only — the host shows a counter; it never drives navigation,
   * which belongs to the deck's own runtime (see docs/designs.md).
   */
  onDeckStateChange?: (state: { slides: number; current: number }) => void
  className?: string
}

/** Transient user activation, propagated from clicks inside the frame. */
function hasUserActivation(): boolean {
  const nav = navigator as Navigator & { userActivation?: { isActive?: boolean } }
  return nav.userActivation?.isActive === true
}

/** Stable identity for deny-memory and dedupe. */
function descriptorSignature(d: DesignActionDescriptor): string {
  if (d.kind === 'mcp') return `mcp:${d.sourceSlug}:${d.toolName}`
  if (d.kind === 'script') return `script:${d.script}:${d.runtime ?? 'bun'}:${(d.args ?? []).join('\u0000')}`
  return `api:${d.sourceSlug}:${d.method}:${d.pathPattern}`
}

export function DesignFrame({ workspaceId, design, lease, content, previewUrl, snapshot, onDeckStateChange, className }: DesignFrameProps) {
  const { t } = useTranslation()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const snapshotRef = useRef(snapshot)
  // Through a ref so the message listener never re-registers on a caller that
  // does not memoize the callback.
  const onDeckStateRef = useRef(onDeckStateChange)
  useEffect(() => { onDeckStateRef.current = onDeckStateChange })
  const limiterRef = useRef<DesignActionRateLimiter | null>(null)
  if (!limiterRef.current) limiterRef.current = new DesignActionRateLimiter()

  const designSlug = design.config.slug

  // ------------------------------------------------------------------
  // Grants (usable = bound to the rendered digest and not expired).
  // Seeded from config at mount; grows via in-dialog approvals and via
  // config updates (e.g. grants issued from another surface).
  // ------------------------------------------------------------------
  const usableConfigGrants = useCallback((): DesignGrantSummary[] => {
    const now = Date.now()
    return (design.config.grants ?? [])
      .filter(g => isDesignGrantUsable(g, lease.contentDigest, now))
      .map(toGrantSummary)
  }, [design.config.grants, lease.contentDigest])

  const [grants, setGrants] = useState<DesignGrantSummary[]>(usableConfigGrants)
  const grantsRef = useRef(grants)
  grantsRef.current = grants

  const [pendingRequest, setPendingRequest] = useState<DesignGrantRequestEntry[] | null>(null)
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
      buildDesignInitMessage({ slug: designSlug }, lease.nonce, snapshotRef.current, grantsRef.current),
    )
  }, [postToFrame, designSlug, lease.nonce])

  const postGrants = useCallback(
    (next: DesignGrantSummary[]) => {
      setGrants(next)
      grantsRef.current = next
      postToFrame(buildDesignGrantsMessage(next))
    },
    [postToFrame],
  )

  // Reconcile against the config (the source of truth): grants issued from
  // other surfaces appear, revoked grants disappear — so design buttons disable
  // live. In-dialog approvals the watcher hasn't confirmed yet are kept via
  // locallyIssuedRef (reconcileGrantSummaries releases them on confirmation).
  useEffect(() => {
    const next = reconcileGrantSummaries(grantsRef.current, usableConfigGrants(), locallyIssuedRef.current)
    if (!grantIdsEqual(next, grantsRef.current)) {
      postGrants(next)
    }
  }, [usableConfigGrants, postGrants])

  // Every design gets replacement snapshots, and the document decides what to
  // do with one: rendering it is what makes a dashboard follow its data, and
  // ignoring it is what makes a report stay the snapshot it was opened as.
  // (There is no kind to declare this; the page's own code says it.)
  useEffect(() => {
    const changed = snapshotRef.current !== snapshot
    snapshotRef.current = snapshot
    if (changed) {
      postToFrame(buildDesignDataMessage(snapshot))
    }
  }, [snapshot, postToFrame])

  const handleAction = useCallback(
    async (msg: Extract<DesignBridgeIncoming, { type: 'action' }>) => {
      const limiter = limiterRef.current!
      const reject = (error: string) =>
        postToFrame(
          buildDesignActionResultMessage({ requestId: msg.requestId, ok: false, error, durationMs: 0 }),
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
        reject(`${limited}: too many design actions in flight`)
        return
      }

      limiter.start(msg.requestId, Date.now(), mutating)
      try {
        const request: DesignActionRequest = {
          requestId: msg.requestId,
          designSlug,
          leaseId: lease.leaseId,
          nonce: msg.nonce,
          grantId: msg.grantId,
          invocation: msg.invocation,
        }
        const result: DesignActionResult = await window.electronAPI.executeDesignAction(workspaceId, request)
        postToFrame(buildDesignActionResultMessage(result))
      } catch (err) {
        reject(err instanceof Error ? err.message : 'Action failed')
      } finally {
        limiter.finish(msg.requestId)
      }
    },
    [workspaceId, designSlug, lease.leaseId, lease.nonce, postToFrame],
  )

  const handleGrantRequest = useCallback(
    (msg: Extract<DesignBridgeIncoming, { type: 'grant-request' }>) => {
      if (msg.nonce !== lease.nonce) return
      const current = grantsRef.current
      const remaining = msg.requests.filter(
        req =>
          !current.some(g => descriptorEquals(g.action, req.action)) &&
          !deniedRef.current.has(descriptorSignature(req.action)),
      )
      // Nothing new to ask (all satisfied or already denied this render), or a
      // dialog is already up: answer with the current state instead of stacking
      // prompts — the design reconciles by descriptor.
      if (remaining.length === 0 || pendingRequest !== null) {
        postToFrame(buildDesignGrantsMessage(current))
        return
      }
      setPendingRequest(remaining)
    },
    [lease.nonce, pendingRequest, postToFrame],
  )

  const handleApprove = useCallback(async () => {
    if (!pendingRequest) return
    setIssueBusy(true)
    const issued: DesignGrantSummary[] = []
    let failed = false
    for (const entry of pendingRequest) {
      try {
        const grant = await window.electronAPI.issueDesignGrant(workspaceId, designSlug, {
          action: entry.action,
          ...(entry.description !== undefined ? { description: entry.description } : {}),
        })
        issued.push(toGrantSummary(grant))
        locallyIssuedRef.current.add(grant.id)
      } catch (err) {
        failed = true
        toast.error(t('toast.designGrantFailed'), {
          description: err instanceof Error ? err.message : String(err),
        })
        break
      }
    }
    if (issued.length > 0 && !failed) {
      toast.success(t('toast.designGrantsIssued'))
    }
    postGrants([...grantsRef.current, ...issued])
    setPendingRequest(null)
    setIssueBusy(false)
  }, [pendingRequest, workspaceId, designSlug, postGrants, t])

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
      const msg = parseDesignBridgeMessage(event.data)
      if (!msg) return

      switch (msg.type) {
        case 'ready':
          postInit()
          break
        case 'deck':
          onDeckStateRef.current?.({ slides: msg.slides, current: msg.current })
          break
        case 'action':
          void handleAction(msg)
          break
        case 'action-cancel':
          if (msg.nonce === lease.nonce) {
            void window.electronAPI.cancelDesignAction(workspaceId, msg.requestId)
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
  // release (DesignView) invalidates the rest server-side.
  useEffect(() => {
    const limiter = limiterRef.current!
    return () => {
      for (const requestId of limiter.inFlightIds) {
        void window.electronAPI.cancelDesignAction(workspaceId, requestId)
      }
    }
  }, [workspaceId])

  return (
    <>
      <iframe
        ref={iframeRef}
        title={design.config.name}
        sandbox={DESIGN_FRAME_SANDBOX}
        referrerPolicy="no-referrer"
        {...(previewUrl ? { src: previewUrl } : { srcDoc: content })}
        onLoad={postInit}
        className={className ?? 'h-full w-full border-0 bg-white'}
      />
      <DesignGrantRequestDialog
        designName={design.config.name}
        requests={pendingRequest}
        busy={issueBusy}
        onApprove={handleApprove}
        onDeny={handleDeny}
      />
    </>
  )
}
