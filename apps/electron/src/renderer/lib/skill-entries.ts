/**
 * A skill's **entry**: the automations that run it on its own.
 *
 * A playbook is a skill plus an entry — a matcher whose prompt mentions it with
 * `[skill:slug]` (see `docs/playbooks-plan.md`). "Has an entry" is **computed here, at
 * display time**, from `automations.json`: never stored, so it cannot go stale, and the
 * skill file carries no marker to keep in sync.
 *
 * `parseMentions` is the same parser the agent side resolves `[skill:slug]` with, so a
 * mention counted here is a mention that will actually fire. (`@slug` does not fire one;
 * it only pre-enables the skill's `requiredSources` — hence the bracket form.)
 *
 * Only **enabled** matchers count: an automation that is off does not run the skill, and
 * a skill that is not run on its own should not say that it is.
 */

import { parseMentions } from '@craft-agent/shared/mentions'
import type { AutomationListItem } from '@/components/automations/types'

/** The enabled automations whose prompt mentions `skillSlug`. */
export function entriesForSkill(
  automations: AutomationListItem[],
  skillSlug: string,
): AutomationListItem[] {
  return automations.filter(
    (automation) =>
      automation.enabled &&
      automation.actions.some(
        (action) =>
          action.type === 'prompt' &&
          parseMentions(action.prompt, [skillSlug], []).skills.includes(skillSlug),
      ),
  )
}

/** Which of `skillSlugs` some enabled automation mentions. */
export function skillSlugsWithEntries(
  automations: AutomationListItem[],
  skillSlugs: string[],
): Set<string> {
  const withEntries = new Set<string>()
  for (const automation of automations) {
    if (!automation.enabled) continue
    for (const action of automation.actions) {
      if (action.type !== 'prompt') continue
      for (const slug of parseMentions(action.prompt, skillSlugs, []).skills) {
        withEntries.add(slug)
      }
    }
  }
  return withEntries
}
