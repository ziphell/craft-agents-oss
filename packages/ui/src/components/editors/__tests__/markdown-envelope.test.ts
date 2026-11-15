import { describe, expect, it } from 'bun:test'
import { buildFrontmatterRaw, frontmatterInner, parseDocText, serializeDocText } from '../markdown-envelope'

const SKILL = `---
name: daily-digest
description: Summarise the day's mail
---

# 日报

正文。
`

describe('the envelope', () => {
  it('takes the frontmatter off, and gives it back', () => {
    const envelope = parseDocText(SKILL)
    expect(envelope.frontmatter).toBe('---\nname: daily-digest\ndescription: Summarise the day\'s mail\n---\n\n')
    expect(envelope.body.startsWith('# 日报')).toBe(true)
    expect(serializeDocText(envelope, envelope.body)).toBe(SKILL)
  })

  it('keeps a body with no frontmatter untouched', () => {
    const envelope = parseDocText('# 标题\n')
    expect(envelope.frontmatter).toBe('')
    expect(envelope.body).toBe('# 标题\n')
  })

  it('does not mistake a horizontal rule further down for a fence', () => {
    const source = '# 标题\n\n---\n\n正文\n'
    const envelope = parseDocText(source)
    expect(envelope.frontmatter).toBe('')
    expect(envelope.body).toBe(source)
  })

  it('leaves an unclosed fence alone', () => {
    const source = '---\nname: x\n\n# 标题\n'
    const envelope = parseDocText(source)
    expect(envelope.frontmatter).toBe('')
    expect(envelope.body).toBe(source)
  })

  it('remembers CRLF, the trailing newline and a BOM', () => {
    const source = '\uFEFF---\nname: x\n---\n\n# 标题'
    const envelope = parseDocText(source)
    expect(envelope.eol).toBe('\n')
    expect(envelope.trailingNewline).toBe(false)
    expect(envelope.bom).toBe(true)
    expect(serializeDocText(envelope, envelope.body)).toBe(source)

    const crlf = '---\r\nname: x\r\n---\r\n\r\n# 标题\r\n'
    const crlfEnvelope = parseDocText(crlf)
    expect(crlfEnvelope.eol).toBe('\r\n')
    expect(serializeDocText(crlfEnvelope, crlfEnvelope.body)).toBe(crlf)
  })

  it('edits the YAML through the envelope, and can remove it', () => {
    const envelope = parseDocText(SKILL)
    expect(frontmatterInner(envelope.frontmatter)).toBe("name: daily-digest\ndescription: Summarise the day's mail")

    const renamed = buildFrontmatterRaw("name: other\ndescription: x")
    expect(renamed).toBe('---\nname: other\ndescription: x\n---\n\n')
    expect(buildFrontmatterRaw('   ')).toBe('')
    expect(serializeDocText({ ...envelope, frontmatter: renamed }, envelope.body)).toStartWith('---\nname: other')
  })
})

describe('editing the properties, not the document', () => {
  const file = '---\nname: daily-digest\n---\n\n# 日报\n\n正文。\n'

  it('leaves the body byte-identical, so nothing the editor holds changes', () => {
    const envelope = parseDocText(file)
    const next = serializeDocText(
      { ...envelope, frontmatter: buildFrontmatterRaw('name: other\ndescription: 新的') },
      envelope.body,
    )
    expect(parseDocText(next).body).toBe(envelope.body)
    expect(next).toBe('---\nname: other\ndescription: 新的\n---\n\n# 日报\n\n正文。\n')
  })

  it('and removing it leaves a file with no envelope at all', () => {
    const envelope = parseDocText(file)
    const next = serializeDocText({ ...envelope, frontmatter: buildFrontmatterRaw('  ') }, envelope.body)
    expect(next).toBe('# 日报\n\n正文。\n')
    expect(parseDocText(next).frontmatter).toBe('')
  })
})
