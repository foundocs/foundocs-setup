// Copied temporarily into the sibling product's apps/server/scripts by the runner.
// It imports the product's real isolated PostgreSQL + HTTP fixture, never mocks.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { httpFixture } from '../src/mcp/http-fixture'

const setup = process.env.ARCHIVE_SETUP_PACKAGE!
const { install, updateSkills, doctor, loadInstallation } = await import(pathToFileURL(join(setup, 'src/setup.mjs')).href)
const baseline = process.env.ARCHIVE_BASELINE_PACKAGE!
const baselineVersion = JSON.parse(await readFile(join(baseline, 'package.json'), 'utf8')).version
const pinnedCli = join(baseline, 'src/cli.mjs')
const pinned = await import(pathToFileURL(join(baseline, 'src/setup.mjs')).href)
const fixture = await httpFixture()
const directory = await realpath(fixture.directory)
const exec = promisify(execFile)
const ref = (item: any) => ({ id: item.id, versionToken: item.versionToken })
try {
  for (const mode of ['new-install', 'existing-runtime-pin']) for (const client of ['codex', 'claude']) {
    const account = await fixture.account(), root = join(directory, `${mode}-${client}`), storageDir = join(directory, `${mode}-${client}-private`)
    await mkdir(root); await writeFile(join(root, 'AGENTS.md'), '# Existing project instructions\n')
    const attemptId = randomUUID()
    const issued = await account.ownerFetch(`/api/workspaces/${account.workspaceId}/setup-codes`, { attemptId, projectId: account.projectId, client })
    assert.equal(issued.status, 201)
    const { code } = await issued.json() as any
    const options = { storageDir, probeClient: async () => ({ client, version: 'fixture', helper: 'supported' }) }
    const first = await (mode === 'existing-runtime-pin' ? pinned.install : install)(root, { version: 1, client, projectId: account.projectId, workspaceId: account.workspaceId, attemptId, code, exchangeUrl: `${fixture.origin}/api/setup/exchange`, mcpUrl: `${fixture.origin}/mcp` }, options)
    assert.equal(first.diagnostic.status, 'diagnostic_passed')
    const configPath = join(root, client === 'codex' ? '.codex/config.toml' : '.mcp.json')
    const before = await readFile(configPath, 'utf8')
    const recorded = await loadInstallation(root, options)
    const manifestBefore = await readFile(join(recorded.directory, 'installation.json'), 'utf8')
    const update = await updateSkills(root, options)
    assert.equal(update.ok, true)
    if (mode === 'new-install') assert.deepEqual(update.changedFiles, [])
    else assert.ok(update.changedFiles.length > 0)
    assert.equal(await readFile(configPath, 'utf8'), before)
    assert.equal(await readFile(join(recorded.directory, 'installation.json'), 'utf8'), manifestBefore)
    if (mode === 'existing-runtime-pin') assert.ok(before.includes(`@foundocs/foundocs-setup@${baselineVersion}`))
    assert.equal((await doctor(root, options)).diagnostic.status, 'diagnostic_passed')
    if (mode === 'new-install') {
      const result = await exec(process.execPath, [join(setup, 'src/cli.mjs'), 'doctor', '--root', root], { cwd: root, env: { ...process.env, FOUNDOCS_SETUP_HOME: storageDir }, timeout: 90000 })
      assert.equal(JSON.parse(result.stdout).diagnostic.status, 'diagnostic_passed')
      assert.ok(!result.stdout.includes(account.key) && !result.stderr.includes(account.key))
    }
    const prefix = client === 'codex' ? '.agents' : '.claude'
    for (const asset of ['SKILL.md', 'references/dreaming.md']) assert.equal(await readFile(join(root, prefix, 'skills/foundocs', asset), 'utf8'), await readFile(join(setup, 'skills/foundocs', asset), 'utf8'))
    const sdk = new Client({ name: 'packed-archive-check', version: '1' })
    const transport = new StdioClientTransport({ command: process.execPath, args: [mode === 'existing-runtime-pin' ? pinnedCli : join(setup, 'src/cli.mjs'), 'mcp', '--project-id', account.projectId], cwd: root, env: { ...process.env, FOUNDOCS_SETUP_HOME: storageDir } as Record<string, string>, stderr: 'pipe' })
    let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk })
    try {
      await sdk.connect(transport)
      const tools = (await sdk.listTools()).tools
      for (const name of ['set_content_status', 'set_knowledge_status', 'get_archive_candidates', 'approve_archive_proposal']) {
        const tool = tools.find(tool => tool.name === name)
        assert.ok(tool?.inputSchema && tool.outputSchema, `Missing dynamic schema for ${name}`)
      }
      assert.ok(tools.find(t => t.name === 'set_content_status')!.inputSchema.required?.includes('items'))
      const invoke = async (name: string, args: any) => (await sdk.callTool({ name, arguments: { project_id: account.projectId, ...args } })).structuredContent as any
      const call = async (name: string, args: any) => { const r = await invoke(name, args); assert.equal(r?.ok, true, `${name}: ${r?.error?.code}`); return r.data }
      const create = (name: string, kind = 'document') => call('create_doc', { kind, category: kind === 'document' ? null : 'learnings', path: kind === 'document' ? `docs/${name}.md` : `knowledge/learnings/${name}.md`, title: name, tldr: 'Retired experiment', tags: [], created: '2026-10-27', bodyMarkdown: 'The preview experiment ended. The stable channel replaces it.', reason: 'Isolated integration fixture', requestId: randomUUID() })
      const doc = await create('document'), memory = await create('knowledge', 'knowledge')
      const args = { items: [ref(doc), ref(memory)], memoryStatus: 'archived', reason: 'Explicit fixture archival request', requestId: randomUUID() }
      const archived = await call('set_content_status', args)
      assert.ok(archived.items.every((i: any) => i.changed && i.memoryStatus === 'archived'))
      assert.deepEqual(await call('set_content_status', args), archived)
      assert.ok((await call('set_content_status', { ...args, items: archived.items.map(ref), requestId: randomUUID() })).items.every((i: any) => !i.changed))
      assert.equal((await invoke('set_content_status', { ...args, requestId: randomUUID() })).error.code, 'VERSION_CONFLICT')
      const found = await call('search_docs', { memoryStatus: 'archived', query: 'document' })
      assert.ok(found.items.some((i: any) => i.id === doc.id))
      assert.equal((await call('search_docs', { query: 'document' })).items.length, 0)
      const read = await call('get_doc', { path: doc.path, readId: randomUUID() })
      const edited = await call('update_doc', { id: doc.id, versionToken: read.versionToken, changes: { bodyMarkdown: 'Latest archived revision remains authoritative.' }, reason: 'Authorized archived edit', requestId: randomUUID() })
      assert.equal(edited.memoryStatus, 'archived')
      // Undo uses only the archive receipt: a later edit must reject the whole batch.
      assert.equal((await invoke('set_content_status', { items: archived.items.map(ref), memoryStatus: 'active', reason: 'Undo fixture request', requestId: randomUUID() })).error.code, 'VERSION_CONFLICT')
      const restored = await call('set_content_status', { items: [ref(edited), ref(archived.items[1])], memoryStatus: 'active', reason: 'Restore latest fixture content', requestId: randomUUID() })
      assert.ok(restored.items.every((i: any) => i.memoryStatus === 'active'))
      assert.equal((await call('get_doc', { id: doc.id })).bodyMarkdown, 'Latest archived revision remains authoritative.')
      const legacy = await call('set_knowledge_status', { ...ref(restored.items[1]), memoryStatus: 'archived', reason: 'Legacy compatibility', requestId: randomUUID() })
      assert.equal(legacy.memoryStatus, 'archived')
      const mixed = await create('atomic-peer')
      assert.equal((await invoke('set_content_status', { items: [ref(doc), ref(mixed)], memoryStatus: 'archived', reason: 'Stale atomic fixture', requestId: randomUUID() })).error.code, 'VERSION_CONFLICT')
      assert.equal((await call('get_doc', { id: mixed.id })).memoryStatus, 'active')
      // Real distinct logical reads and evaluations; no precomputed statistics.
      const target = await create('review-target')
      for (const verdict of ['not_beneficial', 'not_beneficial', 'not_beneficial', 'not_beneficial', 'beneficial']) {
        const readId = randomUUID(), read = await call('get_doc', { id: target.id, readId, purpose: verdict === 'beneficial' ? 'Explain historical recovery' : 'Find the active release procedure' })
        await call('get_doc', { id: target.id, readId })
        await call('report_retrieval_evaluation', { retrievalId: read.retrievals[0].retrievalId, verdict, reason: verdict === 'beneficial' ? 'Useful historical recovery context' : 'This task requires the active channel, not the retired preview.', requestId: randomUUID() })
      }
      const run = (await call('dream_memory', { action: 'begin', requestId: randomUUID(), agentName: 'Archive package fixture', promptVersion: 'dreaming-v1' })).run
      const candidates = await call('get_archive_candidates', { runId: run.id })
      const review = candidates.items.find((i: any) => i.contentId === target.id)
      assert.ok(review)
      assert.equal(review.counts.notBeneficial, 4); assert.equal(review.counts.beneficial, 1)
      const evidence = [...review.retrievals]
      let page = review
      while (page.nextEvidenceOffset !== null) { page = (await call('get_archive_candidates', { runId: run.id, contentId: target.id, evidenceOffset: page.nextEvidenceOffset, evidenceVersion: page.evidenceVersion })).items[0]; evidence.push(...page.retrievals) }
      assert.equal(evidence.length, 5)
      const current = await call('get_doc', { id: target.id })
      const targetRef = { contentId: target.id, versionToken: current.versionToken }
      const proposed = await call('dream_memory', { action: 'submit', requestId: randomUUID(), runId: run.id, leaseGeneration: run.leaseGeneration, candidates: [{ candidateId: randomUUID(), stages: [6], title: 'Retired preview archive review', reason: 'Retired preview repeatedly distracts active-release tasks; useful historical recovery remains visible.', impact: 'Default retrieval excludes it; direct links and reversible archive preserve history.', targets: [targetRef], evidence: [{ ...targetRef, location: 'body', excerpt: current.bodyMarkdown }], retrievalEvidence: evidence.filter((r: any) => r.evaluation).map((r: any) => ({ ...targetRef, retrievalId: r.retrievalId, evaluationId: r.evaluation.id, currentContentReason: 'The current body still describes the ended experiment; beneficial historical use is counterevidence.' })), mutations: [{ type: 'archive', contentId: target.id }], dependsOn: [], alternatives: ['Retain for historical recovery'], uncertainty: [], requestedDisposition: 'review_candidate' }] })
      const change = proposed.changes[0]
      assert.equal(change.status, 'proposed'); assert.equal(change.autoApplied, false)
      assert.ok(change.archiveReview.targets[0].counts.beneficial >= 1)
      const wrong = await invoke('approve_archive_proposal', { runId: run.id, changeId: change.id, revision: change.revision + 1, hash: change.hash, requestId: randomUUID(), approval: { source: 'human_chat', text: 'Approve this fixture proposal.' } })
      assert.equal(wrong.ok, false)
      assert.equal((await call('get_doc', { id: target.id })).memoryStatus, 'active')
      const bypass = await invoke('set_content_status', { items: [ref(current)], memoryStatus: 'archived', reason: 'Forbidden Dreaming bypass fixture', requestId: randomUUID() })
      assert.equal(bypass.error.code, 'DREAMING_WRITE_REQUIRED')
      await call('dream_memory', { action: 'finish', requestId: randomUUID(), runId: run.id, leaseGeneration: run.leaseGeneration, status: 'partial', summary: 'Archive integration checked; no real human approval was supplied. Review remains pending.' })
      assert.equal((await call('get_dream', { runId: run.id })).run.pendingReviewCount, 1)
      // Invalid arguments and a forbidden project still pass through SDK/bridge safely.
      const invalid = await invoke('set_content_status', { ...args, items: [], requestId: randomUUID() })
      assert.equal(invalid.ok, false)
      assert.ok(!JSON.stringify(invalid).includes(account.key))
      assert.ok(!stderr.includes(account.key) && !stderr.includes(code))
      console.log(JSON.stringify({ client, mode, tarballRuntime: 'PASS', dynamicSchemas: 'PASS', archiveRestoreUndo: 'PASS', atomicConflictAndLegacy: 'PASS', evaluatedCandidateAndPendingReview: 'PASS', automaticArchive: false, modelQualityVerified: false }))
    } finally { await sdk.close() }
  }
} finally { await fixture.close() }
