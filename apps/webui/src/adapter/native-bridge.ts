/**
 * Native shell bridge — 安卓壳注入的页面侧适配。
 *
 * 壳在页面脚本执行前通过 WebViewCompat.addWebMessageListener 注入 `window.craftBridge`
 * （只对该服务器的 origin 生效），并通过 `window.__craftNativeDispatch` 投递原生事件。
 * 普通浏览器标签页里既没有 bridge 也没有监听器，这里的全部逻辑都是惰性的。
 */

export interface NativeBridgeMessage {
  type: string
  [key: string]: unknown
}

interface CraftBridge {
  postMessage(message: string): void
  onmessage?: ((event: MessageEvent) => void) | null
}

type BridgeWindow = Window & {
  craftBridge?: CraftBridge
  __craftNativeDispatch?: (message: unknown) => void
}

type NotificationNavigateListener = (data: { workspaceId: string; sessionId: string }) => void
type ForegroundListener = (foreground: boolean) => void

const messageListeners = new Set<(message: NativeBridgeMessage) => void>()
const foregroundListeners = new Set<ForegroundListener>()
const navigateListeners = new Set<NotificationNavigateListener>()

let installed = false
let historyTrackingInstalled = false
let historyStack: string[] = []
let historyIndex = -1
let foreground = true
/** 页面还没订阅点击导航时先存下最近一次，避免通知点击在 React 挂载前丢失。 */
let pendingNavigate: { workspaceId: string; sessionId: string } | null = null

function host(): BridgeWindow | null {
  return typeof window === 'undefined' ? null : (window as BridgeWindow)
}

function bridge(): CraftBridge | undefined {
  return host()?.craftBridge
}

function parseMessage(raw: unknown): NativeBridgeMessage | null {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as NativeBridgeMessage) : null
    } catch {
      return null
    }
  }
  if (raw && typeof raw === 'object' && typeof (raw as { type?: unknown }).type === 'string') {
    return raw as NativeBridgeMessage
  }
  return null
}

function deliver(message: NativeBridgeMessage) {
  if (message.type === 'foreground') {
    const next = message.foreground === true
    if (next === foreground) return
    foreground = next
    foregroundListeners.forEach((listener) => listener(next))
    return
  }

  // 安卓壳的返回/前进按钮：交给 SPA 自己的 history，由 popstate 驱动界面。
  if (message.type === 'navigateBack') {
    history.back()
    return
  }
  if (message.type === 'navigateForward') {
    history.forward()
    return
  }

  if (message.type === 'notificationNavigate') {
    const data = {
      workspaceId: typeof message.workspaceId === 'string' ? message.workspaceId : '',
      sessionId: typeof message.sessionId === 'string' ? message.sessionId : '',
    }
    if (navigateListeners.size === 0) {
      pendingNavigate = data
      return
    }
    navigateListeners.forEach((listener) => listener(data))
    return
  }

  messageListeners.forEach((listener) => listener(message))
}

function install() {
  if (installed) return
  const shell = bridge()
  const page = host()
  if (!shell || !page) return
  installed = true
  shell.onmessage = (event: MessageEvent) => {
    const message = parseMessage(event.data)
    if (message) deliver(message)
  }
  page.__craftNativeDispatch = (raw: unknown) => {
    const message = parseMessage(raw)
    if (message) deliver(message)
  }
  installHistoryTracking()
  // 告诉壳页面已就绪，壳会回推当前前台状态。
  shell.postMessage(JSON.stringify({ type: 'ready' }))
}

/**
 * 把 SPA 的历史位置告诉安卓壳。
 *
 * WebView 的原生 canGoBack 不追踪 react-router 式的 pushState；壳的后退按钮需要这份状态
 * 才能置灰/点亮。Craft 的 NavigationContext 把 seq 写进 history.state，seq > 0 即还能后退。
 */
function installHistoryTracking() {
  if (historyTrackingInstalled) return
  historyTrackingInstalled = true
  historyStack = [window.location.href]
  historyIndex = 0

  const pushState = history.pushState.bind(history)
  const replaceState = history.replaceState.bind(history)
  history.pushState = ((...args: Parameters<History['pushState']>) => {
    pushState(...args)
    historyStack = historyStack.slice(0, historyIndex + 1)
    historyStack.push(window.location.href)
    historyIndex = historyStack.length - 1
    notifyNavigationState()
  }) as History['pushState']
  history.replaceState = ((...args: Parameters<History['replaceState']>) => {
    replaceState(...args)
    if (historyIndex >= 0 && historyIndex < historyStack.length) {
      historyStack[historyIndex] = window.location.href
    }
    notifyNavigationState()
  }) as History['replaceState']
  window.addEventListener('popstate', () => {
    syncHistoryIndex()
    notifyNavigationState()
  })
  notifyNavigationState()
}

/**
 * 浏览器只告诉页面「当前 URL」，不告诉方向；后退/前进一次只走一格，
 * 所以比较相邻两条就能定位。多步跳转或外部改动时以当前 URL 重建。
 */
function syncHistoryIndex() {
  const url = window.location.href
  const previous = historyIndex > 0 ? historyStack[historyIndex - 1] : null
  const next = historyIndex + 1 < historyStack.length ? historyStack[historyIndex + 1] : null
  if (previous === url) {
    historyIndex -= 1
    return
  }
  if (next === url) {
    historyIndex += 1
    return
  }
  historyStack = historyStack.slice(0, Math.max(0, historyIndex + 1))
  historyStack.push(url)
  historyIndex = historyStack.length - 1
}

function notifyNavigationState() {
  if (!bridge()) return
  postToNative({
    type: 'navigationState',
    canGoBack: historyIndex > 0,
    canGoForward: historyIndex >= 0 && historyIndex < historyStack.length - 1,
  })
}

export function hasNativeBridge(): boolean {
  install()
  return !!bridge()
}

export function postToNative(message: NativeBridgeMessage): boolean {
  const shell = bridge()
  if (!shell) return false
  try {
    shell.postMessage(JSON.stringify(message))
    return true
  } catch {
    return false
  }
}

export function nativeForeground(): boolean {
  return foreground
}

export function onNativeForegroundChange(listener: ForegroundListener): () => void {
  foregroundListeners.add(listener)
  // 订阅时补一次当前值，页面重新挂载后不用等下一次 onResume。
  listener(foreground)
  return () => {
    foregroundListeners.delete(listener)
  }
}

export function onNativeNotificationNavigate(listener: NotificationNavigateListener): () => void {
  navigateListeners.add(listener)
  if (pendingNavigate) {
    const data = pendingNavigate
    pendingNavigate = null
    setTimeout(() => listener(data), 0)
  }
  return () => {
    navigateListeners.delete(listener)
  }
}
