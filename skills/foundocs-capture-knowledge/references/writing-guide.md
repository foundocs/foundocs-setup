# Writing Foundocs knowledge

Read this guide when a meaningful create or update is needed. The live MCP schemas and descriptions remain the authority for accepted fields and limits.

## Content

Write a concise statement of the rule, decision or learning, its scope or application conditions, and evidence. Evidence can be an inspected file or test result, a verified source link, or the date and substance of the user's explicit project statement or instruction. Label uninspected project statements as user-provided context; they do not require code verification. Never portray them as independently verified or add unstated details or reasons. Store basic project context in `learnings`, confirmed choices in `decisions`, and lasting behavioral instructions and preferences in `rules`. Group closely related facts by topic.

Use a title and `tldr` that identify what future work should retrieve, with a few useful user tags. When preserving tags in a full write, copy the returned `userTags` into `tags`. The effective read list `tags` includes an automatic category tag. A user tag with the same spelling remains a user tag. Legacy reads have only authored `tags`. Keep `bodyMarkdown` focused on the knowledge; send metadata through the MCP fields instead of reproducing a local frontmatter/index workflow. Preserve existing metadata unless a meaningful correction is needed.

## New items

Use `create_doc` with a `.md` path under the matching `docs/knowledge/<category>/` directory. The folder determines the automatic tag: `decisions` → 결정, `learnings` → 배움, `rules` → 규칙. Omit kind and category when optional; where a unified schema requires them, use `kind: "document", category: null`. Use the same canonical shape for Shared writes. On a legacy server with separate roots and required knowledge fields, use its `kind: "knowledge"`, matching category and `knowledge/<category>/` path. See the main skill for capability discovery. Supply the required title, `tldr`, tags, Markdown body, creation date in `YYYY-MM-DD`, concise change reason and UUID `requestId` according to the discovered schema.

The three category roots are fixed. Reuse an existing topical folder before creating another; nested paths such as `docs/knowledge/learnings/auth/session-expiry.md` and direct-root files such as `docs/knowledge/rules/testing.md` are both valid. Group related information rather than producing one small file or near-duplicate folder per fact. Do not change category merely to place an item in a convenient folder.

For documents within the user's request or approval, use `kind: "document"`, `category: null` and a path under `docs/` ending in `.md`, unless the user specified another destination or format or repository spec conventions apply. Follow the [document authorization policy](../../foundocs/references/documents.md#document-authorization) before creating or editing a document; this knowledge-writing guide does not grant that permission. These are Foundocs logical paths, not local files.

## Existing items

If the relevant knowledge is global or an original linked to global knowledge, follow [the global approval workflow](../../foundocs/references/documents.md#global-documents-and-knowledge) for any edit or move. Ordinary automatic capture authorizes writes to project-only knowledge.

Read the current target before changing it. Use `update_doc` with the ID and observed `versionToken`; send only changed metadata and either a complete `bodyMarkdown` or sequential exact edits, never both. Each edit's `oldText` must match exactly once at that step. Read the full body before replacing it; do not replace unread text with a search excerpt or partial chunk. The original creation date is immutable.

If equivalent knowledge already exists, leave it unchanged. Merge new explicit user-provided context or verified findings into the same topic while preserving unrelated content and distinguishing their evidence. For contradictions, apply an explicit user correction with its source; otherwise clarify whether the new statement corrects the old one before replacing disputed knowledge. Collection alone does not authorize deleting or archiving old items. For an explicit manual archive or restore request, follow [the Foundocs manual archival guidance](../../foundocs/SKILL.md#manual-archival-and-restoration).

### Authorized path moves outside Dreaming

When the task or existing project policy authorizes organization within one knowledge category, including suitable folder placement during capture, proceed without a separate per-move confirmation. Read the current item, then use `update_doc` with its stable ID, observed `versionToken`, the new `path`, a concise `reason` and a fresh `requestId`. Send only the path change; preserve the body, title, TL;DR, ordered tags, category, creation date and other metadata. Do not recreate or delete the item to move it. Previous paths remain aliases to the same ID, move history is retained, and the server's `linkBasePath` keeps relative Markdown links anchored until the body changes. Do not rewrite links or set this server-owned field yourself. Path conflicts or stale versions require rereading and reconciliation, never blind overwrite.

For a directory move, follow the [batch move contract](../../foundocs/SKILL.md#batch-reads-and-directory-moves) and use `move_docs` with stable IDs and observed versions. Capture within an existing category keeps the automatic tag. An explicitly requested cross-category move applies the destination folder’s tag. During Dreaming use `dream_memory` proposals.

Inspect the live `get_content_moves` schema to list the item's structured move receipts and follow `nextCursor`. For an explicitly requested undo of an ordinary path-only move, read the current item and use `undo_content_move` with `project_id`, `id`, the receipt's `moveId`, current `versionToken`, a reason and a fresh `requestId`. Undo fails when the item changed after that move or the destination conflicts; do not bypass that failure with `update_doc`. This path-only undo cannot revert a move bundled with semantic changes; inspect the original change and use the normal authorized update workflow for ordinary capture corrections. Ordinary semantic capture still follows the existing update rules above. Dreaming moves must be reverted through the exact saved proposal's owner review, never this tool or a generic path write. If these tools are unavailable on an older server, explain the missing history/undo capability instead of claiming it was verified or fabricating a revert.

## Requests and results

Use a fresh UUID `requestId` for each intended mutation. Reuse it only when retrying the exact same payload, including after a lost response, to avoid duplicate changes. On version or edit conflicts, read the latest target, reconcile the change and use a new ID for the revised payload. Do not overwrite concurrent edits blindly or repeat non-retryable requests.

Inspect the response envelope and returned record. Report a save only after a successful result. If the connection fails or a response remains uncertain, report that state and keep the proposed content available in the task context; do not claim it is stored or create an unsolicited local mirror. Do not make up document URLs: use a returned or already verified URL, or identify the saved logical path.
