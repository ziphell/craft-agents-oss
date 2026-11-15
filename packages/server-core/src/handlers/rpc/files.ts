import { readFile, writeFile, unlink, mkdir, readdir, stat, open } from 'fs/promises'
import { isAbsolute, join, resolve, dirname, parse as parsePath } from 'path'
import { homedir } from 'os'
import { validatePathFormat, isValidWorkingDirectory } from '../../utils/path-validation'
import { randomUUID } from 'crypto'
import { RPC_CHANNELS, type FileAttachment, type DirectoryListingResult } from '@craft-agent/shared/protocol'
import type { StoredAttachment } from '@craft-agent/core/types'
import { readFileAttachment, validateImageForClaudeAPI, IMAGE_LIMITS, expandPath } from '@craft-agent/shared/utils'
import { getSessionAttachmentsPath, validateSessionId } from '@craft-agent/shared/sessions'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { isReelPath } from '@craft-agent/shared/reel/document'
import { resizeImageForAPI, inspectImageBuffer, officeToMarkdown } from '@craft-agent/server-core/services'
import { runCliTool } from '../../services/cli-tool.ts'
import { sanitizeFilename, validateFilePath, getWorkspaceAllowedDirs, resolveWorkspacePath } from '@craft-agent/server-core/handlers'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { requestClientOpenFileDialog, requestClientSaveFileDialog } from '@craft-agent/server-core/transport'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.file.READ,
  RPC_CHANNELS.file.READ_DATA_URL,
  RPC_CHANNELS.file.READ_PREVIEW_DATA_URL,
  RPC_CHANNELS.file.READ_BINARY,
  RPC_CHANNELS.file.WRITE,
  RPC_CHANNELS.file.WRITE_BINARY,
  RPC_CHANNELS.file.DELETE_EDIT,
  RPC_CHANNELS.file.OPEN_DIALOG,
  RPC_CHANNELS.file.SAVE_DIALOG,
  RPC_CHANNELS.file.READ_ATTACHMENT,
  RPC_CHANNELS.file.READ_USER_ATTACHMENT,
  RPC_CHANNELS.file.STORE_ATTACHMENT,
  RPC_CHANNELS.file.GENERATE_THUMBNAIL,
  RPC_CHANNELS.fs.SEARCH,
  RPC_CHANNELS.fs.LIST_DIRECTORY,
  RPC_CHANNELS.fs.CHECK_DIRECTORY,
] as const

/**
 * Make an uploaded picture usable before anything reads it: HEIC decoded (sharp cannot), EXIF
 * orientation baked into the pixels instead of left in a tag. `img-tool normalize` is the same
 * command the agent has, so the preview, the thumbnail, the stored file and the model all see the
 * same pixels. A picture that is already right is copied, and `changed: false` says so — no
 * re-encoding, no quality loss.
 *
 * Returns null when the tool cannot run (not built, crash): the caller keeps today's bytes rather
 * than failing the upload over a missing normaliser.
 */
async function normalizeImageBytes(
  data: Buffer,
  dir: string,
  stem: string,
): Promise<{ buffer: Buffer; changed: boolean } | null> {
  const input = join(dir, `${stem}.upload`)
  const output = join(dir, `${stem}.normalized.jpg`)
  try {
    await writeFile(input, data)
    const run = await runCliTool('img-tool', ['normalize', input, '-o', output], { timeoutMs: 120_000 })
    if (!run.ok) return null
    const answer = JSON.parse(run.stdout) as { changed?: boolean }
    return { buffer: await readFile(output), changed: answer.changed === true }
  } catch {
    return null
  } finally {
    await Promise.all([unlink(input).catch(() => {}), unlink(output).catch(() => {})])
  }
}

export function registerFilesHandlers(server: RpcServer, deps: HandlerDeps): void {
  // Read a file (with path validation to prevent traversal attacks).
  //
  // `maxBytes` is for previews: a thumbnail of a large transcript only needs its first lines, so
  // reading the head of the file keeps a 50 MB log from crossing the wire to draw three lines.
  server.handle(RPC_CHANNELS.file.READ, async (ctx, path: string, maxBytes?: number) => {
    try {
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(resolveWorkspacePath(path, workspaceId), getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }))
      if (maxBytes && maxBytes > 0) {
        const handle = await open(safePath, 'r')
        try {
          const buffer = Buffer.alloc(Math.min(maxBytes, 1024 * 1024))
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          return buffer.subarray(0, bytesRead).toString('utf-8')
        } finally {
          await handle.close()
        }
      }
      const content = await readFile(safePath, 'utf-8')
      return content
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      // ENOENT is expected for optional config files (e.g. automations.json)
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        deps.platform.logger.debug('readFile: file not found:', path)
      } else {
        deps.platform.logger.error('readFile error:', path, message)
      }
      throw new Error(`Failed to read file: ${message}`)
    }
  })

  // Write a UTF-8 file the person is looking at.
  //
  // The boundary is **the one that let the app show the file**: reads here go through
  // `validateFilePath(path, getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }))`, and saving the file that
  // came back through it is the whole point of showing it. A narrower boundary would refuse the
  // one case this path exists for ("open this page and fix it"), and a second, tighter rule for
  // writing would be a description of the read side that has to be kept in step with it.
  //
  // It is deliberately NOT the agent's write policy (mode-manager: the plans and data folders
  // plus the `allowedWritePaths` grants): that one governs tools, and widening this does not
  // widen it. Sensitive paths (`.env`, keys, `credentials.json`) stay refused on both sides,
  // because that rule lives in `validateFilePath` rather than in either caller.
  server.handle(RPC_CHANNELS.file.WRITE, async (ctx, path: string, content: string) => {
    try {
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(resolveWorkspacePath(path, workspaceId), getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }))

      await mkdir(dirname(safePath), { recursive: true })
      await writeFile(safePath, content, 'utf-8')
      deps.platform.logger.debug('writeFile: wrote', safePath)
      return { path: safePath }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('writeFile error:', path, message)
      throw new Error(`Failed to write file: ${message}`)
    }
  })

  // Remove a cut. Deliberately narrower than the read/write boundary: this exists for
  // `reels/<slug>.reel`, and refuses every other file by name so it cannot become a
  // general-purpose delete RPC.
  server.handle(RPC_CHANNELS.file.DELETE_EDIT, async (ctx, path: string) => {
    try {
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(path, getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }))
      if (!isReelPath(safePath)) {
        throw new Error(`Not a cut document: ${safePath}`)
      }
      await unlink(safePath)
      deps.platform.logger.debug('deleteEdit: removed', safePath)
      return { path: safePath }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('deleteEdit error:', path, message)
      throw new Error(`Failed to delete cut: ${message}`)
    }
  })

  // The binary half of `file:write`.
  //
  // A document is not UTF-8: docx/xlsx/pptx are zip archives, and the editor hands back the
  // bytes it built. The boundary is deliberately the *same* one as the text write above — the
  // file a person opened is the file they may save — rather than a narrower rule that would
  // have to be kept in step with it. Content arrives as a `Uint8Array` (the peer of what
  // `readBinary` returns) or an `ArrayBuffer` from a host that transferred it.
  //
  // The fourth argument is the person's answer to "save anyway": a save that would overwrite work
  // done elsewhere is refused unless it is set. That refusal is the whole guard — the alternative
  // (write first, tell them afterwards) is the failure this path exists to prevent, because the
  // agent writes documents through the CLI with no editor in the loop.
  server.handle(
    RPC_CHANNELS.file.WRITE_BINARY,
    async (ctx, path: string, data: Uint8Array | ArrayBuffer, overwrite?: boolean) => {
      try {
        const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
        const safePath = await validateFilePath(resolveWorkspacePath(path, workspaceId), getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }))
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)

        if (!overwrite && (await deps.officeDisk?.check(safePath)) === 'conflict') {
          // The path is in the message on purpose: it is what the person needs to see, and what a
          // caller can key on to offer "overwrite" instead of parsing prose.
          throw new Error(
            `The document changed on disk since it was opened, so this save would overwrite those changes: ${safePath}`,
          )
        }

        await mkdir(dirname(safePath), { recursive: true })
        await writeFile(safePath, bytes)
        await deps.officeDisk?.record(safePath, bytes)
        deps.platform.logger.debug('writeFileBinary: wrote', safePath, bytes.byteLength)
        return { path: safePath }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        deps.platform.logger.error('writeFileBinary error:', path, message)
        throw new Error(`Failed to write file: ${message}`)
      }
    },
  )

  // Read a file as a data URL: images for the preview overlays and markdown pictures, **and
  // audio/video**, because the timeline plays clips through the same call. A data URL's type is
  // the only thing a `<video>` has to go on — served as `application/octet-stream` it refuses the
  // source with `MEDIA_ELEMENT_ERROR: Unable to load URL due to content type`, which reads as
  // "the player is broken" rather than "the mime is wrong".
  server.handle(RPC_CHANNELS.file.READ_DATA_URL, async (ctx, path: string) => {
    try {
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(resolveWorkspacePath(path, workspaceId), getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }))
      const buffer = await readFile(safePath)
      const ext = safePath.split('.').pop()?.toLowerCase() ?? ''

      // Map previewable image extensions to MIME types.
      // HEIC/HEIF/TIFF are intentionally excluded — no Chromium codec, opened externally instead.
      const mimeMap: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        bmp: 'image/bmp',
        ico: 'image/x-icon',
        avif: 'image/avif',
        mp4: 'video/mp4',
        m4v: 'video/mp4',
        mov: 'video/quicktime',
        webm: 'video/webm',
        mkv: 'video/x-matroska',
        ogv: 'video/ogg',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        m4a: 'audio/mp4',
        aac: 'audio/aac',
        ogg: 'audio/ogg',
        flac: 'audio/flac',
      }
      const mime = mimeMap[ext] || 'application/octet-stream'
      const base64 = buffer.toString('base64')
      return `data:${mime};base64,${base64}`
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('readFileDataUrl error:', message)
      throw new Error(`Failed to read file as data URL: ${message}`)
    }
  })

  // Read an image file as a small preview data URL for lightweight thumbnail rendering.
  // Returns a PNG data URL resized to fit within maxSize×maxSize.
  server.handle(RPC_CHANNELS.file.READ_PREVIEW_DATA_URL, async (ctx, path: string, maxSize = 64) => {
    try {
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(resolveWorkspacePath(path, workspaceId), getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }))
      const size = Number.isFinite(maxSize) ? Math.max(16, Math.min(256, Math.floor(maxSize))) : 64
      const preview = await deps.platform.imageProcessor.process(safePath, {
        resize: { width: size, height: size },
        fit: 'inside',
        format: 'png',
      })
      return `data:image/png;base64,${preview.toString('base64')}`
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('readFilePreviewDataUrl error:', message)
      throw new Error(`Failed to read file preview: ${message}`)
    }
  })

  // Read a file as raw binary (Uint8Array) for react-pdf.
  // The WS transport codec preserves Uint8Array payloads over JSON envelopes.
  server.handle(RPC_CHANNELS.file.READ_BINARY, async (ctx, path: string) => {
    try {
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(resolveWorkspacePath(path, workspaceId), getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }))
      const buffer = await readFile(safePath)
      // Return as Uint8Array (serializes to ArrayBuffer over IPC)
      return new Uint8Array(buffer)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('readFileBinary error:', message)
      throw new Error(`Failed to read file as binary: ${message}`)
    }
  })

  // Open native file dialog for selecting files to attach (routed to client)
  server.handle(RPC_CHANNELS.file.OPEN_DIALOG, async (ctx) => {
    const result = await requestClientOpenFileDialog(server, ctx.clientId, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        // Allow all files by default - the agent can figure out how to handle them
        { name: 'All Files', extensions: ['*'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'] },
        { name: 'Documents', extensions: ['pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'txt', 'md', 'rtf'] },
        { name: 'Code', extensions: ['js', 'ts', 'tsx', 'jsx', 'py', 'json', 'css', 'html', 'xml', 'yaml', 'yml', 'sh', 'sql', 'go', 'rs', 'rb', 'php', 'java', 'c', 'cpp', 'h', 'swift', 'kt'] },
      ]
    })
    return result.canceled ? [] : result.filePaths
  })

  /**
   * Ask the client where to put a copy.
   *
   * The document host runs on the hub, a person's disk does not: the only party that can name a
   * path they can reach is the client, which is why this is a client capability like OPEN_DIALOG.
   * A cancelled dialog is `null` — not an error, and not a path in the host's own filesystem.
   */
  server.handle(RPC_CHANNELS.file.SAVE_DIALOG, async (ctx, spec: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> } = {}) => {
    const result = await requestClientSaveFileDialog(server, ctx.clientId, spec)
    return result.canceled ? null : result.filePath
  })

  // Read file and return as FileAttachment with Quick Look thumbnail
  server.handle(RPC_CHANNELS.file.READ_ATTACHMENT, async (ctx, path: string) => {
    try {
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(path, getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }))
      // Use shared utility that handles file type detection, encoding, etc.
      const attachment = await readFileAttachment(safePath)
      if (!attachment) return null

      // Generate thumbnail for image preview
      // Only works for image formats the processor supports — PDFs/Office files get icon fallback
      try {
        const thumbBuffer = await deps.platform.imageProcessor.process(safePath, {
          resize: { width: 200, height: 200 },
          format: 'png',
        })
        ;(attachment as { thumbnailBase64?: string }).thumbnailBase64 = thumbBuffer.toString('base64')
      } catch (thumbError) {
        // Thumbnail generation failed (non-image file or corrupt) — icon fallback
        deps.platform.logger.info('Thumbnail generation failed (using fallback):', thumbError instanceof Error ? thumbError.message : thumbError)
      }

      return attachment
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('readFileAttachment error:', message)
      return null
    }
  })

  // Read a user-attached file (bypasses workspace-dir validation).
  // Used only by renderer draft hydration: the path was written to drafts.json by a
  // previous user-initiated OS-picker / Finder-drag attach, so the path implies consent.
  // NOT exposed to agent code — no equivalent MCP tool. Kept separate from readFileAttachment
  // on purpose to preserve the agent-facing read's narrow trust boundary.
  const USER_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024
  server.handle(RPC_CHANNELS.file.READ_USER_ATTACHMENT, async (_ctx, path: string) => {
    try {
      if (!path || typeof path !== 'string' || !isAbsolute(path)) return null
      const info = await stat(path).catch(() => null)
      if (!info || !info.isFile()) return null
      if (info.size > USER_ATTACHMENT_MAX_BYTES) {
        deps.platform.logger.warn(`[readUserAttachment] file exceeds ${USER_ATTACHMENT_MAX_BYTES} bytes, skipping: ${path}`)
        return null
      }
      const attachment = readFileAttachment(path)
      if (!attachment) return null
      try {
        const thumbBuffer = await deps.platform.imageProcessor.process(path, {
          resize: { width: 200, height: 200 },
          format: 'png',
        })
        ;(attachment as { thumbnailBase64?: string }).thumbnailBase64 = thumbBuffer.toString('base64')
      } catch {
        // Non-image or corrupt — icon fallback, same as readFileAttachment
      }
      return attachment
    } catch (error) {
      deps.platform.logger.error('readUserAttachment error:', error instanceof Error ? error.message : error)
      return null
    }
  })

  // Generate thumbnail from base64 data (for drag-drop files where we don't have a path)
  server.handle(RPC_CHANNELS.file.GENERATE_THUMBNAIL, async (_ctx, base64: string, _mimeType: string): Promise<string | null> => {
    try {
      const buffer = Buffer.from(base64, 'base64')
      const thumbBuffer = await deps.platform.imageProcessor.process(buffer, {
        resize: { width: 200, height: 200 },
        format: 'png',
      })
      return thumbBuffer.toString('base64')
    } catch (error) {
      deps.platform.logger.info('generateThumbnail failed:', error instanceof Error ? error.message : error)
      return null
    }
  })

  // Store an attachment to disk and generate thumbnail/markdown conversion
  // This is the core of the persistent file attachment system
  server.handle(RPC_CHANNELS.file.STORE_ATTACHMENT, async (ctx, sessionId: string, attachment: FileAttachment): Promise<StoredAttachment> => {
    // Track files we've written for cleanup on error
    const filesToCleanup: string[] = []

    try {
      // Reject empty files early
      if (attachment.size === 0) {
        throw new Error('Cannot attach empty file')
      }

      // Get workspace slug from the calling window
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      if (!workspaceId) {
        throw new Error('Cannot determine workspace for attachment storage')
      }
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`)
      }
      const workspaceRootPath = workspace.rootPath

      // SECURITY: Validate sessionId to prevent path traversal attacks
      // This must happen before using sessionId in any file path operations
      validateSessionId(sessionId)

      // Create attachments directory if it doesn't exist
      const attachmentsDir = getSessionAttachmentsPath(workspaceRootPath, sessionId)
      await mkdir(attachmentsDir, { recursive: true })

      // Generate unique ID for this attachment
      const id = randomUUID()
      const safeName = sanitizeFilename(attachment.name)
      const storedFileName = `${id}_${safeName}`
      let storedPath = join(attachmentsDir, storedFileName)

      // Track if image was resized (for return value)
      let wasResized = false
      let finalSize = attachment.size
      let resizedBase64: string | undefined
      // Set when the picture was re-encoded so the bytes and the declared type agree (HEIC →
      // JPEG, or an EXIF-rotated JPEG). The extension follows, because everything downstream —
      // `call_llm`'s media type included — reads the type off the name.
      let wasNormalized = false
      let effectiveMimeType = attachment.mimeType

      // 1. Save the file (with image validation and resizing)
      if (attachment.base64) {
        // Images, PDFs, Office files - decode from base64
        let decoded: Buffer = Buffer.from(attachment.base64, 'base64')
        // Validate decoded size matches expected (allow small variance for encoding overhead)
        if (Math.abs(decoded.length - attachment.size) > 100) {
          throw new Error(`Attachment corrupted: size mismatch (expected ${attachment.size}, got ${decoded.length})`)
        }

        // For images: validate and resize if needed for Claude API compatibility
        if (attachment.type === 'image') {
          // Direction first, before anything measures the picture: a HEIC or an EXIF-rotated
          // JPEG is still sideways on disk, and every later step (size validation, resize,
          // thumbnail, the bytes sent to the model) would otherwise work on the wrong pixels.
          const normalized = await normalizeImageBytes(decoded, attachmentsDir, id)
          if (normalized?.changed) {
            decoded = normalized.buffer
            wasNormalized = true
            effectiveMimeType = 'image/jpeg'
            finalSize = decoded.length
            storedPath = join(attachmentsDir, `${id}_${safeName.replace(/\.[^.]+$/, '')}.jpg`)
            deps.platform.logger.info(`Attachment normalised to JPEG (upright, ${finalSize} bytes)`)
          }

          const imageInspection = await inspectImageBuffer(decoded, deps.platform.imageProcessor)
          const imageSize = imageInspection.status === 'ok'
            ? { width: imageInspection.width, height: imageInspection.height }
            : null

          // Determine if we should resize
          let shouldResize = false
          let targetSize: { width: number; height: number } | undefined

          if (imageInspection.status === 'processor_unavailable') {
            deps.platform.logger.warn('Image processing unavailable while validating attachment:', imageInspection.error?.message ?? 'unknown error')
            if (decoded.length > IMAGE_LIMITS.MAX_SIZE) {
              throw new Error('Image processing is unavailable, so oversized images cannot be validated or resized automatically. Please attach a smaller image.')
            }
          } else if (imageInspection.status === 'invalid_image') {
            throw new Error(imageInspection.error?.message || 'Invalid or unsupported image file')
          } else {
            // Validate image for Claude API
            const validation = validateImageForClaudeAPI(decoded.length, imageSize!.width, imageSize!.height)

            shouldResize = validation.needsResize ?? false
            targetSize = validation.suggestedSize

            if (!validation.valid && validation.errorCode === 'dimension_exceeded') {
              // Image exceeds 8000px limit - calculate resize to fit within limits
              const maxDim = IMAGE_LIMITS.MAX_DIMENSION
              const scale = Math.min(maxDim / imageSize!.width, maxDim / imageSize!.height)
              targetSize = {
                width: Math.floor(imageSize!.width * scale),
                height: Math.floor(imageSize!.height * scale),
              }
              shouldResize = true
              deps.platform.logger.info(`Image exceeds ${maxDim}px limit (${imageSize!.width}x${imageSize!.height}), will resize to ${targetSize.width}x${targetSize.height}`)
            } else if (!validation.valid && validation.errorCode === 'size_exceeded') {
              // File >5MB — try resize+compress instead of rejecting
              shouldResize = true
              deps.platform.logger.info(`Image exceeds 5MB (${(decoded.length / 1024 / 1024).toFixed(1)}MB), will attempt resize`)
            } else if (!validation.valid) {
              throw new Error(validation.error)
            }
          }

          // If resize is needed (either recommended or required), do it now
          if (shouldResize) {
            const isPhoto = effectiveMimeType === 'image/jpeg'

            if (targetSize) {
              // Dimension-exceeded: resize to specific target dimensions
              deps.platform.logger.info(`Resizing image from ${imageSize!.width}x${imageSize!.height} to ${targetSize.width}x${targetSize.height}`)
              try {
                decoded = await deps.platform.imageProcessor.process(decoded, {
                  resize: { width: targetSize.width, height: targetSize.height },
                  format: isPhoto ? 'jpeg' : 'png',
                  quality: isPhoto ? IMAGE_LIMITS.JPEG_QUALITY_HIGH : undefined,
                })
                wasResized = true
                finalSize = decoded.length

                // Re-validate final size after resize
                if (decoded.length > IMAGE_LIMITS.MAX_SIZE) {
                  decoded = await deps.platform.imageProcessor.process(decoded, { format: 'jpeg', quality: IMAGE_LIMITS.JPEG_QUALITY_FALLBACK })
                  finalSize = decoded.length
                  if (decoded.length > IMAGE_LIMITS.MAX_SIZE) {
                    throw new Error(`Image still too large after resize (${(decoded.length / 1024 / 1024).toFixed(1)}MB). Please use a smaller image.`)
                  }
                }
              } catch (resizeError) {
                deps.platform.logger.error('Image resize failed:', resizeError)
                const reason = resizeError instanceof Error ? resizeError.message : String(resizeError)
                throw new Error(`Image too large (${imageSize!.width}x${imageSize!.height}) and automatic resize failed: ${reason}. Please manually resize it before attaching.`)
              }
            } else {
              // Size-exceeded or optimal resize — use shared utility for full pipeline
              const result = await resizeImageForAPI(decoded, { isPhoto })
              if (!result) {
                throw new Error(`Image too large (${(decoded.length / 1024 / 1024).toFixed(1)}MB) and could not be compressed enough. Please use a smaller image.`)
              }
              decoded = result.buffer
              wasResized = true
              finalSize = decoded.length
            }

            deps.platform.logger.info(`Image resized: ${attachment.size} -> ${finalSize} bytes (${Math.round((1 - finalSize / attachment.size) * 100)}% reduction)`)

            // Store resized base64 to return to renderer
            // This is used when sending to Claude API instead of original large base64
            resizedBase64 = decoded.toString('base64')
          } else if (wasNormalized) {
            // Re-encoded without resizing (HEIC, or EXIF-rotated JPEG): the renderer must send
            // these bytes rather than the original, or the model keeps the sideways picture.
            resizedBase64 = decoded.toString('base64')
          }
        }

        await writeFile(storedPath, decoded)
        filesToCleanup.push(storedPath)
      } else if (attachment.text) {
        // Text files - save as UTF-8
        await writeFile(storedPath, attachment.text, 'utf-8')
        filesToCleanup.push(storedPath)
      } else {
        throw new Error('Attachment has no content (neither base64 nor text)')
      }

      // 2. Generate thumbnail (images only — PDFs/Office get icon fallback)
      let thumbnailPath: string | undefined
      let thumbnailBase64: string | undefined
      const thumbFileName = `${id}_thumb.png`
      const thumbPath = join(attachmentsDir, thumbFileName)
      try {
        const pngBuffer = await deps.platform.imageProcessor.process(storedPath, {
          resize: { width: 200, height: 200 },
          format: 'png',
        })
        await writeFile(thumbPath, pngBuffer)
        thumbnailPath = thumbPath
        thumbnailBase64 = pngBuffer.toString('base64')
        filesToCleanup.push(thumbPath)
      } catch (thumbError) {
        // Thumbnail generation failed (non-image or corrupt) — icon fallback
        deps.platform.logger.info('Thumbnail generation failed (using fallback):', thumbError instanceof Error ? thumbError.message : thumbError)
      }

      // 3. Convert Office files to markdown (for sending to Claude)
      // This is required for Office files - Claude can't read raw Office binary
      let markdownPath: string | undefined
      if (attachment.type === 'office') {
        const mdFileName = `${id}_${safeName}.md`
        const mdPath = join(attachmentsDir, mdFileName)
        try {
          const markdown = await officeToMarkdown(storedPath)
          await writeFile(mdPath, markdown, 'utf-8')
          markdownPath = mdPath
          filesToCleanup.push(mdPath)
          deps.platform.logger.info(`Converted Office file to markdown: ${mdPath}`)
        } catch (convertError) {
          // Conversion failed - throw so user knows the file can't be processed
          // Claude can't read raw Office binary, so a failed conversion = unusable file
          const errorMsg = convertError instanceof Error ? convertError.message : String(convertError)
          deps.platform.logger.error('Office to markdown conversion failed:', errorMsg)
          throw new Error(`Failed to convert "${attachment.name}" to readable format: ${errorMsg}`)
        }
      }

      // Return StoredAttachment metadata
      // Include wasResized flag so UI can show notification
      // Include resizedBase64 so renderer uses resized image for Claude API
      return {
        id,
        type: attachment.type,
        name: attachment.name,
        mimeType: effectiveMimeType,
        size: finalSize, // Use final size (may differ if resized or re-encoded)
        originalSize: wasResized || wasNormalized ? attachment.size : undefined, // Track original if bytes changed
        storedPath,
        thumbnailPath,
        thumbnailBase64,
        markdownPath,
        wasResized,
        resizedBase64, // Set when the bytes differ from the original (resized or re-encoded for orientation), used for Claude API
      }
    } catch (error) {
      // Clean up any files we've written before the error
      if (filesToCleanup.length > 0) {
        deps.platform.logger.info(`Cleaning up ${filesToCleanup.length} orphaned file(s) after storage error`)
        await Promise.all(filesToCleanup.map(f => unlink(f).catch(() => {})))
      }

      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('storeAttachment error:', message)
      throw new Error(`Failed to store attachment: ${message}`)
    }
  })

  // Filesystem search for @ mention file selection.
  // Parallel BFS walk that skips ignored directories BEFORE entering them,
  // avoiding reading node_modules/etc. contents entirely. Uses withFileTypes
  // to get entry types without separate stat calls.
  server.handle(RPC_CHANNELS.fs.SEARCH, async (_ctx, basePath: string, query: string) => {
    deps.platform.logger.info('[FS_SEARCH] called:', basePath, query)
    const MAX_RESULTS = 50

    // Directories to never recurse into
    const SKIP_DIRS = new Set([
      'node_modules', '.git', '.svn', '.hg', 'dist', 'build',
      '.next', '.nuxt', '.cache', '__pycache__', 'vendor',
      '.idea', '.vscode', 'coverage', '.nyc_output', '.turbo', 'out',
    ])

    const lowerQuery = query.toLowerCase()
    const results: Array<{ name: string; path: string; type: 'file' | 'directory'; relativePath: string }> = []

    try {
      // BFS queue: each entry is a relative path prefix ('' for root)
      let queue = ['']

      while (queue.length > 0 && results.length < MAX_RESULTS) {
        // Process current level: read all directories in parallel
        const nextQueue: string[] = []

        const dirResults = await Promise.all(
          queue.map(async (relDir) => {
            const absDir = relDir ? join(basePath, relDir) : basePath
            try {
              return { relDir, entries: await readdir(absDir, { withFileTypes: true }) }
            } catch {
              // Skip dirs we can't read (permissions, broken symlinks, etc.)
              return { relDir, entries: [] as import('fs').Dirent[] }
            }
          })
        )

        for (const { relDir, entries } of dirResults) {
          if (results.length >= MAX_RESULTS) break

          for (const entry of entries) {
            if (results.length >= MAX_RESULTS) break

            const name = entry.name
            // Skip hidden files/dirs and ignored directories
            if (name.startsWith('.') || SKIP_DIRS.has(name)) continue

            const relativePath = relDir ? `${relDir}/${name}` : name
            const isDir = entry.isDirectory()

            // Queue subdirectories for next BFS level
            if (isDir) {
              nextQueue.push(relativePath)
            }

            // Check if name or path matches the query
            const lowerName = name.toLowerCase()
            const lowerRelative = relativePath.toLowerCase()
            if (lowerName.includes(lowerQuery) || lowerRelative.includes(lowerQuery)) {
              results.push({
                name,
                path: join(basePath, relativePath),
                type: isDir ? 'directory' : 'file',
                relativePath,
              })
            }
          }
        }

        queue = nextQueue
      }

      // Sort: directories first, then by name length (shorter = better match)
      results.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
        return a.name.length - b.name.length
      })

      deps.platform.logger.info('[FS_SEARCH] returning', results.length, 'results')
      return results
    } catch (err) {
      deps.platform.logger.error('[FS_SEARCH] error:', err)
      return []
    }
  })

  // Whether a path is currently an existing directory on this server.
  // The composer asks before enabling send for a conversation whose working
  // directory was picked earlier and may since have been removed.
  server.handle(RPC_CHANNELS.fs.CHECK_DIRECTORY, async (_ctx, dirPath: string) => {
    if (!dirPath?.trim()) return false
    return isValidWorkingDirectory(expandPath(dirPath)).valid
  })

  // List a directory for the remote browser.
  // Directories always; files only when the caller asks (`includeFiles`), because the
  // folder pickers want a folder list and the attach picker wants to choose a file.
  server.handle(RPC_CHANNELS.fs.LIST_DIRECTORY, async (_ctx, dirPath: string, options?: { includeFiles?: boolean }) => {
    // Resolve ~ to server's home directory (thin clients don't know the server's home)
    if (dirPath === '~' || dirPath.startsWith('~/')) {
      dirPath = dirPath === '~' ? homedir() : join(homedir(), dirPath.slice(2))
    }

    // Reject cross-platform and relative paths before resolve() can concatenate with cwd
    const pathCheck = validatePathFormat(dirPath)
    if (!pathCheck.valid) {
      throw new Error(pathCheck.reason!)
    }

    // Normalize (collapses .. segments, trailing slashes, etc.)
    const resolved = resolve(dirPath)

    // Read entries. Directories first, files only on request.
    const includeFiles = options?.includeFiles === true
    const raw = await readdir(resolved, { withFileTypes: true })

    const entries: Array<{ name: string; path: string; isSymlink: boolean; isDirectory: boolean }> = []
    for (const entry of raw) {
      const fullPath = join(resolved, entry.name)
      const isSymlink = entry.isSymbolicLink()

      if (entry.isDirectory()) {
        entries.push({ name: entry.name, path: fullPath, isSymlink: false, isDirectory: true })
      } else if (isSymlink) {
        // Follow symlink — check what it points at
        try {
          const target = await stat(fullPath)
          if (target.isDirectory()) {
            entries.push({ name: entry.name, path: fullPath, isSymlink: true, isDirectory: true })
          } else if (includeFiles && target.isFile()) {
            entries.push({ name: entry.name, path: fullPath, isSymlink: true, isDirectory: false })
          }
        } catch {
          // Broken symlink — skip silently
        }
      } else if (includeFiles && entry.isFile()) {
        entries.push({ name: entry.name, path: fullPath, isSymlink: false, isDirectory: false })
      }
    }

    // Sort alphabetically (case-insensitive), cap at 500
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    const totalEntries = entries.length
    const truncated = totalEntries > 500
    if (truncated) entries.length = 500

    // Compute parent path
    const parentPath = resolved === parsePath(resolved).root ? null : dirname(resolved)

    // Compute breadcrumbs server-side
    const breadcrumbs: Array<{ name: string; path: string }> = []
    let current = resolved
    while (true) {
      const parsed = parsePath(current)
      const name = parsed.base || parsed.root
      breadcrumbs.unshift({ name, path: current })
      if (current === parsed.root) break
      current = dirname(current)
    }

    return {
      currentPath: resolved,
      parentPath,
      breadcrumbs,
      platform: process.platform as DirectoryListingResult['platform'],
      truncated,
      totalEntries,
      entries,
    } satisfies DirectoryListingResult
  })
}
