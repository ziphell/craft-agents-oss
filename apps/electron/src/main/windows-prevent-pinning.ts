/**
 * Keep the standalone browser window out of the taskbar's "Pin to taskbar" menu.
 *
 * Windows lists "Pin to taskbar" for any window that owns a taskbar button. The
 * only thing that drops that entry is the window property
 * `System.AppUserModel.PreventPinning`, and Electron does not expose it — its
 * `BrowserWindow.setAppDetails()` covers only `appId` and the relaunch properties
 * (see `AppDetailsOptions` in electron.d.ts, and docs/browser-taskbar-plan.md).
 * So the property is written here, through the Win32 `IPropertyStore` directly.
 *
 * Windows-only and best-effort by design: every other platform is a no-op, koffi
 * is loaded lazily so non-Windows builds never touch it, and a failure must never
 * stop a window from being created — hence the try/catch that only logs. The
 * caller runs this *before* `setAppDetails({ appId })`, which is the order Windows
 * expects; the other way round the property is ignored.
 */

import type { BrowserWindow } from 'electron'
import { mainLog } from './logger'

/** `IID_IPropertyStore` — {886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99}. */
const IID_IPROPERTYSTORE = guid(0x886d8eeb, 0x8cf2, 0x4446, [0x8d, 0x02, 0xcd, 0xba, 0x1d, 0xbd, 0xcf, 0x99])

/** `PKEY_AppUserModel_PreventPinning` — fmtid {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, pid 9. */
const PKEY_PREVENT_PINNING = propertyKey(
  guid(0x9f4c2855, 0x9f79, 0x4b39, [0xa8, 0xd0, 0xe1, 0xd4, 0x2d, 0xe1, 0xd5, 0xf3]),
  9,
)

/** `VT_BOOL`, whose true value is `VARIANT_TRUE` (-1, i.e. 0xFFFF). */
const VT_BOOL = 11
const VARIANT_TRUE = 0xffff

/**
 * Slots in an `IPropertyStore` vtable: `IUnknown` takes 0–2
 * (QueryInterface / AddRef / Release), then the store itself is
 * GetCount / GetAt / GetValue / SetValue / Commit at 3–7.
 */
const RELEASE_SLOT = 2
const SET_VALUE_SLOT = 6
const COMMIT_SLOT = 7

/** S_OK / E_FAIL, as HRESULTs are what these calls answer with. */
const S_OK = 0
const E_FAIL = 0x80004005

function guid(data1: number, data2: number, data3: number, data4: number[]): Buffer {
  const buf = Buffer.alloc(16)
  buf.writeUInt32LE(data1 >>> 0, 0)
  buf.writeUInt16LE(data2, 4)
  buf.writeUInt16LE(data3, 6)
  Buffer.from(data4).copy(buf, 8)
  return buf
}

/** A `PROPERTYKEY`: a 16-byte GUID followed by its property id. */
function propertyKey(fmtid: Buffer, pid: number): Buffer {
  const buf = Buffer.alloc(20)
  fmtid.copy(buf, 0)
  buf.writeUInt32LE(pid >>> 0, 16)
  return buf
}

/** A 16-byte `PROPVARIANT` carrying a boolean (its payload starts at offset 8). */
function boolPropVariant(value: boolean): Buffer {
  const buf = Buffer.alloc(16)
  buf.writeUInt16LE(VT_BOOL, 0)
  buf.writeUInt16LE(value ? VARIANT_TRUE : 0, 8)
  return buf
}

type Native = {
  /** Writes the property on the window behind `hwnd`. Returns an HRESULT. */
  setPreventPinning(hwnd: bigint): number
}

let native: Native | null = null

/**
 * Load koffi and bind the one Win32 call + the three `IPropertyStore` slots this
 * needs. Kept behind a lazy singleton so the native module is required once, and
 * only when a Windows window actually asks for it.
 */
function loadNative(): Native {
  if (native) return native

  const koffi = require('koffi') as typeof import('koffi')
  const shell32 = koffi.load('shell32.dll')

  // HRESULT SHGetPropertyStoreForWindow(HWND hwnd, REFIID riid, void **ppv).
  const shGetPropertyStoreForWindow = shell32.func(
    'int32 __stdcall SHGetPropertyStoreForWindow(void *hwnd, void *riid, void *ppv)',
  )

  const setValueProto = koffi.proto('int32 SetValue(void *self, void *key, void *value)')
  const commitProto = koffi.proto('int32 Commit(void *self)')
  const releaseProto = koffi.proto('uint32 Release(void *self)')

  // COM methods are reached through the object's vtable: the store is a pointer to
  // a pointer to an array of function pointers, and each slot is called with the
  // object itself as the leading `this` argument.
  const callSlot = (vtable: bigint, slot: number, proto: ReturnType<typeof koffi.proto>, ...args: unknown[]): number =>
    koffi.call(koffi.decode(vtable, 'void *', slot + 1)[slot] as bigint, proto, ...args)

  native = {
    setPreventPinning(hwnd: bigint): number {
      const storeHolder = Buffer.alloc(8)
      const open = shGetPropertyStoreForWindow(hwnd, IID_IPROPERTYSTORE, storeHolder)
      if (open !== S_OK) return open

      const store = storeHolder.readBigUInt64LE(0)
      if (store === 0n) return E_FAIL

      let vtable: bigint
      try {
        vtable = koffi.decode(store, 'void *') as bigint
        const set = callSlot(vtable, SET_VALUE_SLOT, setValueProto, store, PKEY_PREVENT_PINNING, boolPropVariant(true))
        if (set !== S_OK) return set
        return callSlot(vtable, COMMIT_SLOT, commitProto, store)
      } finally {
        callSlot(vtable!, RELEASE_SLOT, releaseProto, store)
      }
    },
  }

  return native
}

/**
 * Make the window non-pinnable on Windows. A no-op elsewhere, and never throws:
 * a failure is logged and the window carries on (it still gets its own taskbar
 * button and icon — only the "Pin to taskbar" entry would remain).
 */
export function preventTaskbarPinning(win: BrowserWindow): void {
  if (process.platform !== 'win32') return

  try {
    const handle = win.getNativeWindowHandle()
    if (!handle || handle.length === 0) return

    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))
    if (hwnd === 0n) return

    const hr = loadNative().setPreventPinning(hwnd)
    if (hr !== S_OK) {
      mainLog.warn(`[browser-pane] PreventPinning not applied hr=0x${(hr >>> 0).toString(16)}`)
    }
  } catch (error) {
    mainLog.warn(`[browser-pane] PreventPinning threw: ${error instanceof Error ? error.message : String(error)}`)
  }
}
