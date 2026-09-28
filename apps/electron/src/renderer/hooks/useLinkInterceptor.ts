/**
 * useLinkInterceptor - Centralized hook for intercepting file/URL open requests.
 *
 * Replaces the old handleOpenFile/handleOpenUrl in App.tsx that always opened externally.
 * Now classifies file types and decides what a click means: an in-app preview overlay, the
 * workspace's browser window, or the default external application.
 *
 * Architecture:
 *   Markdown click → PlatformContext → App.tsx → useLinkInterceptor
 *     ├── canPreview? → set previewState (renders overlay in App.tsx)
 *     └── else? → electronAPI.openFile (opens externally)
 *
 *   URL click → the app's own `openUrl` (App.tsx): a browser address opens in the workspace's
 *   browser window, the system browser when the person asked for that — the same switch — and
 *   the shell opener for everything that is not one.
 *
 * An `.html` file is a preview like any other and gets the same treatment: read here, drawn in
 * the window that draws HTML. Opening it for real — in a browser, as a tab at its own address —
 * is a button in that window's own header, not this decision: a click says "show me this file",
 * nothing more.
 *
 * Uses refs for options to keep returned callbacks referentially stable,
 * preventing unnecessary re-renders of consumers (AppShellContext, PlatformProvider).
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { classifyFile, type FilePreviewType } from '@craft-agent/ui'
import { getLanguageFromPath } from '@/lib/file-utils'

// ── Preview state types ────────────────────────────────────────────────────────
// Each variant carries the data needed to render its specific overlay.
// For text-based files (code, markdown, json, text), content starts as null
// while the file is being read, then gets populated.

interface ImagePreview {
  type: 'image'
  filePath: string
}

interface PDFPreview {
  type: 'pdf'
  filePath: string
}

interface CodePreview {
  type: 'code'
  filePath: string
  content: string | null
  language: string
  error?: string
}

interface MarkdownPreview {
  type: 'markdown'
  filePath: string
  content: string | null
  error?: string
}

interface JSONPreview {
  type: 'json'
  filePath: string
  content: string | null
  error?: string
}

interface TextPreview {
  type: 'text'
  filePath: string
  content: string | null
  error?: string
}

interface DrawioPreview {
  type: 'drawio'
  filePath: string
  /** The document, read before the window opens — the viewer draws what it is handed. */
  content: string | null
  error?: string
}

/**
 * An HTML file, read before the window opens for the same reason a diagram is: the window draws
 * what it is handed rather than fetching it, and a file that cannot be read has an error to show
 * instead of an empty box.
 */
interface HTMLPreview {
  type: 'html'
  filePath: string
  content: string | null
  error?: string
}

export type FilePreviewState =
  | ImagePreview
  | PDFPreview
  | CodePreview
  | MarkdownPreview
  | JSONPreview
  | TextPreview
  | DrawioPreview
  | HTMLPreview

// ── Hook options ───────────────────────────────────────────────────────────────
// Callbacks injected by App.tsx so the hook doesn't depend on window.electronAPI directly.

interface LinkInterceptorOptions {
  /** Open file in default external application (e.g., VS Code) */
  openFileExternal: (path: string) => Promise<void>
  /** Open URL in default browser */
  openUrl: (url: string) => Promise<void>
  /** Reveal file in system file manager */
  showInFolder: (path: string) => Promise<void>
  /** Read file as UTF-8 text (for code, markdown, json, text and html previews) */
  readFile: (path: string) => Promise<string>
  /** Read file as data URL (for image previews) */
  readFileDataUrl: (path: string) => Promise<string>
  /** Read file as binary (Uint8Array) for PDF previews via react-pdf */
  readFileBinary: (path: string) => Promise<Uint8Array>
}

// ── Hook return type ───────────────────────────────────────────────────────────

interface LinkInterceptorResult {
  /** Replacement for App.tsx handleOpenFile — classifies and routes */
  handleOpenFile: (path: string) => void
  /** Replacement for App.tsx handleOpenUrl — always opens externally */
  handleOpenUrl: (url: string) => void
  /** Open file directly in external app, bypassing classification/preview */
  openFileExternal: (path: string) => void
  /** Current preview state, drives which overlay renders in App.tsx */
  previewState: FilePreviewState | null
  /** Close the preview overlay */
  closePreview: () => void
  /** Open the currently previewed file in external app */
  openCurrentExternal: () => void
  /** Reveal the currently previewed file in system file manager */
  revealCurrentInFinder: () => void
  /** Read file as data URL — passed to image overlays as their loader */
  readFileDataUrl: (path: string) => Promise<string>
  /** Read file as binary — passed to PDF overlays for react-pdf */
  readFileBinary: (path: string) => Promise<Uint8Array>
}

// ── Hook implementation ────────────────────────────────────────────────────────

export function useLinkInterceptor(options: LinkInterceptorOptions): LinkInterceptorResult {
  const [previewState, setPreviewState] = useState<FilePreviewState | null>(null)

  // Use refs for options so callbacks remain referentially stable.
  // Without this, every render creates a new options object → new callbacks → cascading
  // re-renders of AppShellContext and PlatformProvider consumers.
  const optionsRef = useRef(options)
  useEffect(() => { optionsRef.current = options }, [options])

  // Also track previewState in a ref for the openCurrentExternal/revealCurrentInFinder
  // callbacks, so they don't need previewState in their dependency array.
  const previewStateRef = useRef(previewState)
  useEffect(() => { previewStateRef.current = previewState }, [previewState])

  /**
   * Main entry point for file link clicks.
   * Classifies the file by extension, then either opens a preview overlay or falls back to
   * opening externally.
   *
   * Reads the content BEFORE showing the overlay — local filesystem reads are near-instant, so
   * no loading state is needed. This avoids null-content issues in overlay components
   * (e.g., @uiw/react-json-view crashes on null value), and a diagram or HTML is read here for
   * the same reason: the window draws what it is handed, it does not open the file itself.
   */
  const handleOpenFile = useCallback(async (path: string) => {
    const classification = classifyFile(path)

    if (!classification.canPreview || !classification.type) {
      // No preview available — open in default external app
      optionsRef.current.openFileExternal(path)
      return
    }

    const type = classification.type

    // For image/pdf: set state immediately — the overlay handles its own async loading
    if (type === 'image' || type === 'pdf') {
      setPreviewState({ type, filePath: path })
      return
    }

    // For text-based files: read content first, then show overlay with content ready.
    // Local filesystem reads are near-instant — no loading state needed.
    try {
      const content = await optionsRef.current.readFile(path)
      const state = buildInitialTextState(type, path)
      setPreviewState({ ...state, content } as FilePreviewState)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to read file'
      const state = buildInitialTextState(type, path)
      setPreviewState({ ...state, content: '', error: errorMsg } as FilePreviewState)
    }
  }, []) // Stable: uses optionsRef

  /** Open file directly in external app, bypassing classification/preview.
   * Used by overlay header badges — when already viewing a file, "Open" should launch the editor. */
  const openFileExternal = useCallback((path: string) => {
    optionsRef.current.openFileExternal(path)
  }, []) // Stable: uses optionsRef

  /**
   * A URL is handed to the app, which decides where it opens: a page goes to the workspace's
   * browser window by default (the person's setting, read there), the system browser when they
   * asked for that, and the shell opener for anything that is not a page. This hook only
   * carries the click.
   */
  const handleOpenUrl = useCallback((url: string) => {
    optionsRef.current.openUrl(url)
  }, []) // Stable: uses optionsRef

  const closePreview = useCallback(() => {
    setPreviewState(null)
  }, [])

  /** Open the currently previewed file in external app (from overlay header) */
  const openCurrentExternal = useCallback(() => {
    const state = previewStateRef.current
    if (state) {
      optionsRef.current.openFileExternal(state.filePath)
    }
  }, []) // Stable: uses refs

  /** Reveal the currently previewed file in system file manager (from overlay header) */
  const revealCurrentInFinder = useCallback(() => {
    const state = previewStateRef.current
    if (state) {
      optionsRef.current.showInFolder(state.filePath)
    }
  }, []) // Stable: uses refs

  /** Stable reference to readFileDataUrl for overlay components */
  const readFileDataUrl = useCallback((path: string) => {
    return optionsRef.current.readFileDataUrl(path)
  }, []) // Stable: uses optionsRef

  /** Stable reference to readFileBinary for PDF overlay */
  const readFileBinary = useCallback((path: string) => {
    return optionsRef.current.readFileBinary(path)
  }, []) // Stable: uses optionsRef

  return {
    handleOpenFile,
    handleOpenUrl,
    openFileExternal,
    previewState,
    closePreview,
    openCurrentExternal,
    revealCurrentInFinder,
    readFileDataUrl,
    readFileBinary,
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build the initial preview state for text-based file types.
 * Content is null initially (loading), and gets populated after async read.
 * HTML and a diagram are in here for the same reason as the text types: what they show is the
 * file's own text, read first.
 */
function buildInitialTextState(type: FilePreviewType, path: string): FilePreviewState {
  switch (type) {
    case 'code':
      return { type: 'code', filePath: path, content: null, language: getLanguageFromPath(path) }
    case 'markdown':
      return { type: 'markdown', filePath: path, content: null }
    case 'json':
      return { type: 'json', filePath: path, content: null }
    case 'text':
      return { type: 'text', filePath: path, content: null }
    case 'drawio':
      return { type: 'drawio', filePath: path, content: null }
    case 'html':
      return { type: 'html', filePath: path, content: null }
    default:
      // Should never happen — image/pdf are set before this is called.
      return { type: 'text', filePath: path, content: null }
  }
}
