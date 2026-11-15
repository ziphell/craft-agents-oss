// The probe's "host page": it must answer before the editor's first call, so the listener lives in
// the preload (a page-side listener installs too late and every early call waits its 30 s).
const { ipcRenderer } = require('electron')

window.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.protocol !== 'craft-office/1') return
  if (data.type !== 'call') return
  const id = data.id
  const reply = (message) => {
    try {
      event.source.postMessage(message, '*')
    } catch (error) {
      console.log('[probe-preload] reply failed', String(error))
    }
  }
  void ipcRenderer
    .invoke('probe-answer', data.method, data.args)
    .then((value) => reply({ protocol: 'craft-office/1', type: 'result', id, ok: true, value }))
    .catch((error) =>
      reply({ protocol: 'craft-office/1', type: 'result', id, ok: false, error: String((error && error.message) || error) }),
    )
})
