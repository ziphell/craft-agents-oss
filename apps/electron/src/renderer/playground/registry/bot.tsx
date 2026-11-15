import * as React from 'react'
import type { ComponentEntry } from './types'
import type { BotTask, BotTaskResult } from '@craft-agent/shared/protocol'
import { PanelRight } from 'lucide-react'
import { WorkbenchRail } from '@/components/app-shell/bot/WorkbenchRail'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'

/**
 * The assistant's workbench rail, with the three shapes a card can have: a running graph with
 * progress, a running conversation, and finished work with files. It is here because the rail is
 * mostly *spacing and hierarchy* — the one thing that cannot be read out of the JSX.
 */

const now = Date.now()

const tasks: BotTask[] = [
  {
    kind: 'task',
    sessionId: 's-running-graph',
    name: 'Refresh the pricing page copy',
    workspaceId: 'ws',
    workspaceName: 'my-workspace',
    state: 'running',
    startedAt: now - 12 * 60_000,
    lastMessageAt: now - 40_000,
    slug: 'refresh-pricing-copy',
    runId: 'run-1',
    progress: { done: 3, total: 5 },
  },
  {
    kind: 'session',
    sessionId: 's-running-session',
    name: 'Collect the competitor screenshots',
    workspaceId: 'ws',
    workspaceName: 'my-workspace',
    state: 'running',
    startedAt: now - 3 * 60_000,
    lastMessageAt: now - 10_000,
  },
  {
    kind: 'session',
    sessionId: 's-done',
    name: 'Draft the release notes for 0.9',
    workspaceId: 'ws',
    workspaceName: 'my-workspace',
    state: 'idle',
    startedAt: now - 90 * 60_000,
    lastMessageAt: now - 62 * 60_000,
  },
  {
    kind: 'task',
    sessionId: 's-done-graph',
    name: 'Audit the onboarding emails',
    workspaceId: 'ws',
    workspaceName: 'my-workspace',
    state: 'idle',
    startedAt: now - 26 * 3600_000,
    lastMessageAt: now - 25 * 3600_000,
    slug: 'audit-onboarding-emails',
    progress: { done: 4, total: 4 },
  },
]

// Enough finished work to push past the rail's cap, so the folded row is visible in the story.
for (let i = 0; i < 7; i++) {
  tasks.push({
    kind: 'session',
    sessionId: `s-old-${i}`,
    name: `Background sweep ${i + 1}`,
    workspaceId: 'ws',
    workspaceName: 'my-workspace',
    state: 'idle',
    startedAt: now - (30 + i * 6) * 3600_000,
    lastMessageAt: now - (30 + i * 6) * 3600_000,
  })
}

const results: Record<string, BotTaskResult> = {
  's-running-graph': {
    task: tasks[0],
    isProcessing: true,
    lastText: 'Rewrote the hero and the three plan blurbs; checking the comparison table against the current feature list.',
    artifacts: [],
  },
  's-running-session': {
    task: tasks[1],
    isProcessing: true,
    lastText: 'Saved six screenshots into research/competitors/.',
    artifacts: [],
  },
  's-done': {
    task: tasks[2],
    isProcessing: false,
    lastText: 'Wrote RELEASE-0.9.md: the reply-to-message work, the workbench, and the two build fixes. Left the A2A section out — it is still parked.',
    artifacts: [
      { path: '/tmp/RELEASE-0.9.md', title: 'RELEASE-0.9.md', format: 'md', exists: true },
      { path: '/tmp/changelog.json', title: 'changelog.json', format: 'json', exists: true },
    ],
  },
  's-done-graph': {
    task: tasks[3],
    isProcessing: false,
    lastText: 'Four of the five emails still open with the old positioning; the welcome email is the one that works.',
    artifacts: [{ path: '/tmp/onboarding-audit.md', title: 'onboarding-audit.md', format: 'md', exists: true }],
  },
}

function Preview() {
  return (
    <div className="flex h-[560px] w-full justify-end bg-background">
      <div className="flex w-[320px] flex-col overflow-clip rounded-[12px] bg-background shadow-middle">
        <header className="flex h-[42px] shrink-0 items-center gap-2 pl-3 pr-2">
          <span className="text-[13px] font-medium text-foreground">Workbench</span>
          <span className="text-[11px] tabular-nums text-foreground/35">10</span>
        </header>
        <WorkbenchRail
          tasks={tasks}
          results={results}
          onOpen={() => {}}
          onStop={() => {}}
          onOpenFile={() => {}}
          onOpenArchive={() => {}}
        />
      </div>
    </div>
  )
}

function EmptyPreview() {
  return (
    <div className="flex h-[320px] w-full justify-end bg-background">
      <div className="flex w-[320px] flex-col overflow-clip rounded-[12px] bg-background shadow-middle">
        <header className="flex h-[42px] shrink-0 items-center gap-2 pl-3 pr-2">
          <span className="text-[13px] font-medium text-foreground">Workbench</span>
        </header>
        <WorkbenchRail
          tasks={[]}
          results={{}}
          onOpen={() => {}}
          onStop={() => {}}
          onOpenFile={() => {}}
          onOpenArchive={() => {}}
        />
      </div>
    </div>
  )
}

/**
 * The assistant's header row, at the same 42px the real one is. What it is here to prove: a title
 * that is **not** a dropdown (no chevron, no session verbs), the two badges that belong to an
 * assistant, and a right-hand side with exactly one button in it.
 */
function HeaderPreview() {
  return (
    <div className="w-[900px] overflow-hidden rounded-lg border border-border bg-background">
      <PanelHeader
        title="Craft Bot"
        badge={(
          <span className="ml-1 flex items-center gap-1.5">
            <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-[1px] text-[10.5px] font-medium tabular-nums text-amber-700 dark:text-amber-300">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              2 running
            </span>
          </span>
        )}
        actions={(
          <PanelHeaderCenterButton
            icon={(
              <span className="flex items-center gap-1">
                <PanelRight className="h-4 w-4" />
                <span className="text-[10.5px] tabular-nums text-amber-700 dark:text-amber-300">3</span>
              </span>
            )}
            tooltip="Open the workbench"
          />
        )}
      />
      <div className="h-24 bg-background" />
    </div>
  )
}

function HeaderQuietPreview() {
  return (
    <div className="w-[900px] overflow-hidden rounded-lg border border-border bg-background">
      <PanelHeader
        title="Craft Bot"
        badge={(
          <span className="ml-1">
            <span className="rounded-full bg-amber-500/15 px-1.5 py-[1px] text-[10.5px] text-amber-700 dark:text-amber-300">
              Explore
            </span>
          </span>
        )}
        actions={(
          <PanelHeaderCenterButton icon={<PanelRight className="h-4 w-4" />} tooltip="Open the workbench" />
        )}
      />
      <div className="h-24 bg-background" />
    </div>
  )
}

export const botComponents: ComponentEntry[] = [
  {
    id: 'bot-header',
    name: 'Assistant header',
    category: 'Chat',
    description: 'Title that is not a menu, the running count, and one button on the right.',
    component: HeaderPreview,
    props: [],
    layout: 'top',
    previewOverflow: 'visible',
  },
  {
    id: 'bot-header-quiet',
    name: 'Assistant header (quiet)',
    category: 'Chat',
    description: 'Nothing running, workspace in Explore mode — the one badge worth keeping.',
    component: HeaderQuietPreview,
    props: [],
    layout: 'top',
    previewOverflow: 'visible',
  },
  {
    id: 'workbench-rail',
    name: 'Workbench rail',
    category: 'Chat',
    description: 'The assistant’s workbench: running and finished work, with the files each produced.',
    component: Preview,
    props: [],
    layout: 'top',
    previewOverflow: 'visible',
  },
  {
    id: 'workbench-rail-empty',
    name: 'Workbench rail (empty)',
    category: 'Chat',
    description: 'What the workbench looks like before anything has been started.',
    component: EmptyPreview,
    props: [],
    layout: 'top',
    previewOverflow: 'visible',
  },
]
