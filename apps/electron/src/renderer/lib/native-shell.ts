/**
 * 安卓 WebView 壳（apps/android）暴露的最小原生能力。
 *
 * 壳在页面脚本执行前注入 `window.craftBridge`；普通浏览器标签页和 Electron
 * 里没有这个对象，所以这里的检测为 false，调用也都是空操作。
 */
interface CraftNativeBridge {
  postMessage(message: string): void
}

function nativeBridge(): CraftNativeBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { craftBridge?: CraftNativeBridge }).craftBridge
}

/** 是否运行在安卓壳里：用来显示只有壳才有的菜单项。 */
export const isNativeShell = typeof nativeBridge()?.postMessage === 'function'

/** 离开 WebUI，回到 App 的服务器列表。 */
export function openServerList(): boolean {
  const bridge = nativeBridge()
  if (!bridge) return false
  try {
    bridge.postMessage(JSON.stringify({ type: 'openServerList' }))
    return true
  } catch {
    return false
  }
}
