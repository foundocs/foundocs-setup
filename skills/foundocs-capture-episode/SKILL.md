---
name: foundocs-capture-episode
description: Record a coherent work package as one concise story at a meaningful delivery boundary, such as submitting its PR or completing a release. Batch small edits, investigations and tests; do not capture each step or turn. Also supports substantial standalone decisions or blockers and explicit user requests. Works without a hook checkpoint.
---

# Selective episode capture

Capture at the meaningful delivery boundary of a coherent work package, not whenever a small task succeeds. Keep related edits, investigations and tests in the current task context until that boundary; do not create remote candidates or local journals for each step. At the boundary, capture the grouped result in the same turn without a separate reminder. Read [the capture contract](references/capture.md) then. Hooks are reminders and retry aids, not capture boundaries. Do not reload the conversation or start another model just for collection.

## Recognize outcomes, not activity

Batch small units of work toward the same goal into one episode when its PR is submitted or its service/release changes are delivered. If the authorized work continues through PR creation, merge and deployment, wait for the final intended boundary and write one grouped account rather than one episode per stage. If work ends at PR submission, record the package there with outstanding review and deployment stated accurately. For work without a PR or release, use completion of a substantive deliverable or a meaningful handoff, not each edit or chat turn. Explicit user requests to record an episode still apply.

Individual edits, research answers within an ongoing task, passing tests, commits, status checks, rule saves and turn endings are not automatic capture boundaries. Do not promote them to separate milestones, discoveries or decisions just to record them. A later release after an earlier handoff can add a genuinely new outcome; reuse the goal identity and read the existing episode before updating or linking the next phase, without repeating its small steps.

A substantial standalone decision or discovery, or a concrete blocker that stops work or requires a handoff, can merit one account before delivery. Minor choices, transient errors and intermediate findings stay with the work package. An ordinary proposed approach is not a confirmed decision. Until a capture boundary is reached, acknowledge a trusted checkpoint locally with `skip` when present; without one, simply continue. Skipping an intermediate checkpoint does not discard the task context or prevent a later grouped capture. Never invent a milestone to satisfy a hook.

Describe the completed scope precisely. A PR opened with review or required CI outstanding is `in_progress`, with `remainingWork`. A verified merge can complete the development-and-merge phase when deployment is outside that phase; say explicitly that release or production verification has not been performed. If deployment is part of the current phase and remains, keep it `in_progress`. Do not invent later requirements to prevent an otherwise finished phase from completing. `completed` requires confirmed success and `remainingWork:null`; unknown results are deferred, never reported as success.

Write one coherent story, diary entry or short retrospective in the user's language, not an execution report. Connect the situation or friction, the choice and changes, and what is different now; use only known context and never invent feelings, motives or impact. Start with a short TL;DR, then use meaningful Markdown headings and bullets where they make the story easier to read, especially for concrete changes. Keep test counts, commit hashes and command output out of the prose by default; put verification and artifact references in the structured evidence fields. Read [the writing guidance and example](references/capture.md#write-one-coherent-story). Knowledge capture is separate: link useful knowledge instead of repeating it, and save lasting rules or reusable lessons through the knowledge skill.

## Choose the available capture path

First follow [Foundocs configuration](../foundocs/references/configuration.md) for the exact governing project and inspect live episode tool schemas. Honor `"episodes":{"enabled":false}` in `foundocs.json` and `FOUNDOCS_EPISODES=off`; do not override opt-out. Missing configuration/access or remote tools means no capture: explain an unsaved important result briefly and continue the main task. Never substitute documents or knowledge for an episode. Document consent and explicit Dreaming consent remain unchanged.

With a trusted hook checkpoint and local MCP `episode_checkpoint`, use `prepare` → remote `capture_episode` → `ack` as described in the contract. Prefer that local MCP tool to shell; it stores the retry payload privately in the existing process. If the tool is absent, the installed `../foundocs/scripts/episode-checkpoint.mjs` helper is optional within existing permissions; never widen access just for bookkeeping. Do not fabricate a checkpoint, enable hooks or change host trust. Once a request is prepared, preserve its exact payload and outbox instead of switching paths after a failure.

Without a trusted checkpoint or supported local helper, an enabled project with remote episode tools can still use the contract's **direct remote capture** path. Do not skip a meaningful achievement solely because hooks are absent or this client cannot run the local helper. Direct capture has no persistent local outbox; preserve the request in current context and follow its bounded retry rules.

A Stop reminder is a single bounded fallback: assess once, acknowledge when possible, and do not repeat the user answer or continue just for bookkeeping. Report a saved result only after a server-confirmed created/updated/corrected or matching unchanged episode. A deferred candidate is not a saved episode. Routine skipping needs no user-facing report.
