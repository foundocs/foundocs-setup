import { readFileSync } from 'node:fs';

export const SKILL_NAME = 'foundocs-capture-knowledge';
export const SKILL_FILES = ['SKILL.md', 'references/writing-guide.md'];

export function skillDirectory(client) {
  if (!['codex', 'claude'].includes(client)) throw new Error('Unsupported skill client');
  return `${client === 'claude' ? '.claude' : '.agents'}/skills/${SKILL_NAME}`;
}

export function knowledgePolicy(client) {
  return readFileSync(new URL('../templates/knowledge-policy.md', import.meta.url), 'utf8')
    .replaceAll('{{SKILL_PATH}}', `${skillDirectory(client)}/SKILL.md`)
    .replaceAll('{{FOUNDOCS_SKILL_PATH}}', `${skillDirectory(client).slice(0, -SKILL_NAME.length)}foundocs/SKILL.md`).trim();
}

export function skillAssets(client) {
  const prefix = skillDirectory(client).slice(0, -SKILL_NAME.length);
  return [
    ...SKILL_FILES.map(name => ({ name: `${SKILL_NAME}/${name}` })),
    ...['SKILL.md', 'references/configuration.md', 'references/documents.md', 'references/dreaming.md', 'references/updates.md', 'scripts/check-update.mjs'].map(name => ({ name: `foundocs/${name}` })),
  ].map(({ name }) => ({
    name: `${prefix}${name}`,
    content: readFileSync(new URL(`../skills/${name}`, import.meta.url), 'utf8'),
  })).concat([{
    name: `${prefix}foundocs/release.json`,
    content: `${JSON.stringify({ version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version })}\n`,
  }]);
}
