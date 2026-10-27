/**
 * 浏览器版 WebUI 的退出登录：清掉服务端的会话 cookie，回到登录页。
 * Electron 里没有这个入口（那边是退出 App），安卓壳里也没有（那边是回服务器列表）。
 */
export async function logOutWebUI(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
  } finally {
    window.location.href = '/login'
  }
}
