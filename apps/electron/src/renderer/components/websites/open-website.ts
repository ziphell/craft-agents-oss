/**
 * Open a website where a page belongs — a tab of the workspace's browser window.
 *
 * A website is a real page at an **origin of its own**, so it is never framed in
 * the app: every entry point (a card click, a session's websites menu) registers
 * the origin so it answers, asks for a new tab, points it there, and brings it up.
 * A window that is already open gets a real new tab; one that is not yet open
 * opens *into* the blank tab it already holds, so nothing is opened beside a blank
 * tab and what someone is reading is never replaced.
 */
export async function openWebsiteInWindow(workspaceId: string, websiteSlug: string): Promise<void> {
  const origin = await window.electronAPI.getWebsiteOrigin(workspaceId, websiteSlug)
  const instanceId = await window.electronAPI.browserPane.create({ show: true, newTab: true })
  await window.electronAPI.browserPane.navigate(instanceId, origin)
  await window.electronAPI.browserPane.focus(instanceId)
}
