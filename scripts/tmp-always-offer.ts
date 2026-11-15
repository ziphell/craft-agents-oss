import { readFileSync, writeFileSync } from 'node:fs'

const path = 'apps/electron/src/main/hub-connection.ts'
const raw = readFileSync(path, 'utf8')
const crlf = raw.includes('\r\n')
let src = raw.split('\r\n').join('\n')

const steps: Array<[string, string]> = [
  [
    ` * The second reason needs no switch. What a machine lends is the folder list saved on that
 * connection: an empty list lends nothing, so the link advertises nothing and the hub binds no
 * device. Whether the pairing is for windows or for tool use is the invite's business (the token's
 * scope), and whether this hub may use a machine that lends is decided on the hub.`,
    ` * Connecting is offering: every link advertises this machine's tools, and the folder list only
 * bounds where those tools may work (empty means its own per-hub working directory). Whether the
 * hub actually uses them is decided there, and whether the pairing may open windows is the
 * invite's business.`,
  ],
  [
    `    // Capabilities are fixed at handshake, so the offer is decided here: no folders, nothing lent.
    // A link that lends nothing still connects — workspace creation and other control-plane
    // requests ride it — and the hub simply has no device to list.
    const allowedRoots = connection.allowedRoots ?? []
    const lends = allowedRoots.length > 0
    const identity = connectionDeps.identity()
    // What this link offers is its own folder list — never this install's workspace list. The
    // folders may have been picked from those workspaces, but only the saved entries are lent.
    const clientInfo = { ...identity, allowedRoots: lends ? allowedRoots : [] }`,
    `    // Capabilities are fixed at handshake: this machine is a device for this hub, and the folder
    // list says where it may work. It is not the offer — an empty list means its own per-hub
    // working directory, which is where a call without `cwd` lands.
    const allowedRoots = connection.allowedRoots ?? []
    const identity = connectionDeps.identity()
    // What this link offers is its own folder list — never this install's workspace list. The
    // folders may have been picked from those workspaces, but only the saved entries are added.
    const clientInfo = { ...identity, allowedRoots }`,
  ],
  [
    `      clientCapabilities: lends ? [...DEVICE_CAPABILITIES] : [],`,
    `      clientCapabilities: [...DEVICE_CAPABILITIES],`,
  ],
  [
    `    if (lends) {
      attachDeviceCapabilities(client, connectionDeps.browserPaneManager, connection.id, allowedRoots)
    }`,
    `    attachDeviceCapabilities(client, connectionDeps.browserPaneManager, connection.id, allowedRoots)`,
  ],
  [
    `    mainLog.info(\`[hub] link opened to \${connection.url} (\${connection.name}, lending \${allowedRoots.length} folders)\`)`,
    `    mainLog.info(\`[hub] link opened to \${connection.url} (\${connection.name}, \${allowedRoots.length} extra folders)\`)`,
  ],
]

for (const [from, to] of steps) {
  if (!src.includes(from)) throw new Error('not found: ' + from.slice(0, 60))
  src = src.replace(from, to)
}

writeFileSync(path, crlf ? src.split('\n').join('\r\n') : src, 'utf8')
console.log('lends left:', src.includes('lends'))
