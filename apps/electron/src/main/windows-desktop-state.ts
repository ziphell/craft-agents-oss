/**
 * What Windows will let this process do to another process's window.
 *
 * Two questions, both cheap enough to ask per action:
 *
 * 1. **Integrity.** UIPI drops posted input aimed at a higher-integrity window, and the accessibility
 *    proxy cannot be relied on across that boundary either. Comparing the target token's RID with
 *    this process's own turns "the click said ok and did nothing" into a refusal the agent can act
 *    on. `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` is enough to read a token even when the
 *    process runs at High, so the answer is available before the driver tries to act.
 * 2. **Input desktop.** UAC and the lock screen run on a desktop other than `Default`. A user-session
 *    process cannot read or drive that desktop; asking which desktop currently receives input is how
 *    a UAC prompt is named instead of being mistaken for an idle app.
 *
 * `koffi` is loaded lazily: the manager is also built on macOS and Linux, and a build without
 * Windows never pays for the FFI. Every call fails closed to "unknown" rather than throwing into a
 * tool call — a probe that cannot answer must not take the desktop away by itself.
 */

import type { LibraryHandle } from 'koffi'

export type IntegrityName =
  | 'untrusted'
  | 'low'
  | 'medium'
  | 'medium-plus'
  | 'high'
  | 'system'

export type ProcessIntegrity =
  | { kind: 'level'; rid: number; name: IntegrityName }
  /** Windows refused to let this app inspect the process (usually because it is protected). */
  | { kind: 'denied' }
  | { kind: 'unknown'; error: string }
  | { kind: 'unsupported' }

export interface InputDesktopState {
  /** The desktop that currently receives input, when Windows answered. */
  name: string | null
  /** True when it is not the interactive `Default` desktop (UAC, lock screen, …). */
  secure: boolean
  /** Why the name is missing, when it is. */
  error?: string
}

type NativeCall = ReturnType<LibraryHandle['func']>

interface Native {
  koffi: typeof import('koffi')
  OpenProcess: NativeCall
  OpenProcessToken: NativeCall
  GetTokenInformation: NativeCall
  GetSidSubAuthorityCount: NativeCall
  GetSidSubAuthority: NativeCall
  CloseHandle: NativeCall
  OpenInputDesktop: NativeCall
  GetUserObjectInformationW: NativeCall
  CloseDesktop: NativeCall
}

const DESKTOP_READOBJECTS = 0x0001
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const TOKEN_QUERY = 0x0008
const TOKEN_INTEGRITY_LEVEL = 25
const UOI_NAME = 2
/** A `TOKEN_MANDATORY_LABEL` is a SID pointer + attributes; 256 bytes covers any SID Windows returns. */
const TOKEN_INFO_BYTES = 256
const DESKTOP_NAME_BYTES = 512

let native: Native | null | undefined

/**
 * Bind the Win32 calls this module needs, once.
 *
 * `null` means "this platform has no answer" — a macOS build, a stripped runtime without koffi, or
 * a host where the DLLs did not load. Callers treat that as "no preflight" rather than a failure.
 */
function loadNative(): Native | null {
  if (native !== undefined) return native
  if (process.platform !== 'win32') {
    native = null
    return null
  }
  try {
    const koffi = require('koffi') as typeof import('koffi')
    const kernel32 = koffi.load('kernel32.dll')
    const advapi32 = koffi.load('advapi32.dll')
    const user32 = koffi.load('user32.dll')
    native = {
      koffi,
      OpenProcess: kernel32.func('void * __stdcall OpenProcess(uint32, bool, uint32)'),
      OpenProcessToken: advapi32.func('bool __stdcall OpenProcessToken(void *, uint32, void *)'),
      GetTokenInformation: advapi32.func(
        'bool __stdcall GetTokenInformation(void *, int, void *, uint32, void *)',
      ),
      GetSidSubAuthorityCount: advapi32.func('void * __stdcall GetSidSubAuthorityCount(void *)'),
      GetSidSubAuthority: advapi32.func('void * __stdcall GetSidSubAuthority(void *, uint32)'),
      CloseHandle: kernel32.func('bool __stdcall CloseHandle(void *)'),
      OpenInputDesktop: user32.func('void * __stdcall OpenInputDesktop(uint32, bool, uint32)'),
      GetUserObjectInformationW: user32.func(
        'bool __stdcall GetUserObjectInformationW(void *, int, void *, uint32, void *)',
      ),
      CloseDesktop: user32.func('bool __stdcall CloseDesktop(void *)'),
    }
  } catch {
    native = null
  }
  return native
}

function failure(api: Native, call: string): ProcessIntegrity {
  const code = api.koffi.errno()
  // 5 = ERROR_ACCESS_DENIED. A process this app may not even open is the one case where "cannot
  // inspect" is itself evidence of a protection boundary worth refusing across.
  if (code === 5) return { kind: 'denied' }
  return { kind: 'unknown', error: `${call} failed (${code})` }
}

/** The integrity RID of a process, read from its token. */
export function readProcessIntegrity(pid: number): ProcessIntegrity {
  if (process.platform !== 'win32') return { kind: 'unsupported' }
  const api = loadNative()
  if (!api) return { kind: 'unknown', error: 'koffi is unavailable' }
  if (!Number.isInteger(pid) || pid <= 0) return { kind: 'unknown', error: 'invalid pid' }

  const processHandle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!processHandle) return failure(api, 'OpenProcess')
  try {
    const tokenOut = Buffer.alloc(8)
    if (!api.OpenProcessToken(processHandle, TOKEN_QUERY, tokenOut)) {
      return failure(api, 'OpenProcessToken')
    }
    const token = tokenOut.readBigUInt64LE(0)
    if (token === 0n) return { kind: 'unknown', error: 'OpenProcessToken returned no token' }
    try {
      const info = Buffer.alloc(TOKEN_INFO_BYTES)
      const needed = Buffer.alloc(4)
      if (!api.GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, info, info.length, needed)) {
        return failure(api, 'GetTokenInformation')
      }
      const sid = info.readBigUInt64LE(0)
      if (sid === 0n) return { kind: 'unknown', error: 'the token has no integrity SID' }
      const countPtr = api.GetSidSubAuthorityCount(sid)
      if (!countPtr) return { kind: 'unknown', error: 'the integrity SID has no subauthorities' }
      const count = Number(api.koffi.decode(countPtr, 'uint8'))
      if (!Number.isInteger(count) || count < 1) {
        return { kind: 'unknown', error: 'the integrity SID is empty' }
      }
      const ridPtr = api.GetSidSubAuthority(sid, count - 1)
      if (!ridPtr) return { kind: 'unknown', error: 'the integrity SID has no RID' }
      const rid = Number(api.koffi.decode(ridPtr, 'uint32'))
      return { kind: 'level', rid, name: integrityName(rid) }
    } finally {
      api.CloseHandle(token)
    }
  } finally {
    api.CloseHandle(processHandle)
  }
}

/**
 * The desktop that currently receives input.
 *
 * `secure` is true for anything that is not `Default` — the Winlogon desktop behind UAC and the
 * lock screen is the one this app must not pretend to drive. A failed `OpenInputDesktop` is also
 * treated as secure: on the default desktop it succeeds, so a refusal is the honest answer.
 */
export function readInputDesktop(): InputDesktopState {
  if (process.platform !== 'win32') return { name: null, secure: false }
  const api = loadNative()
  if (!api) return { name: null, secure: false }

  const handle = api.OpenInputDesktop(0, false, DESKTOP_READOBJECTS)
  if (!handle) {
    return {
      name: null,
      secure: true,
      error: `OpenInputDesktop failed (${api.koffi.errno()})`,
    }
  }
  try {
    const buffer = Buffer.alloc(DESKTOP_NAME_BYTES)
    const needed = Buffer.alloc(4)
    if (!api.GetUserObjectInformationW(handle, UOI_NAME, buffer, buffer.length, needed)) {
      return {
        name: null,
        secure: true,
        error: `GetUserObjectInformationW failed (${api.koffi.errno()})`,
      }
    }
    const bytes = needed.readUInt32LE(0)
    const name = buffer.toString('utf16le', 0, Math.max(0, bytes - 2))
    if (!name) return { name: null, secure: true, error: 'the input desktop has no name' }
    return { name, secure: name.toLowerCase() !== 'default' }
  } finally {
    api.CloseDesktop(handle)
  }
}

/** The RID Windows documents for each integrity level. */
export function integrityName(rid: number): IntegrityName {
  if (rid >= 0x4000) return 'system'
  if (rid >= 0x3000) return 'high'
  if (rid >= 0x2100) return 'medium-plus'
  if (rid >= 0x2000) return 'medium'
  if (rid >= 0x1000) return 'low'
  return 'untrusted'
}

/** Whether `target` sits above `self` on Windows' integrity ladder. */
export function isHigherIntegrity(target: ProcessIntegrity, self: ProcessIntegrity): boolean {
  return target.kind === 'level' && self.kind === 'level' && target.rid > self.rid
}

/** A sentence for a status line or a refusal. */
export function describeProcessIntegrity(value: ProcessIntegrity): string {
  switch (value.kind) {
    case 'level':
      return `${value.name} integrity (RID 0x${value.rid.toString(16)})`
    case 'denied':
      return 'an integrity level Windows would not disclose'
    case 'unknown':
      return `an unknown integrity level (${value.error})`
    case 'unsupported':
      return 'an unsupported platform'
  }
}
