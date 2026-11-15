/**
 * Reading the words on a picture, asked by a panel rather than by a conversation.
 *
 * The engine is `img-tool text` — the same command the agent runs — so the panel and the agent read
 * a screenshot the same way. Pixel arithmetic (crop, rotate, flip, resize) is the renderer's: the
 * browser already decodes those formats, and sending bytes to a child process to rotate a picture
 * would be work for no reason. Only OCR needs the native runtime, and it runs in its own process so
 * a large screenshot cannot stall the conversations this server is hosting.
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { validateFilePath, getWorkspaceAllowedDirs } from '@craft-agent/server-core/handlers'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { runCliTool } from '../../services/cli-tool.ts'

export const HANDLED_CHANNELS = [RPC_CHANNELS.img.OCR] as const

export function registerImgHandlers(server: RpcServer, deps: HandlerDeps): void {
  /**
   * A picture on this machine, read back as text.
   *
   * The answer is every character the engine found, in reading order, with the box each line sat
   * in. What the picture *means* is not this door's question — that is still the vision model's.
   */
  server.handle(
    RPC_CHANNELS.img.OCR,
    async (ctx, request: { imagePath: string; maxSide?: number }) => {
      const workspaceId =
        ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(
        request.imagePath,
        getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }),
      )
      if (!safePath) return { ok: false, message: '找不到这张图片' }

      // 960 is the tool's measured default: a 1080p screenshot reads the same words at roughly half
      // the memory of the preset's own size. A caller with very small text can ask for more.
      const maxSide = Math.max(320, Math.min(4096, Math.round(request.maxSide ?? 960)))
      const run = await runCliTool('img-tool', ['text', safePath, '--max-side', String(maxSide)], {
        timeoutMs: 180_000,
      })
      if (!run.ok) return { ok: false, message: run.message ?? '本地识别失败。' }

      try {
        const answer = JSON.parse(run.stdout) as {
          text?: string
          lines?: Array<{ text: string; confidence: number; box: unknown }>
          engine?: string
          width?: number
          height?: number
        }
        return {
          ok: true,
          text: answer.text ?? '',
          lines: Array.isArray(answer.lines) ? answer.lines : [],
          ...(typeof answer.engine === 'string' ? { engine: answer.engine } : {}),
          ...(typeof answer.width === 'number' ? { width: answer.width } : {}),
          ...(typeof answer.height === 'number' ? { height: answer.height } : {}),
        }
      } catch {
        return { ok: false, message: '本地识别没有返回可读的结果。' }
      }
    },
  )
}
