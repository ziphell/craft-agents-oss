/**
 * Transport-layer interfaces for the WS-based RPC.
 */

import type { PushTarget, ConnectedClientInfo } from '@craft-agent/shared/protocol'

export interface RequestContext {
  clientId: string
  workspaceId: string | null
  webContentsId: number | null
}

export type HandlerFn = (ctx: RequestContext, ...args: any[]) => Promise<any> | any

export interface RpcServer {
  handle(channel: string, handler: HandlerFn): void
  push(channel: string, target: PushTarget, ...args: any[]): void
  invokeClient(clientId: string, channel: string, ...args: any[]): Promise<any>
  /**
   * The same request with an explicit reply deadline. Used by long-running device calls
   * (`client:device:exec`), where the default deadline would cut the answer off while the
   * device is still working. Optional: implementations may fall back to the default.
   */
  invokeClientWithTimeout?(clientId: string, channel: string, args: any[], timeoutMs: number): Promise<any>
  updateClientWorkspace?(clientId: string, workspaceId: string): void

  /** Whether a connected client advertised the given capability on handshake. */
  hasClientCapability(clientId: string, capability: string): boolean

  /**
   * Connected clients (optionally narrowed) that advertised the capability.
   *
   * `workspaceId` matches a client registered for that workspace. App-level device links register
   * without a workspace — they serve every workspace of the machine, naming one per request — so
   * they are only matched when `includeWorkspaceAgnostic` is set. `deviceId` narrows to one
   * machine's links (a window and that machine's device link share it).
   */
  findClientsWithCapability(capability: string, opts?: {
    workspaceId?: string
    deviceId?: string
    includeWorkspaceAgnostic?: boolean
  }): string[]

  /** Stable device identity of a connected client (`null` when it did not send one). */
  getClientDeviceId?(clientId: string): string | null

  /** Snapshot of connected clients (server implementations only). */
  getConnectedClients?(): ConnectedClientInfo[]

  /** Whether the client runs on the server's own machine (server implementations only). */
  isLocalClient?(clientId: string): boolean
}

export interface RpcClient {
  invoke(channel: string, ...args: any[]): Promise<any>
  on(channel: string, callback: (...args: any[]) => void): () => void
  handleCapability(channel: string, handler: (...args: any[]) => Promise<any> | any): void
}

export type EventSink = (channel: string, target: PushTarget, ...args: any[]) => void
