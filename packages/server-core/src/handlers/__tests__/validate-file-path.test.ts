import { describe, it, expect } from 'bun:test'
import { homedir, tmpdir } from 'os'
import { join, sep } from 'path'
import { validateFilePath, resolveWorkspacePath } from '../utils'

const home = homedir()
const tmp = tmpdir()

describe('validateFilePath', () => {
  it('allows paths inside home directory', async () => {
    const path = join(home, 'Documents', 'test.txt')
    const result = await validateFilePath(path)
    expect(result).toContain('test.txt')
  })

  it('allows paths inside temp directory', async () => {
    const path = join(tmp, 'craft-test.txt')
    const result = await validateFilePath(path)
    expect(result).toContain('craft-test.txt')
  })

  it('denies paths outside all allowed directories', async () => {
    // Use a path that's definitely outside home and tmp on any platform
    const path = sep === '\\' ? 'Z:\\forbidden\\test.txt' : '/forbidden/test.txt'
    await expect(validateFilePath(path)).rejects.toThrow('Access denied')
  })

  it('allows a drive-relative /tmp path on Windows', async () => {
    // `/tmp/x` is rooted at the current drive on Windows, so it names `<drive>:\tmp\x` — the
    // junction the app creates to the temp directory (or that folder itself).
    if (sep !== '\\') return
    await expect(validateFilePath('/tmp/craft-test.txt')).resolves.toContain('craft-test.txt')
  })

  it('allows paths inside additionalAllowedDirs', async () => {
    const projectDir = sep === '\\' ? 'D:\\Projects\\myapp' : '/opt/projects/myapp'
    const path = join(projectDir, 'src', 'main.ts')
    const result = await validateFilePath(path, [projectDir])
    expect(result).toContain('main.ts')
  })

  it('still allows homedir paths when additionalAllowedDirs are provided', async () => {
    const path = join(home, 'test.txt')
    const result = await validateFilePath(path, ['/some/other/dir'])
    expect(result).toContain('test.txt')
  })

  it('compares paths case-insensitively on Windows', async () => {
    // Windows folders are case-insensitive: a path whose case differs from the
    // allowed dir must still be allowed.
    if (sep !== '\\') return
    const path = join(home.toUpperCase(), 'test.txt')
    const result = await validateFilePath(path)
    expect(result.toLowerCase()).toContain('test.txt')
  })

  it('blocks sensitive files even inside allowed dirs', async () => {
    const path = join(home, '.ssh', 'id_rsa')
    await expect(validateFilePath(path)).rejects.toThrow('sensitive')
  })

  it('sensitive patterns match Windows backslash separators', () => {
    // Verify the regex patterns used in validateFilePath match both / and \
    const sshPatternUnix = /\.ssh[\\/]/
    const sshPatternWindows = /\.ssh[\\/]/
    expect(sshPatternUnix.test('C:\\Users\\me\\.ssh\\id_rsa')).toBe(true)
    expect(sshPatternWindows.test('/home/me/.ssh/id_rsa')).toBe(true)
    expect(/\.gnupg[\\/]/.test('C:\\Users\\me\\.gnupg\\keys')).toBe(true)
    expect(/\.aws[\\/]credentials/.test('C:\\Users\\me\\.aws\\credentials')).toBe(true)
  })

  it('blocks .env files', async () => {
    const path = join(home, 'project', '.env')
    await expect(validateFilePath(path)).rejects.toThrow('sensitive')
  })

  it('blocks credentials.json', async () => {
    const path = join(home, 'project', 'credentials.json')
    await expect(validateFilePath(path)).rejects.toThrow('sensitive')
  })

  it('blocks .pem files even inside additionalAllowedDirs', async () => {
    const projectDir = join(home, 'project')
    const path = join(projectDir, 'server.pem')
    await expect(validateFilePath(path, [projectDir])).rejects.toThrow('sensitive')
  })

  it('expands tilde paths', async () => {
    const result = await validateFilePath('~/test-file.txt')
    expect(result).toContain(home)
  })

  it('rejects relative paths', async () => {
    await expect(validateFilePath('relative/path.txt')).rejects.toThrow('absolute')
  })

  it('filters out falsy values in additionalAllowedDirs', async () => {
    const path = join(home, 'test.txt')
    // Should not throw even with undefined/empty values in the array
    const result = await validateFilePath(path, ['', undefined as unknown as string])
    expect(result).toContain('test.txt')
  })
})

describe('resolveWorkspacePath', () => {
  it('leaves an absolute path exactly as it was', () => {
    const path = join(home, 'notes', 'plan.md')
    expect(resolveWorkspacePath(path, 'no-such-workspace')).toBe(path)
  })

  it('expands a tilde path the way the boundary check does', () => {
    expect(resolveWorkspacePath('~/notes.md', 'no-such-workspace')).toBe(join(home, 'notes.md'))
  })

  it('leaves a relative path alone when there is no workspace to resolve it against', () => {
    expect(resolveWorkspacePath('docs/plan.md')).toBe('docs/plan.md')
    expect(resolveWorkspacePath('docs/plan.md', 'no-such-workspace')).toBe('docs/plan.md')
  })
})
