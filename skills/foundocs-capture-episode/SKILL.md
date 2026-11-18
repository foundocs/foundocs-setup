---
name: foundocs-capture-episode
description: Automatically record meaningful verified achievements during ordinary work, including completed features or fixes, merged PRs and published releases, plus confirmed decisions, discoveries and concrete blockers. Capture in the same turn without a reminder, even without a hook checkpoint. Skip routine steps, duplicate reports and bookkeeping.
---

# Selective episode capture

When the current task reaches a meaningful verified outcome, capture it in the same turn without waiting for the user to ask to remember. Before the final response, briefly check the current context for an uncaptured achievement. A hook is a reminder and retry aid, not a prerequisite for recognizing an achievement. Read [the capture contract](references/capture.md) when an event is worth keeping. Do not reload the conversation or start another model just for collection.

## Recognize outcomes, not activity

Completing and verifying a requested feature or fix, merging its PR, or publishing and verifying a release are useful capture boundaries. Record what changed, why it matters, the evidence and the actual scope reached. One coherent result can combine implementation, tests and its PR; do not create an episode for every command, test or commit. A later merge or release may add a genuinely new milestone. Reuse the goal identity and check continuity before creating duplicates.

A confirmed decision, verified discovery or concrete blocker can also be worth keeping before the whole task completes. An ordinary proposed approach is not a confirmed decision. Routine lookups, greetings, unchanged status, repeated results, plans and episode bookkeeping do not warrant remote candidates. Acknowledge a trusted checkpoint locally with `skip` when present; without one, simply continue. Never invent a milestone to satisfy a hook.

Describe the completed scope precisely. A PR opened with review or required CI outstanding is `in_progress`, with `remainingWork`. A verified merge can complete the development-and-merge phase when deployment is outside that phase; say explicitly that release or production verification has not been performed. If deployment is part of the current phase and remains, keep it `in_progress`. Do not invent later requirements to prevent an otherwise finished phase from completing. `completed` requires confirmed success and `remainingWork:null`; unknown results are deferred, never reported as success.

Write 2–4 concise Markdown blocks in the user's language: a short plain-language TL;DR first, followed by the useful outcome, evidence and scope. Use headings only when they help. No transcripts, private reasoning, raw logs, secrets or speculative conclusions. Knowledge capture is separate: link useful knowledge instead of repeating it, and save lasting rules or reusable lessons through the knowledge skill.

## Choose the available capture path

First follow [Foundocs configuration](../foundocs/references/configuration.md) for the exact governing project and inspect live episode tool schemas. Honor `"episodes":{"enabled":false}` in `foundocs.json` and `FOUNDOCS_EPISODES=off`; do not override opt-out. Missing configuration/access or remote tools means no capture: explain an unsaved important result briefly and continue the main task. Never substitute documents or knowledge for an episode. Document consent and explicit Dreaming consent remain unchanged.

With a trusted hook checkpoint and local MCP `episode_checkpoint`, use `prepare` → remote `capture_episode` → `ack` as described in the contract. Prefer that local MCP tool to shell; it stores the retry payload privately in the existing process. If the tool is absent, the installed `../foundocs/scripts/episode-checkpoint.mjs` helper is optional within existing permissions; never widen access just for bookkeeping. Do not fabricate a checkpoint, enable hooks or change host trust. Once a request is prepared, preserve its exact payload and outbox instead of switching paths after a failure.

Without a trusted checkpoint or supported local helper, an enabled project with remote episode tools can still use the contract's **direct remote capture** path. Do not skip a meaningful achievement solely because hooks are absent or this client cannot run the local helper. Direct capture has no persistent local outbox; preserve the request in current context and follow its bounded retry rules.

A Stop reminder is a single bounded fallback: assess once, acknowledge when possible, and do not repeat the user answer or continue just for bookkeeping. Report a saved result only after a server-confirmed created/updated/corrected or matching unchanged episode. A deferred candidate is not a saved episode. Routine skipping needs no user-facing report.
