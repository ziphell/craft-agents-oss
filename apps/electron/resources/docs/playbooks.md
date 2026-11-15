# Playbooks

A **playbook** is a set of steps for a site or an account somebody works in — saved so the same job can be run again. It **is a skill**: the same `SKILL.md`, read before it runs, in the same three places. What it adds is an **entry**, so it can also start on its own, and a habit: you keep it current.

Read `skills.md` for the SKILL.md format, and `automations.md` before touching `automations.json`.

## Nothing is saved unless the person asks

Doing a job is just doing it — from what is in the conversation, with nothing written down. A playbook exists because somebody asked for one: *"keep this so we don't have to figure it out again"*, *"save that as a playbook"*.

So the default is **no file**. When they ask, you draft one (below). Never save on your own initiative.

## You run it — and you keep it current

The steps are instructions, not a script. Follow them with judgment. When a step does not match the page, decide which of the three it is:

| What happened | What you do | The file |
|---|---|---|
| **A one-off** — a slow request, a flake, a different button label today | get through it | **do not touch it** |
| **The page changed** — the thing the step names is gone | work out the new way | **fix it, and say what you changed** |
| **Somebody has to fix it first** — a signed-out session, a permission, a CAPTCHA | **stop, and say what is blocking you** | **do not touch it** |

A one-off is not evidence. Only a change that is really about the page goes back into the file — otherwise the file drifts into something nobody wrote.

And a stop is not a failure to hide: a session that has been signed out will never sign itself back in, so retrying only delays the moment somebody has to be told. **Never edit a step around a block you did not understand** — that is how a playbook learns the wrong thing.

**A run that cannot write does not pretend otherwise.** A scheduled playbook runs at `--permission-mode safe`, where the record is writable and the steps are not (step 4) — so when *the page changed*, such a run says so in the conversation — "step 3's button is gone; the one that does that now is …" — and leaves the file for somebody who is there. The record still shows it either way: the anchor keeps the old time it had.

## Where it lives

```
{workspace}/skills/{slug}/SKILL.md    the steps — a skill; read before execution
{workspace}/automations.json          the entry (optional)
```

## The entry

Optional. Without one, the playbook is a skill somebody can ask for by name. With one, it also starts on its own.

An entry is a matcher whose prompt contains `[skill:slug]` — create it with the CLI:

```bash
craft-agent automation create --event SchedulerTick --cron "0 9 * * 1-5" \
  --prompt "[skill:weekly-export] Run the weekly export." --permission-mode safe
```

What that writes into `automations.json`:

```json
{
  "automations": {
    "SchedulerTick": [
      {
        "cron": "0 9 * * 1-5",
        "permissionMode": "safe",
        "actions": [
          { "type": "prompt", "prompt": "[skill:weekly-export] Run the weekly export." }
        ]
      }
    ]
  }
}
```

**The bracket form is the whole mechanism.** Write `[skill:slug]` — that is what makes the skill be read and applied. `@slug` does **not** work: an automation's `@name` only pre-enables the skill's `requiredSources`.

The matcher lives in `automations.json`; where the `craft-agent` CLI is available it is the writer for that file (`craft-agent automation create …`), and where it is not — the CLI is an optional part of the build — write the entry into `automations.json` directly and check it with `config_validate({ target: "automations" })`. Either way, add it **only with the person's agreement**: it is their configuration, and a scheduled entry acts while they are not there. `--permission-mode` is where they grant that. Check `automations.md` first.

**An entry is for steps that are safe to repeat.** If the job submits something, orders something, or leaves a copy behind every time it runs, it wants somebody to press the button — say that instead of adding a schedule.

## Saving one

### 1. The record

If you did the job in this session, the record is already there: your own `browser_tool` commands and their results, in the conversation.

If the person demonstrated it themselves, they will have recorded it — and a recording leaves **two files side by side**:

```
20261003-162759.mp4           the film
20261003-162759.events.jsonl  what happened, one JSON object per line
```

Read the `.events.jsonl`; leave the film alone unless a step makes no sense without seeing it. Every line carries `ms` — milliseconds from the moment the recording started — so what happened when is never a guess:

```json
{"type":"start","startedAt":1791016079940,"tabId":"tab-1"}
{"ms":1240,"type":"navigate","url":"https://admin.example.com/orders"}
{"ms":1680,"type":"click","target":{"tag":"button","role":"button","name":"导出"}}
{"ms":2100,"type":"fill","target":{"tag":"input","role":"textbox","name":"Search"},"value":"U23 国足"}
{"ms":2400,"type":"request","method":"POST","url":".../api/export","status":200,"resourceType":"xhr"}
{"ms":8430,"type":"stop","seconds":8}
```

**Most of it is noise, and the file does not pretend otherwise.** One measured demonstration — a search and two clicks — came to 175 lines, five of them navigations; the rest were images, scripts and third-party beacons. The skeleton is the `navigate` / `click` / `fill` lines, and the `request` lines are what a step can be checked against. You do the deciding; the recorder only reported.

A `fill` line carries what was typed, so a step can say what was searched for. **One exception, and it is not yours to overrule**: a field that says it is a secret — `type=password`, or an `autocomplete` naming a credential — is recorded by its name alone. This file lands in a folder people hand to each other, so treat any value in it as something that may be read by somebody else.

### 2. Draft — three parts, and the person finishes it

Put the draft in the conversation. Never write the file first.

1. **Steps** — the job, in order. Each step names what it acts on concretely enough to find it again: the role and the accessible name, or a selector. *"The button named Export (`role=button`), on the orders list"* — not *"click export"*. When a step presses or fills something, give it an anchor (step 4) so a later run can tell you it is gone.
2. **Dropped** — everything you decided was noise, **each with its reason**: a misclick, looking around, a one-time banner, a repeat. Dropping silently is the one thing this step must not do.
3. **Undecided** — what you cannot tell from the record. Ask — *"you paused here for five seconds: waiting for it to load, or reading it?"* Do not guess.

Then let them correct it. They know the job; you only watched it happen.

### 3. Write it

What a playbook *is* on disk is `{workspace}/skills/{slug}/SKILL.md` — that file is the thing, and how it gets written depends on what the build has. Where the `craft-agent` CLI is available it is the sanctioned writer for `skills/` (see `craft-cli.md`):

```bash
craft-agent skill create --name "Weekly export" --description "Export Monday's report from the admin console" --slug weekly-export --body "<the steps>"
craft-agent skill validate weekly-export
```

Where it is not, write the file directly in the `SKILL.md` format [`skills.md`](./skills.md) describes. The check is the same either way — `skill_validate({ skillSlug })` from inside a session, or `craft-agent skill validate <slug>`. Change it later with `craft-agent skill update <slug> --json '{"body":"…"}'`, or by editing the file.

Add the entry (above) only if they want it to run on its own. Say what you wrote, and where.

### 4. Say what each step aims at

A step that presses or fills something should say **which** thing — otherwise a run that finds it gone presses nothing and says nothing, and the playbook is broken quietly. Declare it in a markdown comment on the step's own line:

```markdown
1. Open the orders list. <!-- @anchor .orders -->
2. Press Export. <!-- @anchor .toolbar .export -->
```

A CSS selector, and it renders as nothing to whoever reads the skill.

Then **a run records what it found**, in `hits.json` beside `SKILL.md`:

```json
{ "schemaVersion": 1, "updatedAt": 1791016080000,
  "targets": [ { "selector": ".orders", "lastMatchedAt": 1791016080000, "lastMatchedUrl": "…" },
               { "selector": ".toolbar .export" } ] }
```

**Only a run writes it, and only what it actually saw.** No time at all means the selector has never matched — it was wrong from the start. A time with no new one means it stopped matching, which is the page having moved. Never write a time you did not observe: the file is evidence, and a typed one is worth nothing.

**What counts as a match.** The element has to be there **and be usable** — a real box, not hidden. This rule is what keeps the record worth reading, because a page can leave the old control in the markup while moving to a new one and `document.querySelector` will happily find it. Measured on baidu.com, on the home page and on the results page alike: `#kw` and `#su` are still in the DOM, so a check that only asks *does it exist* reports them green forever — while they are `0×0` and invisible, and the box somebody actually types in is `#chat-textarea`. A playbook written against the old selectors would look healthy and never work. **If a step could not act on it, it did not match.**

**Each anchor gets the page its own step ran on.** `lastMatchedUrl` is the page the selector was really found on, which for a playbook whose steps cross pages is not the page the run happened to end on — so record each one where it was found, rather than one url for the lot.

**A run nobody is watching can still write this file.** `hits.json` is on the Explore-mode write allowlist (`~/.craft-agent/permissions/default.json`) and `SKILL.md` is deliberately not, so a scheduled run at `--permission-mode safe` can say what it found and cannot rewrite the steps it was given. Write the record and nothing else: the rest of the skill folder is not yours to touch on a run.

## Recipes

- **"Do this again next week"** → do it once, confirm the steps, write the `SKILL.md`, then add a `SchedulerTick` matcher with `[skill:slug]` in the prompt.
- **"Keep what you just did"** → draft the three parts, get it corrected, write it. No entry unless they ask.
- **"Keep what I just did"** (they recorded it) → read the `.events.jsonl` beside the film, draft from its `navigate` / `click` / `fill` lines, ignore the requests that are not the job.
- **"It stopped working"** → read the file and `hits.json`: a selector with no `lastMatchedAt` was wrong from the start, one that has an old time and no new one is the page having moved. Work out what it does now, fix that step, and say what changed.
- **"It failed once"** → if it was a one-off, nothing goes in the file. Say what happened in the conversation.
