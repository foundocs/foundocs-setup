---
name: foundocs-capture-episode
description: Automatically retain concise important work events during ordinary tasks: confirmed decisions, verified results or discoveries, concrete blockers and meaningful milestones. Skip routine lookups, chatter, duplicate reports and bookkeeping. Uses the current host context, without a separate model or a request to remember.
---

# Selective episode capture

Use the current task context during normal work. The user need not ask to remember. Before finishing, assess the latest installed-hook checkpoint once. Read [the capture contract](references/capture.md) for a worthwhile event. Do not create a remote candidate for every turn. Routine lookup, greeting, unchanged status, repeated result, planned work or episode bookkeeping: acknowledge locally with `skip` and continue the task. Never invent a milestone just to satisfy a hook.

A confirmed decision, verified discovery, concrete blocker or material milestone can be worth keeping before the whole task completes. An ordinary proposed approach is not a confirmed decision. Result unknown means defer, not success. A PR submitted with tests passing but review/CI/release remaining is **in_progress**, with remainingWork; never mark the implementation completed. Use 2–4 short sentences, normally 150–300 Korean characters total or similarly concise text in the user's language. Keep facts, significance and actual remaining work. No full transcript, private reasoning, raw logs, secrets or speculative conclusions.

First follow [Foundocs configuration](../foundocs/references/configuration.md) for the exact governing project. Inspect live episode tool schemas. If disabled (`foundocs.json` has `"episodes":{"enabled":false}` or `FOUNDOCS_EPISODES=off`), no trusted checkpoint is available, the host is unsupported, or required remote tools are absent: skip honestly. Do not enable hooks, change trust/permissions or start external models. Never substitute documents or knowledge for an episode. Document consent and explicit Dreaming consent remain unchanged. Knowledge capture is a separate operation; link useful existing knowledge rather than duplicating its body.

The hook provides a checkpoint ID, not a task identity. Discover and use the installed local MCP `episode_checkpoint` tool when advertised; do not choose shell instead: pass the configured project_id, operation `skip|prepare|ack|pending|discard`, checkpoint and the corresponding fields described below. It performs private local bookkeeping in the existing MCP process, avoiding extra shell filesystem permissions. Its result.data is the helper result. It never substitutes for remote capture_episode. Confirm this tool is absent before considering a shell fallback. If absent, the shell helper is an optional fallback within existing permissions; never widen sandbox access or request permissions just for routine bookkeeping. The helper is `../foundocs/scripts/episode-checkpoint.mjs` relative to this skill; invoke it with Node and `--root ABSOLUTE_GOVERNING_ROOT`, supplying JSON through stdin. For routine local MCP acknowledgment, pass `{project_id: CONFIGURED_PROJECT, operation: "skip", checkpoint: CHECKPOINT_FROM_HOOK}`; no project index/search or remote capture is needed. Shell fallback only when the local MCP tool is unavailable (replace path/root/checkpoint with actual values):

```sh
node .agents/skills/foundocs/scripts/episode-checkpoint.mjs skip --root /absolute/project <<'JSON'
{"checkpoint":"CHECKPOINT_FROM_HOOK"}
JSON
```

Claude Code uses `.claude/skills/` instead of `.agents/skills/`. For important events, `prepare` persists a private retry payload **before** the host calls `capture_episode`, then `ack` settles the server-confirmed result. All details and examples are in the capture contract. Use normal host tools; no additional model API keys. A local failure must not block the primary response or cause repeated continuations. A Stop reminder is a single bounded fallback: assess/ack once, do not repeat the answer or continue just for bookkeeping. Do not mention routine skipping to the user.
