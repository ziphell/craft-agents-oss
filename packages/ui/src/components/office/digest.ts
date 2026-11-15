/**
 * A file's content, as one comparable string.
 *
 * Office documents are bytes rather than text, so "did this change?" cannot be answered by holding
 * the document and comparing — an editor's buffer and the file are not the same kind of thing. It is
 * answered by reading the file and hashing it, which is what both the overlay's document hook and
 * the read-only block in a conversation do before deciding that something happened on disk.
 *
 * SHA-256 through `crypto.subtle` when the window has it. A Web UI opened over a LAN address is
 * **not a secure context**, so `crypto.subtle` is undefined there; change detection does not need a
 * cryptographic hash, only a stable one, so that case falls back to a 64-bit FNV-style mix over the
 * bytes. Same answer for the same file, which is the only property the callers use.
 */
export async function digest(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const hashed = await subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
    return [...new Uint8Array(hashed)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let index = 0; index < bytes.length; index += 1) {
    a = Math.imul(a ^ bytes[index]!, 16777619)
    b = Math.imul(b ^ bytes[index]!, 2246822519)
  }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}-${bytes.length.toString(16)}`
}
