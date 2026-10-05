# Decision Model (`decide`)

`decide` asks a decision model (Jev, TypeSafe AI's System One model) typed questions about a piece of text or JSON. It returns probabilities, not prose, in a fraction of a second, for a fraction of a cent. It is available only when the user enabled it in **Settings > AI > Decision model (Jev)**.

## When to use

| Task | Use |
|------|-----|
| Sort 150 emails into 6 folders | `decide` with `items` and one `choice` question |
| Is each ticket about billing? | `decide` with `items` and one `noul` question |
| Rate support replies on a 4-level rubric | `decide` with a `score` question |
| Pick which of 30 saved searches matches a request | `decide` with a `choice` question (options = the searches) |
| Summarize, extract fields, draft text, explain | `call_llm` — Jev cannot produce text |

Rule of thumb: if the answer is **one of a fixed set of options, a level, or yes/no**, use `decide`. If the answer is **words**, use `call_llm`.

## Question types

```json
{
  "state": "My running shoes arrived in the wrong size. Can I swap them for a size 10?",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "returns": "Exchanges, wrong or damaged items",
        "shipping": "Delivery status, delays, lost packages",
        "billing": "Charges, invoices, payment problems",
        "other": "None of the above"
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated is the customer?",
      "criteria": ["Calm, just stating facts", "Frustrated but civil", "Very angry or threatening to leave"]
    },
    "wants_human": {
      "type": "noul",
      "instructions": "Is the customer asking for a human agent?"
    }
  }
}
```

Answer shape:

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "department": { "type": "choice", "choice": "returns", "confidence": 0.93, "probabilities": { "returns": 0.95, "shipping": 0.03, "billing": 0.01, "other": 0.01 } },
    "frustration": { "type": "score", "score": 0.31, "confidence": 0.62, "probabilities": { "0": 0.72, "1": 0.25, "2": 0.03 } },
    "wants_human": { "type": "noul", "noul": 0.04 }
  },
  "usage": { "inputTokens": 340, "outputTokens": 30 },
  "latencyMs": 210
}
```

- **choice** — `criteria` is an object of option key → one-sentence description (2–255 options). Use `null` as the description when the key speaks for itself. `choice` is the most likely option; `probabilities` sum to 1.
- **score** — `criteria` is an ordered array of level descriptions, lowest first (2–10). `score` is the expected level (0 … levels-1), `probabilities` are keyed by level index. Describe levels as situations ("broken but a workaround exists"), not adjectives ("moderate").
- **noul** — a yes/no probability. Optional `criteria: { "true": "...", "false": "..." }` sharpens the question.

`instructions` may be a sentence or a small object such as `{ "question": "...", "focus": "..." }`. English works best. Mix question types freely; up to 20 questions per call.

## Batch mode

Pass `items` (max 200 strings or objects) instead of `state`. Every item is judged with the same questions, results keep the input order:

```json
{
  "items": ["Invoice #4411 is wrong", "Where is my package?", "Cancel my account"],
  "questions": { "topic": { "type": "choice", "instructions": "Topic?", "criteria": { "billing": null, "shipping": null, "account": null, "other": null } } }
}
```

```json
{
  "total": 3, "succeeded": 3, "failed": 0,
  "results": [
    { "index": 0, "preview": "Invoice #4411 is wrong", "answers": { "topic": { "type": "choice", "choice": "billing", "confidence": 0.97, "probabilities": { "...": 0 } } } },
    { "index": 1, "preview": "Where is my package?", "answers": { "...": 0 } }
  ]
}
```

Items that fail carry an `error` string instead of `answers`; the rest are still usable. Put the same context (a rubric, a policy) into every item as an object field when the judgment depends on it.

## Reading answers

- `confidence` (0–1) says how concentrated the probabilities are. **Below 0.5 the model is unsure** — report that, ask the user, or fall back to `call_llm`. Do not act on a coin flip.
- Pick `noul` thresholds for the stakes: 0.5 when yes and no are equally cheap to act on, 0.8 or higher when a false yes is expensive, and treat 0.2–0.8 as "needs a human" when it matters.
- Always include an `other` / `unclear` option when your categories are not exhaustive — otherwise the model is forced to pick a wrong one.
- **An answer is never permission.** Re-check before acting (does the chosen folder exist, is the item really what the model thought). Selection and authorization are different things.

## Limits and cost

- State: text or JSON only, cut at ~96 KB (about 32k tokens); images are not supported.
- Speed: roughly 0.1–0.5 s per call; batches run 8 items at a time.
- Cost: billed by the user's provider per input token (about $0.04 per million tokens on TypeSafe/OpenRouter); output is free.

## Privacy

The `state`/`items` you pass are sent to the provider the user configured (TypeSafe AI, OpenRouter, Vercel AI Gateway, a local Laya server, or their own Jev-compatible server). With Laya the model runs on the user's machine and nothing leaves it; the English checkpoint reads about 512 tokens of state, so keep local states short. Do not include secrets, credentials, or file contents that were not meant to leave the machine. Every call is recorded in `~/.craft-agent/logs/decisions.jsonl` with the questions, probabilities and a hash of the state — never the state text itself.
