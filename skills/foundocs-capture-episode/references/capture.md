# Capture, retry and continuity

Read current live tool schemas. Every remote call uses the exact configured project_id. Tools are `capture_episode`, `search_episodes`, `get_episode`, `get_episode_candidates`, `get_episode_candidate`, `get_episode_revisions`. If capture or recall is unavailable, locally skip; do not write another content kind. Authentication/access/configuration failures stop Foundocs calls.

## Select and ground

The host supplies semantic judgments from current task context; the server validates structure, evidence references, state, novelty, versions and authority. It does not independently verify a conversation. No keyword or message-length heuristic decides importance.

- `judgment`: significance `important|routine|uncertain`, novelty `new|duplicate|uncertain`, grounding `confirmed|proposed|uncertain`, outcome `succeeded|failed|partial|unknown`, reason (<=1000), evidenceRefs (matching submitted evidence sourceRef). Routine/duplicate host events stay local. Use null or uncertain for a worthwhile event that cannot yet be judged; the server defers it.
- `event`: taskKey, boundaryKey, kind (`result|decision|discovery|blocker|milestone`), observation (<=3000), evidence and links. The helper assigns sourceEventId, sessionId and occurredAt. Supply occurredAt only for an observed past event, never guess a completion time.
- `episode`: title <=120; summary array of 2–4 sentences (each <=600); kind; status `in_progress|completed|blocked|cancelled`; tags; remainingWork (<=1000 or null); optional previousEpisodeId. Prefer substantially shorter content.
- `completed` requires `outcome:succeeded` and `remainingWork:null`. A completed decision means the choice is settled, not its implementation. State remaining implementation in the summary. `result` with outcome unknown must defer. Confirmed decision/discovery/blocker/milestone may record while overall outcome is unknown.
- Evidence: kind `user_statement|artifact|verification|observation`, stable sourceRef, label, detail <=1000, optional safe HTTP(S) URL. Decision needs explicit user_statement; result/discovery and ordinary completion need artifact or verification. Keep only brief supported facts, never source dumps. Input evidence/links <=20 each.
- Links: `{contentId,relation:"related|used|produced|supports",observedVersion?}` from observed same-project content. Do not invent IDs, permissions or old document bodies.

## Stable goals and phases

Reuse taskKey across turns and sessions for the same explicit user goal: use a known card/task ID, or mint a persistent goal identity once and reuse the server record. Search a focused goal/topic before creating another identity when continuity is plausible. A session, date or checkpoint is **not** a goal or phase. One session can contain several goals.

Use an explicit boundaryKey for the goal's phase. Read the matching episode and current version before updating. Set expectedEpisodeVersion:0 only for a new boundary; positive observed version for an existing one. Add genuinely new evidence/links; wording-only changes are not progress. Completed/cancelled phases require a new boundaryKey and previousEpisodeId for later activity. Explicit factual corrections use correction:true, observed version and preserve prior status/timestamps/previousEpisodeId. On VERSION_CONFLICT or NOVELTY_REQUIRED, reread and reassess; do not blindly increment versions.

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
