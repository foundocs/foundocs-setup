# Writing Foundocs knowledge

Read this guide when a meaningful create or update is needed. The live MCP schemas and descriptions remain the authority for accepted fields and limits.

## Content

Write a concise statement of the rule, decision or learning, its scope or application conditions, and evidence. Evidence can be an inspected file or test result, a verified source link, or the date and substance of the user's explicit project statement or instruction. Label uninspected project statements as user-provided context; they do not require code verification. Never portray them as independently verified or add unstated details or reasons. Store basic project context in `learnings`, confirmed choices in `decisions`, and lasting behavioral instructions and preferences in `rules`. Group closely related facts by topic.

Use a title and `tldr` that identify what future work should retrieve, with a few useful tags. Keep `bodyMarkdown` focused on the knowledge; send metadata through the MCP fields instead of reproducing a local frontmatter/index workflow. Preserve existing metadata unless a meaningful correction is needed.

## New items

Use `create_doc` with `kind: "knowledge"`, a category of `rules`, `decisions` or `learnings`, and a `.md` path under the matching `knowledge/<category>/` directory. Supply the required title, `tldr`, tags, Markdown body, creation date in `YYYY-MM-DD`, concise change reason and UUID `requestId` according to the discovered schema.

For user-requested documents, use `kind: "document"`, `category: null` and a path under `docs/` ending in `.md`, unless the user specified another destination or format or repository spec conventions apply. These are Foundocs logical paths, not local files.

## Existing items

Read the current target before changing it. Use `update_doc` with the ID and observed `versionToken`; send only changed metadata and either a complete `bodyMarkdown` or sequential exact edits, never both. Each edit's `oldText` must match exactly once at that step. Read the full body before replacing it; do not replace unread text with a search excerpt or partial chunk. The original creation date is immutable.

If equivalent knowledge already exists, leave it unchanged. Merge new explicit user-provided context or verified findings into the same topic while preserving unrelated content and distinguishing their evidence. For contradictions, apply an explicit user correction with its source; otherwise clarify whether the new statement corrects the old one before replacing disputed knowledge. Collection alone does not authorize deleting or archiving old items. For an explicit manual archive or restore request, follow [the Foundocs manual archival guidance](../../foundocs/SKILL.md#manual-archival-and-restoration).

## Requests and results

Use a fresh UUID `requestId` for each intended mutation. Reuse it only when retrying the exact same payload, including after a lost response, to avoid duplicate changes. On version or edit conflicts, read the latest target, reconcile the change and use a new ID for the revised payload. Do not overwrite concurrent edits blindly or repeat non-retryable requests.

Inspect the response envelope and returned record. Report a save only after a successful result. If the connection fails or a response remains uncertain, report that state and keep the proposed content available in the task context; do not claim it is stored or create an unsolicited local mirror. Do not make up document URLs: use a returned or already verified URL, or identify the saved logical path.
