/**
 * Attach a file that already lives on the hub's filesystem.
 *
 * A remote window's workspace is on the server, so the useful file is often already there.
 * Reading it through `file:readBinary` (REMOTE_ELIGIBLE) puts the bytes through the same
 * `FileAttachment` shape a local pick produces, which is what lets the rest of the pipeline
 * (preview, store, send) stay unaware of where the file came from.
 *
 * `fromServer` is what keeps the two apart afterwards: `path` is a server path, so draft
 * persistence must not later hand it to the local disk reader.
 */

import type { FileAttachment } from '../../shared/types'

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  log: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/typescript',
  py: 'text/x-python',
  xml: 'text/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'csv', 'log', 'html', 'css', 'js', 'ts', 'tsx', 'jsx',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'xml', 'yaml', 'yml',
  'toml', 'sh', 'sql', 'conf', 'ini', 'cfg',
])

const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])

function inferKind(fileName: string): { type: FileAttachment['type']; mimeType: string } {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  const mimeType = MIME_BY_EXT[ext] ?? 'application/octet-stream'
  if (mimeType.startsWith('image/')) return { type: 'image', mimeType }
  if (ext === 'pdf') return { type: 'pdf', mimeType }
  if (OFFICE_EXTENSIONS.has(ext)) return { type: 'office', mimeType }
  if (TEXT_EXTENSIONS.has(ext) || mimeType.startsWith('text/')) return { type: 'text', mimeType }
  return { type: 'unknown', mimeType }
}

/** Chunked base64 — `String.fromCharCode(...bytes)` blows the stack on large files. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)))
  }
  return btoa(binary)
}

export async function readServerAttachment(path: string): Promise<FileAttachment> {
  const bytes = await window.electronAPI.readFileBinary(path)
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as unknown as ArrayBuffer)
  const name = path.split(/[\\/]/).pop() || path
  const { type, mimeType } = inferKind(name)

  return {
    type,
    path,
    name,
    mimeType,
    base64: toBase64(data),
    size: data.byteLength,
    fromServer: true,
  }
}
