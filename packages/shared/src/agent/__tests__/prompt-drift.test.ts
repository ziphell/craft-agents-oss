/**
 * Prompt-drift notices: the classification, the wording, and the once-per-kind rule.
 *
 * The point of these tests is the *advice*: a pinned instruction can only be applied by a
 * new session, while a pinned file can simply be read — so a notice that lumps them
 * together is wrong for one of them, whichever way it is worded.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { ProjectPromptContext } from '../../projects/types.ts';
import {
  PROMPT_DRIFT_ORDER,
  PromptDriftNotices,
  collectPromptDrift,
  formatPromptDriftNotice,
} from '../core/prompt-drift.ts';

const MEMORY_PATH = '/ws/projects/a/MEMORY.md';
const ASSETS_PATH = '/ws/projects/a/assets';

function project(over: Partial<ProjectPromptContext> = {}): ProjectPromptContext {
  return {
    name: 'a',
    assetsPath: ASSETS_PATH,
    assets: [],
    designs: [],
    memoryPath: MEMORY_PATH,
    memoryContent: 'top of the file',
    ...over,
  };
}

function inputs(over: Partial<Parameters<typeof collectPromptDrift>[0]> = {}) {
  return {
    currentPreferencesPrompt: 'prefs',
    pinnedPreferencesPrompt: 'prefs',
    currentIncludeCoAuthoredBy: true,
    pinnedIncludeCoAuthoredBy: true,
    currentProject: null,
    pinnedProject: null,
    ...over,
  };
}

describe('collectPromptDrift', () => {
  it('reports nothing when the live inputs still match the snapshot', () => {
    expect(collectPromptDrift(inputs({ currentProject: project(), pinnedProject: project() }))).toEqual([]);
  });

  it('reports the parts of the project block separately, not as one blob', () => {
    expect(collectPromptDrift(inputs({
      currentProject: project({ memoryContent: 'newer' }),
      pinnedProject: project(),
    }))).toEqual(['project-memory']);

    expect(collectPromptDrift(inputs({
      currentProject: project({ assets: [{ filename: 'x.png', mimeType: 'image/png', sizeBytes: 3 }] }),
      pinnedProject: project(),
    }))).toEqual(['project-assets']);

    expect(collectPromptDrift(inputs({
      currentProject: project({ details: 'rewritten' }),
      pinnedProject: project(),
    }))).toEqual(['project-details']);
  });

  it('reports a change to the project-bound designs', () => {
    expect(collectPromptDrift(inputs({
      currentProject: project({ designs: [{ name: 'Cart', slug: 'cart', kind: 'prototype' }] }),
      pinnedProject: project(),
    }))).toEqual(['project-designs']);

    // A rename is drift even though the slug (the identity) did not change.
    expect(collectPromptDrift(inputs({
      currentProject: project({ designs: [{ name: 'Basket', slug: 'cart', kind: 'prototype' }] }),
      pinnedProject: project({ designs: [{ name: 'Cart', slug: 'cart', kind: 'prototype' }] }),
    }))).toEqual(['project-designs']);
  });

  it('compares the asset manifest by field, so a same-size replacement still counts', () => {
    const before = [{ filename: 'a.png', mimeType: 'image/png', sizeBytes: 10 }];
    const after = [{ filename: 'b.png', mimeType: 'image/png', sizeBytes: 10 }];
    expect(collectPromptDrift(inputs({
      currentProject: project({ assets: after }),
      pinnedProject: project({ assets: before }),
    }))).toEqual(['project-assets']);
  });

  it('describes a binding change as one notice, not as every field that consequently differs', () => {
    expect(collectPromptDrift(inputs({ currentProject: project(), pinnedProject: null })))
      .toEqual(['project-bound']);
    expect(collectPromptDrift(inputs({ currentProject: null, pinnedProject: project() })))
      .toEqual(['project-unbound']);
  });

  it('treats a co-author value that was never pinned as no drift', () => {
    expect(collectPromptDrift(inputs({ pinnedIncludeCoAuthoredBy: null }))).toEqual([]);
  });

  it('reports instruction drift alongside a file change', () => {
    expect(collectPromptDrift(inputs({
      currentPreferencesPrompt: 'changed',
      currentProject: project({ memoryContent: 'newer' }),
      pinnedProject: project(),
    }))).toEqual(['preferences', 'project-memory']);
  });
});

describe('formatPromptDriftNotice', () => {
  it('sends instruction drift to a new session, matching the Claude path word for word', () => {
    expect(formatPromptDriftNotice('preferences'))
      .toBe('Note: Your preferences changed since this session started. Start a new session to apply changes.');
  });

  it('sends project-file drift to the file instead of a new session', () => {
    const memory = formatPromptDriftNotice('project-memory', { memoryPath: MEMORY_PATH });
    expect(memory).toContain(MEMORY_PATH);
    // The whole reason this notice exists: the file is readable in place.
    expect(memory).not.toContain('Start a new session');

    const assets = formatPromptDriftNotice('project-assets', { assetsPath: ASSETS_PATH });
    expect(assets).toContain(ASSETS_PATH);
    expect(assets).not.toContain('Start a new session');
  });

  it('names the path for an unbound-to-bound session, where the block is missing entirely', () => {
    expect(formatPromptDriftNotice('project-bound', { memoryPath: MEMORY_PATH })).toContain(MEMORY_PATH);
  });
});

describe('PromptDriftNotices', () => {
  it('announces each kind once, in canonical order', () => {
    const notices = new PromptDriftNotices();
    expect(notices.take(['project-memory', 'preferences'])).toEqual(['preferences', 'project-memory']);
    expect(notices.take(['preferences', 'project-memory'])).toEqual([]);
    expect(notices.take(['project-assets'])).toEqual(['project-assets']);
  });

  it('starts over when the session re-pins', () => {
    const notices = new PromptDriftNotices();
    notices.take(['project-memory']);
    notices.reset();
    expect(notices.take(['project-memory'])).toEqual(['project-memory']);
  });

  it('keeps the canonical order complete', () => {
    const notices = new PromptDriftNotices();
    expect(notices.take([...PROMPT_DRIFT_ORDER].reverse())).toEqual([...PROMPT_DRIFT_ORDER]);
  });
});

describe('PiAgent prompt-drift notices', () => {
  const agents: PiAgent[] = [];
  function makeAgent(): any {
    const agent = new PiAgent({
      provider: 'pi', isHeadless: true,
      workspace: { id: 'pi-drift-test', name: 'Test', rootPath: '/tmp/pi-drift-test' } as any,
    });
    agents.push(agent);
    (agent as any).ensureSubprocess = async () => {};
    (agent as any).send = (msg: any) => {
      if (msg.type === 'prompt') (agent as any).handleSubprocessEvent({ type: 'agent_end', messages: [] });
    };
    return agent;
  }
  afterEach(() => { for (const agent of agents.splice(0)) agent.destroy(); });

  async function collect(stream: AsyncIterable<any>): Promise<any[]> {
    const events: any[] = [];
    for await (const event of stream) events.push(event);
    return events;
  }
  const infos = (events: any[]) => events.filter(e => e.type === 'info').map(e => e.message);

  it('tells the user a new session is needed, once, when preferences moved under the pin', async () => {
    const agent = makeAgent();
    (agent as any).pinnedPreferencesPrompt = 'stale';

    expect(infos(await collect(agent.chatImpl('hi'))))
      .toEqual(['Note: Your preferences changed since this session started. Start a new session to apply changes.']);
    // Still drifted on the next turn, and deliberately not repeated.
    expect(infos(await collect(agent.chatImpl('again')))).toEqual([]);
  });
});
