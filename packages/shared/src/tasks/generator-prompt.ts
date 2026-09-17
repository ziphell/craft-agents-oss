/**
 * Generator prompt for Generate mode (#2 / architecture §3a).
 *
 * The task's persistent orchestrator session is asked to AUTHOR a `task.yaml`
 * from a natural-language goal. The result is a human-editable artifact, so the
 * prompt is legibility-first (#7): bias toward the simplest graph that achieves
 * the goal, with clear titles and explicit dependencies — not the cleverest one.
 */
export function buildGeneratorPrompt(goal: string, title?: string): string {
  return [
    'You are authoring a `task.yaml` that decomposes a goal into a small DAG of subtasks.',
    'Each node becomes a child AI session; a `depends_on` edge passes the upstream node\'s output to the dependent.',
    '',
    'Rules:',
    '- Output ONLY the YAML — no prose, no code fences, no explanation.',
    '- Prefer the SIMPLEST graph that achieves the goal: few nodes, clear titles, explicit dependencies. A human will read and edit this.',
    '- Make nodes parallel (no `depends_on` between them) ONLY when the steps are genuinely independent.',
    '- Reference an upstream result inside a prompt with ${nodes.<id>.output}.',
    '- When a downstream node needs ONE specific field of an upstream result (a decision, a status, a path), use ${nodes.<id>.output.<field>} and declare that field in the upstream node\'s `outputs`. A ${nodes.<id>.output.<field>} reference to an undeclared field is an invalid graph — never emit one.',
    '- Every ${nodes.<id>.output} reference MUST point to an `id` that you actually declare under `nodes`. Never reference a node you did not create. Verify each reference resolves before emitting the YAML.',
    "- Branch only when the plan genuinely branches (an approved/rejected split), with `when: \"node-id.field === 'value'\"` over a field another node declares in `outputs`. A node whose `when` is false is skipped, and so is anything depending on it — that is how one side of a split is left out, not a way to express ordinary sequencing.",
    "- A step that needs a PERSON to decide is `kind: approval` with the question as its `prompt`; declare `outputs: [{ name: verdict }]` on it and branch on `when: \"<id>.verdict === 'approved'\"`. Never use it for a step an agent could do.",
    '- When more than one node writes prototype artifacts in the same run, give each of them a distinct `writes:` slug. That slug is the node\'s writer identity: its patches are named `{writes}-{nnn}-{name}.{css,js}`, and two nodes sharing one identity would overwrite each other\'s files. A task with one writer leaves it out. That identity guards the files a writer owns (patches, `services/*/paths|fixtures|state`) — the shared control-plane files are writable by any writer by design, so when several nodes work on one prototype keep the page documents, `config.json`, `prd.md` and `dist/` to a single node, or give each node its own page: two nodes editing one page is a race nothing guards.',
    "- When the goal is to BUILD or CHANGE a prototype, add a critic node after the building one instead of trusting it: the critic runs the prototype's own acceptance checks (`prototype-verify`) AND reads the brief for itself — `prd.md`, and the findings under `research/` that argue for each requirement — then writes one dispute under `reviews/` per thing that does not hold, declaring `outputs: [{ name: verdict, enum: [pass, fail] }, { name: objections, type: number }]`. An objection about the prototype names what failed (`about: patch <file>` or `about: page <name>`); an objection about the brief names the requirement (`about: requirement R-003`) — file one when a requirement nothing argues for, or when a finding the requirement is argued from has no `claim:`, no `source:`, or cites evidence that is not in `research/`. The node after it carries `when: \"<critic>.verdict === 'fail'\"` and goes back to the building node, so a run only finishes when the prototype's own checks pass and no objection to the brief is left standing. `prototype-status` prints exactly what is still outstanding, and `prototype-export --strict` refuses while anything is.",
    '- Add `acceptance_criteria`: a short, checkable rubric for the FINISHED task (what "done and correct" means). It is what you will grade the result against when the run finishes — make it concrete and testable, not a restatement of the goal.',
    '',
    'Schema:',
    '  id: kebab-case-slug',
    '  title: short human title',
    '  goal: one-line restatement of the goal',
    '  acceptance_criteria: a concrete, checkable definition of done for the whole task',
    '  nodes:',
    '    - id: kebab-id',
    '      title: short title (becomes the subtask/session name)',
    '      prompt: the full instruction for this subtask (may include ${nodes.<id>.output})',
    '      depends_on: [other-node-id]   # omit when the node has no dependencies',
    '      outputs:                      # OPTIONAL — fields a downstream node reads from THIS node',
    '        - name: verdict             # read downstream as ${nodes.<this-id>.output.verdict}',
    '          type: string              # string | number | boolean | json',
    '          enum: [approved, rejected]  # optional: restricts the value',
    '      when: "some-node.field == \'value\'"  # OPTIONAL — run this node only when the test holds',
    '      writes: checkout-ui           # OPTIONAL — this node\'s prototype writer identity (the prefix its patches are named with); distinct per node when several write prototypes',
    '',
    'Example:',
    '  id: migrate-auth',
    '  title: Migrate auth',
    '  goal: Migrate the auth layer to the new session model.',
    '  acceptance_criteria: All auth call sites use the new session API and the existing auth tests pass.',
    '  nodes:',
    '    - id: audit',
    '      title: Audit call sites',
    '      prompt: List every auth call site and how it is used.',
    '    - id: design',
    '      title: Design new auth',
    '      prompt: "Design the new session-based auth using the audit: ${nodes.audit.output}"',
    '      depends_on: [audit]',
    '',
    title ? `Working title: ${title}` : '',
    `Goal: ${goal}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Repair prompt for the auto-repair turn (Generate mode robustness).
 *
 * The orchestrator just authored a `task.yaml` that failed validation (commonly a
 * `${nodes.X.output}` reference to a node id it never declared). It still holds the
 * conversation, so we hand the concrete validation errors back and ask for a corrected
 * spec — same output contract as the original generation (YAML only).
 */
export function buildRepairPrompt(errors: { path: string; message: string }[]): string {
  return [
    'The task.yaml you produced failed validation with these errors:',
    ...errors.map((e) => `- ${e.path}: ${e.message}`),
    '',
    'Fix every error and output the COMPLETE corrected task.yaml.',
    'Most common cause: a ${nodes.<id>.output} reference whose <id> is not declared under `nodes`. Either add the missing node or change the reference to an id you actually declare.',
    'Output ONLY the YAML — no prose, no code fences, no explanation.',
  ].join('\n')
}
