# Capture, retry and continuity

Read current live tool schemas. Every remote call uses the exact configured project_id. Tools are `capture_episode`, `search_episodes`, `get_episode`, `get_episode_candidates`, `get_episode_candidate`, `get_episode_revisions`. If capture or required recall is unavailable, skip (acknowledge locally only when a trusted checkpoint exists); do not write another content kind. Authentication/access/configuration failures stop Foundocs calls.

## Write one coherent story

An episode should read like one story, diary entry or short retrospective. Its value is the context and change a future reader can understand, not proof that the agent ran commands. Let the reader follow what was awkward or needed attention, what was chosen and changed, and what that means now. Use only facts and reasons supported by the task; do not fabricate emotions, dialogue, user reactions, metrics or a dramatic lesson. A small result may deserve a small story.

- Give the episode a title about the change or insight, rather than a ticket, commit or test result.
- Put a short plain-language TL;DR in `summary[0]`, so the list preview conveys the story. The entire summary remains 2–4 Markdown blocks, each within the live tool's character limit.
- Use `##` or `###` headings for meaningful parts of the story and blank lines between paragraphs. Use bullet lists for parallel changes or observations. A block can contain a heading, prose and a list; blocks are not restricted to single sentences. Do not force every episode into the same headings or a chronological activity log.
- Explain concrete changes through the experience they affect. Keep relevant uncertainty or unfinished scope in plain language, and use the structured status/remainingWork fields accurately.
- Omit test-pass counts, commit hashes, command names, build logs and checklist receipts from narrative prose by default. Keep required artifact and verification references in `event.evidence` (and relevant content links in `event.links`). Include a technical detail in prose only when it is the subject of the story or essential to understanding the change.

For a sidebar UX change, a narrative could look like this when supported by the task:

```markdown
The sidebar now separates choosing a workspace from finding a project. What began as a request for a clearer project list also helped simplify the menu hierarchy.

## Giving each choice its own place

The old switcher mixed workspaces and projects, so the design gave them separate places:

- A workspace-only switcher at the top.
- A project list directly underneath, with pages for longer lists.
- A persistent workspace settings button at the bottom.

## Removing a label that no longer helped

Once the projects were visible, another “Project” heading above Overview and Episodes felt redundant. Removing it let those two entries read as the project's starting points while the other groups kept their meaning. The development and merge are complete; this account does not claim a production rollout.
```

This illustrates narrative flow and Markdown, not mandatory wording or sections. Do not copy its facts to another task. The PR, checks and exact revision belong in the evidence fields rather than being appended as an audit block.

## Select and ground

The host supplies semantic judgments from current task context; the server validates structure, evidence references, state, novelty, versions and authority. It does not independently verify a conversation. No keyword or message-length heuristic decides importance.

- `judgment`: significance `important|routine|uncertain`, novelty `new|duplicate|uncertain`, grounding `confirmed|proposed|uncertain`, outcome `succeeded|failed|partial|unknown`, reason (<=1000), evidenceRefs (matching submitted evidence sourceRef). Routine/duplicate host events stay local. Use null or uncertain for a worthwhile event that cannot yet be judged; the server defers it.
- `event`: taskKey, boundaryKey, kind (`result|decision|discovery|blocker|milestone`), observation (<=3000), evidence and links. The checkpoint helper assigns sourceEventId, sessionId and occurredAt. For direct capture, use the identity/time rules below. Never guess a completion time.
- `episode`: title <=120; summary array of 2–4 concise Markdown blocks (each <=600), starting with a short TL;DR paragraph; kind; status `in_progress|completed|blocked|cancelled`; tags; remainingWork (<=1000 or null); optional previousEpisodeId. Prefer substantially shorter content.
- `completed` requires `outcome:succeeded` and `remainingWork:null`. A completed decision means the choice is settled, not its implementation. State remaining implementation in the summary. `result` with outcome unknown must defer. Confirmed decision/discovery/blocker/milestone may record while overall outcome is unknown.
- Evidence: kind `user_statement|artifact|verification|observation`, stable sourceRef, label, detail <=1000, optional safe HTTP(S) URL. Decision needs explicit user_statement; result/discovery and ordinary completion need artifact or verification. Keep only brief supported facts, never source dumps. Input evidence/links <=20 each.
- Links: `{contentId,relation:"related|used|produced|supports",observedVersion?}` from observed same-project content. Do not invent IDs, permissions or old document bodies.

## Stable goals and phases

Reuse taskKey across turns and sessions for the same explicit user goal: use a known card/task ID, or mint a persistent goal identity once and reuse the server record. Search a focused goal/topic before creating another identity when continuity is plausible. A session, date or checkpoint is **not** a goal or phase. One session can contain several goals.

Use an explicit boundaryKey for the goal's phase. Read the matching episode and current version before updating. Set expectedEpisodeVersion:0 only for a new boundary; positive observed version for an existing one. Add genuinely new evidence/links; wording-only changes are not progress. Completed/cancelled phases require a new boundaryKey and previousEpisodeId for later activity. Explicit factual corrections use correction:true, observed version and preserve prior status/timestamps/previousEpisodeId. On VERSION_CONFLICT or NOVELTY_REQUIRED, reread and reassess; do not blindly increment versions.

## Direct remote capture without a checkpoint

Use this path only when automatic episode capture is enabled and no trusted checkpoint/local helper path is available. Hook support is not required by the remote API. Do not use it to evade an opt-out, permission error, failed prepare or an existing pending outbox request.

1. Use the same configured project and observed goal/phase identity. Search the relevant task/topic for an existing episode; read its current version before updating. A completed phase continues under a new boundary and `previousEpisodeId`. This applies across sessions and capture paths.
2. For a new event, create a fresh UUID `requestId` once and keep the full payload in current task context. Use a stable `sourceEventId` from the observed artifact/event (for example a repository + PR number + merge commit); if none exists, generate an event UUID once and retain it for retries. Do not derive taskKey or boundaryKey from the session or timestamp. Omit sessionId unless the current host actually supplied it.
3. Use the verified event timestamp for a past result, or the current observed time for a newly observed event; do not invent a historical time. Submit brief typed evidence, its exact sourceRefs in judgment.evidenceRefs, and the episode with the observed version (0 only for a new boundary). Call `capture_episode` directly with that payload.
4. Inspect the returned disposition and episode. `deferred` has not produced a visible episode; read the candidate before reassessing a known judgment/scope error with its observed candidate version. Do not blindly recreate the event or claim success.
5. After an uncertain response, retry at most once in the current attempt with the identical requestId and payload. If still uncertain, report that state. Without a persistent outbox, a later session must recover current server episode/candidate state by the known goal/event before writing; never invent the lost request or reissue it with a new ID. Definite version conflicts require the normal reread/reconciliation rules.

Do not create local project journals or enable private storage merely for this fallback. This path records a confirmed outcome using the current host; it does not run a background model.

## Private prepare → remote call → acknowledgment

Prefer local MCP episode_checkpoint with operation set to the command below and the configured project_id; its other arguments are the shown helper input. If unavailable, invoke the installed shell helper as in SKILL.md. The helper and local MCP tool share the same private state. Send `prepare` this shape (illustrative values must be replaced with actual facts):

```json
{
  "checkpoint":"CHECKPOINT_FROM_HOOK",
  "slot":"verified-result",
  "capture":{
    "event":{
      "taskKey":"TASK-STABLE-ID",
      "boundaryKey":"implementation",
      "kind":"milestone",
      "observation":"Focused tests passed; the PR is awaiting review.",
      "evidence":[{"kind":"verification","sourceRef":"test:OBSERVED-RUN-ID","label":"Focused tests","detail":"The observed test command passed."}],
      "links":[]
    },
    "judgment":{"significance":"important","novelty":"new","grounding":"confirmed","outcome":"partial","reason":"Verified implementation milestone with review remaining.","evidenceRefs":["test:OBSERVED-RUN-ID"]},
    "episode":{"title":"Implementation ready for review","summary":["The requested change passes its focused tests.","Review and integration checks remain."],"kind":"milestone","status":"in_progress","tags":[],"remainingWork":"Review and integration checks"},
    "expectedEpisodeVersion":0
  }
}
```

`slot` is a stable short lowercase operation label within the checkpoint. Different meaningful events may use different slots. Never supply requestId/project_id/sourceEventId/sessionId yourself; the helper fills them once. `already_acknowledged` means this slot is already settled: do not call capture again. `prepared` returns `payload`: call the live `capture_episode` tool with **that exact object**. The helper does not call the server or make a meaning judgment. It marks the checkpoint acknowledged immediately so a lost response cannot cause a Stop loop.

After a successful server response, run `ack` with `{checkpoint,requestId,result:DATA_FROM_SUCCESSFUL_CAPTURE}`. Only a server-confirmed disposition (created/updated/corrected/deferred/skipped/unchanged) is success; inspect isError and ok. A deferred candidate is not a visible episode.

After timeout/unknown response, leave the outbox entry intact. On the next relevant ordinary task, `pending` with the current checkpoint returns at most 3 oldest outstanding payloads with their original checkpoint IDs. Replay the identical payload/requestId; ack against its original checkpoint. Do not reconstruct, change timestamps, make a new requestId or claim success. There is no background model or repeated retry loop. After definitive rejection, reconcile current server state; `discard` with original checkpoint/requestId removes only the rejected entry before a revised assessment uses a new slot. Never discard an uncertain write just to bypass a conflict. `payload_conflict` requires reusing pending original payload or explicit reconciliation.

Private state is outside the project under the setup storage directory, owner-only, bounded to 128 checkpoints/32 requests. Each prepared request expires 14 days after preparation; retries never extend it. Unreferenced checkpoints expire 14 days after creation. A live request retains only its required checkpoint metadata until acknowledgment or request expiry (at most 28 days after checkpoint creation). An expired checkpoint can retry/ack existing requests but cannot prepare new slots. It retains only minimal checkpoint metadata and brief submitted capture payloads, never prompts/transcripts/credentials. A crashed helper can leave checkpoint.lock; after confirming no helper process is running, remove only that private lock and retry. Never delete an outbox to repair a lock. Cleanup runs on helper use; an idle installation does not run a deletion daemon. Expiry removes local retry data, not server candidates. POSIX private storage is currently supported; Windows reports unavailable and capture skips. If local storage is unavailable/full, skip capture and continue primary work; do not change filesystem permissions or approvals.

## Deferred and server-observed events

When new evidence settles a deferred event, read `get_episode_candidate` with version-pinned evidence/link pagination. Prepare a capture with candidateId and expectedCandidateVersion (no event), judgment, episode and expectedEpisodeVersion. This reassesses the stored original event, not a reconstructed/clipped inbox excerpt. Preserve the original goal/boundary.

For a current related document/knowledge change, `get_episode_candidates(source:"changes")` is a bounded recent inbox (24h default, at most14days, limit<=20). Do not scan old history on install. If meaning/goal is unclear, leave it unassessed. Assess a known source with sourceChangeId, event goal/boundary/kind and evidenceRefs `["change:SOURCE_ID"]`; the server substitutes canonical observation/evidence/time and deduplicates across actors. Unimportant *server inbox* changes may be submitted as routine to acknowledge them; ordinary trivial *host turns* must only skip locally. Already assessed source changes leave this inbox. `source:"pending"` finds deferred candidates.

Do not create episodes for reads, retrieval evaluation, checkpoint preparation, retry/ack or episode writes themselves. For recall, search recent task episodes first, widen query/time only as needed, read focused details and linked documents/knowledge. The compact list is not a complete evidence record.
