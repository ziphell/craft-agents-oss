/**
 * `ical-tool read|create|filter` — a calendar file as events, and events as a calendar file.
 *
 * Replaces the Python tool of the same name (`resources/scripts/ical_tool.py`, kept as the
 * reference) without pulling in an ICS library: what a calendar exchange needs here is a small,
 * well-defined slice of RFC 5545, and a dependency for it would be one more thing to keep alive on
 * every host. The subset, stated so nobody is surprised:
 *
 * - **Read**: `VEVENT` only, with `UID`, `SUMMARY`, `DESCRIPTION`, `LOCATION`, `DTSTART`, `DTEND`,
 *   `RRULE`, `STATUS`, `ORGANIZER` and `ATTENDEE`. `RRULE` is passed through as text — this tool
 *   never expands a recurrence, and a reader that did would be a calendar application.
 * - **Write**: the same fields back, in UTC (`…Z`) when the input carried a zone, as a floating
 *   local time when it did not, and date-only for an all-day event.
 * - Not here: `VALARM`, timezones as `VTIMEZONE` components, attachments, and recurrence
 *   exceptions. A file that has them reads fine — those properties are simply not answered.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { emit, fail, flag, parseArgs, text } from './args'

const USAGE = `Usage:
  ical-tool read <file> [--format json|text] [-o <output>]
  ical-tool create --data <json|path> [--cal-name <name>] [-o <output>]
  ical-tool filter <file> --start <iso> --end <iso> [--format json|text|ics] [-o <output>]

Read, write and date-filter .ics calendar files.`

interface IcsEvent {
  uid?: string
  summary: string
  description?: string
  location?: string
  start?: string
  end?: string
  recurrence?: string
  status?: string
  organizer?: string
  attendees?: string[]
}

/** One unfolded property: `NAME;PARAM=value:the text`. */
interface Property {
  name: string
  params: Record<string, string>
  value: string
}

function unfold(raw: string): string[] {
  // RFC 5545 folds long lines with a space or tab after the break; the fold is not content.
  return raw.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
}

function parseProperty(line: string): Property | null {
  const colon = line.indexOf(':')
  if (colon < 0) return null
  const left = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const [name, ...params] = left.split(';')
  const map: Record<string, string> = {}
  for (const param of params) {
    const eq = param.indexOf('=')
    if (eq > 0) map[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1)
  }
  return { name: (name ?? '').toUpperCase(), params: map, value }
}

const unescapeText = (value: string): string =>
  value.replace(/\\[nN]/g, '\n').replace(/\\([,;\\])/g, '$1')

const escapeText = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')

/**
 * An ICS date value as an ISO string.
 *
 * `20240315T090000Z` → `2024-03-15T09:00:00Z`; without the `Z` it is a floating local time and keeps
 * no zone; `20240315` is an all-day date and stays a date. An unparseable value is returned as it
 * was written rather than guessed at.
 */
function isoOf(value: string): string {
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value)
  if (!dateTime) return value
  const [, y, m, d, hh, mm, ss, z] = dateTime
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}${z ? 'Z' : ''}`
}

/** An ISO string back to an ICS value, keeping the three shapes apart. */
function icsOf(iso: string): string {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (dateOnly) return `${dateOnly[1]}${dateOnly[2]}${dateOnly[3]}`
  const dateTime = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/.exec(iso)
  if (!dateTime) throw new Error(`not an ISO date: ${iso}`)
  const [, y, m, d, hh, mm, ss, zone] = dateTime
  // `Z` is written as UTC; an offset is converted to UTC, because a `VTIMEZONE` this tool does not
  // write is what a local time with an offset would need.
  if (zone && zone !== 'Z') {
    const utc = new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss ?? '00'}${zone}`)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${utc.getUTCFullYear()}${pad(utc.getUTCMonth() + 1)}${pad(utc.getUTCDate())}T${pad(utc.getUTCHours())}${pad(utc.getUTCMinutes())}${pad(utc.getUTCSeconds())}Z`
  }
  return `${y}${m}${d}T${hh}${mm}${ss ?? '00'}${zone ?? ''}`
}

function readEvents(raw: string): IcsEvent[] {
  const events: IcsEvent[] = []
  let current: Partial<IcsEvent> | null = null
  for (const line of unfold(raw)) {
    const property = parseProperty(line)
    if (!property) continue
    if (property.name === 'BEGIN' && property.value.toUpperCase() === 'VEVENT') {
      current = { attendees: [] }
      continue
    }
    if (property.name === 'END' && property.value.toUpperCase() === 'VEVENT') {
      if (current) events.push({ summary: '', ...current } as IcsEvent)
      current = null
      continue
    }
    if (!current) continue
    switch (property.name) {
      case 'UID':
        current.uid = property.value
        break
      case 'SUMMARY':
        current.summary = unescapeText(property.value)
        break
      case 'DESCRIPTION':
        current.description = unescapeText(property.value)
        break
      case 'LOCATION':
        current.location = unescapeText(property.value)
        break
      case 'DTSTART':
        current.start = isoOf(property.value)
        break
      case 'DTEND':
        current.end = isoOf(property.value)
        break
      case 'RRULE':
        current.recurrence = property.value
        break
      case 'STATUS':
        current.status = property.value
        break
      case 'ORGANIZER':
        current.organizer = property.value.replace(/^mailto:/i, '')
        break
      case 'ATTENDEE':
        current.attendees = [...(current.attendees ?? []), property.value.replace(/^mailto:/i, '')]
        break
    }
  }
  return events
}

function textReport(events: IcsEvent[]): string {
  if (!events.length) return 'No events.'
  return events
    .map((event) => {
      const when = event.start ?? '(no start)'
      const until = event.end ? ` → ${event.end}` : ''
      const where = event.location ? `\n    Where: ${event.location}` : ''
      const who = event.attendees?.length ? `\n    Attendees: ${event.attendees.join(', ')}` : ''
      const repeats = event.recurrence ? `\n    Recurrence: ${event.recurrence}` : ''
      const body = event.description ? `\n    ${event.description.replace(/\n/g, '\n    ')}` : ''
      return `${when}${until}  ${event.summary}${where}${who}${repeats}${body}`
    })
    .join('\n\n')
}

function asIcs(events: IcsEvent[], name = 'Calendar'): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Craft Agent//ical-tool//EN',
    `X-WR-CALNAME:${escapeText(name)}`,
  ]
  for (const event of events) {
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${event.uid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}@craft-agent`}`)
    lines.push(`DTSTAMP:${icsOf(new Date().toISOString().replace(/\.\d+Z$/, 'Z'))}`)
    lines.push(`SUMMARY:${escapeText(event.summary || 'Untitled')}`)
    if (event.start) lines.push(`DTSTART:${icsOf(event.start)}`)
    if (event.end) lines.push(`DTEND:${icsOf(event.end)}`)
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`)
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`)
    if (event.recurrence) lines.push(`RRULE:${event.recurrence}`)
    if (event.status) lines.push(`STATUS:${event.status}`)
    if (event.organizer) lines.push(`ORGANIZER:mailto:${event.organizer}`)
    for (const attendee of event.attendees ?? []) lines.push(`ATTENDEE:mailto:${attendee}`)
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return `${lines.join('\r\n')}\r\n`
}

/** Events whose span touches `[start, end]`; an event with no start is kept — it cannot be placed. */
function within(events: IcsEvent[], start: string, end: string): IcsEvent[] {
  const from = Date.parse(start)
  const to = Date.parse(end.length === 10 ? `${end}T23:59:59` : end)
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error('--start and --end take ISO dates')
  return events.filter((event) => {
    if (!event.start) return true
    const at = Date.parse(event.start.length === 10 ? `${event.start}T00:00:00` : event.start)
    const until = event.end ? Date.parse(event.end.length === 10 ? `${event.end}T23:59:59` : event.end) : at
    return Number.isNaN(at) || (until >= from && at <= to)
  })
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2))
  const command = parsed.positional[0]?.toLowerCase()

  if (parsed.flags.help || !command) {
    process.stdout.write(`${USAGE}\n`)
    process.exit(parsed.flags.help ? 0 : 1)
  }

  const format = text(parsed, 'format') ?? 'text'
  const output = text(parsed, 'output')

  try {
    if (command === 'read' || command === 'filter') {
      const file = parsed.positional[1]
      if (!file) fail(`${command} needs a file.`)
      const path = resolve(file)
      if (!existsSync(path)) fail(`No such file: ${path}`)
      let events = readEvents(readFileSync(path, 'utf-8'))
      if (command === 'filter') {
        const start = text(parsed, 'start')
        const end = text(parsed, 'end')
        if (!start || !end) fail('filter needs `--start <iso>` and `--end <iso>`.')
        events = within(events, start, end)
      }
      emit(
        output,
        format === 'json'
          ? JSON.stringify(events, null, 2)
          : format === 'ics'
            ? asIcs(events)
            : textReport(events),
      )
      return
    }

    if (command === 'create') {
      const data = text(parsed, 'data')
      if (!data) fail('create needs `--data <json>`: an array of events, inline or as a file path.')
      const inline = /^\s*\[/.test(data)
      const source = inline ? data : readFileSync(resolve(data), 'utf-8')
      const events = JSON.parse(source) as IcsEvent[]
      if (!Array.isArray(events)) fail('The JSON must be an array of event objects.')
      emit(output, asIcs(events, text(parsed, 'cal-name') ?? 'My Calendar'))
      return
    }

    fail(`No such command: ${command}. Try read, create or filter.`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

main()
