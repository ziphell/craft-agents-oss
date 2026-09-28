import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createWebsite, getWebsitePath } from '../storage'
import {
  EXPORT_README_FILENAME,
  exportWebsite,
  isWebsiteExportPath,
  listWebsiteExportFiles,
} from '../export'

let root = ''
let slug = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-website-export-'))
  const created = createWebsite(root, { name: 'Build health', content: '<!doctype html><title>t</title>' })
  slug = created.slug

  // A site with more than one file, plus the app's own bookkeeping beside it.
  const dir = getWebsitePath(root, slug)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'app.css'), 'body{}')
  writeFileSync(join(dir, 'about.html'), '<!doctype html>')
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'data', 'snapshot.json'), '{"kv":{}}')
  writeFileSync(join(dir, 'data', 'store.sqlite'), 'not-a-real-database')
  writeFileSync(join(dir, 'thumbnail.jpg'), 'not-a-real-jpeg')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('isWebsiteExportPath', () => {
  it('keeps the site and drops what the app keeps about it', () => {
    expect(isWebsiteExportPath('index.html')).toBe(true)
    expect(isWebsiteExportPath('assets/app.css')).toBe(true)
    expect(isWebsiteExportPath('about.html')).toBe(true)

    expect(isWebsiteExportPath('website.json')).toBe(false)
    expect(isWebsiteExportPath('thumbnail.jpg')).toBe(false)
    expect(isWebsiteExportPath('data/store.sqlite')).toBe(false)
    expect(isWebsiteExportPath('')).toBe(false)
  })

  // The site's own data: its scripts read it at this path, so a copy has to carry it.
  it('carries the site’s published data, but not the store that writes it', () => {
    expect(isWebsiteExportPath('data/snapshot.json')).toBe(true)
  })

  // Same rule the origin serves by, so a copy holds exactly what the app showed.
  it('keeps a name that only looks like the app’s when it is not at the root', () => {
    expect(isWebsiteExportPath('assets/website.json')).toBe(true)
  })
})

describe('listWebsiteExportFiles', () => {
  it('lists the site’s files, nested ones included, in a stable order', () => {
    const files = listWebsiteExportFiles(getWebsitePath(root, slug))

    expect(files).toEqual(['about.html', 'assets/app.css', 'data/snapshot.json', 'index.html'])
  })
})

describe('exportWebsite', () => {
  it('copies the site into its own folder in the destination', () => {
    const dest = mkdtempSync(join(tmpdir(), 'craft-export-dest-'))
    try {
      const result = exportWebsite(root, slug, dest)

      expect(result.files).toBe(4)
      expect(result.dir).toBe(join(dest, slug))
      expect(readFileSync(join(result.dir, 'index.html'), 'utf-8')).toContain('<title>t</title>')
      expect(readFileSync(join(result.dir, 'assets', 'app.css'), 'utf-8')).toBe('body{}')

      // The app's own bookkeeping does not travel: it means nothing without the app, and
      // the store is the site's private working file.
      expect(existsSync(join(result.dir, 'website.json'))).toBe(false)
      expect(existsSync(join(result.dir, 'thumbnail.jpg'))).toBe(false)
      expect(existsSync(join(result.dir, 'data', 'store.sqlite'))).toBe(false)

      // What does travel is the site's data — a copy that dropped it would be a site whose
      // own scripts fetch nothing.
      expect(readFileSync(join(result.dir, 'data', 'snapshot.json'), 'utf-8')).toBe('{"kv":{}}')
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })

  // The one thing a file listing cannot say, and the one thing that otherwise looks
  // like a broken site: root-absolute paths need a server, not a double-click.
  it('writes the note that says it has to be served', () => {
    const dest = mkdtempSync(join(tmpdir(), 'craft-export-dest-'))
    try {
      const result = exportWebsite(root, slug, dest)
      const readme = readFileSync(join(result.dir, EXPORT_README_FILENAME), 'utf-8')

      expect(readme).toContain('Build health')
      expect(readme).toContain('http.server')
      // Where the data comes from is the other thing a receiver cannot guess.
      expect(readme).toContain('data/snapshot.json')
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })

  // A half-overwritten export leaves neither the old copy nor the new one intact.
  it('refuses to write over an export that is already there', () => {
    const dest = mkdtempSync(join(tmpdir(), 'craft-export-dest-'))
    try {
      exportWebsite(root, slug, dest)

      expect(() => exportWebsite(root, slug, dest)).toThrow(/already exists/)
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })

  it('refuses a website that does not exist', () => {
    const dest = mkdtempSync(join(tmpdir(), 'craft-export-dest-'))
    try {
      expect(() => exportWebsite(root, 'no-such-website', dest)).toThrow(/not found/)
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })
})
