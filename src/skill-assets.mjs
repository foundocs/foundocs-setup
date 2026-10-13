import { readFileSync } from 'node:fs';

export const SKILL_NAME = 'foundocs-capture-knowledge';
export const SKILL_FILES = ['SKILL.md', 'references/writing-guide.md'];

export function skillDirectory(client) {
  if (!['codex', 'claude'].includes(client)) throw new Error('Unsupported skill client');
  return `${client === 'claude' ? '.claude' : '.agents'}/skills/${SKILL_NAME}`;
}

export function knowledgePolicy(client) {
  return readFileSync(new URL('../templates/knowledge-policy.md', import.meta.url), 'utf8')
    .replaceAll('{{SKILL_PATH}}', `${skillDirectory(client)}/SKILL.md`).trim();
}

export function dreamingPolicy(client) {
  const directory = `${client === 'claude' ? '.claude' : '.agents'}/skills/foundocs`;
  return `### Dreaming\n\nFor an explicit Dreaming request (including “꿈꾸자” or “꿈구자”), read [foundocs](${directory}/SKILL.md) before starting. Quoted triggers and ordinary knowledge capture do not start Dreaming. During Dreaming, follow that protocol instead of ordinary knowledge capture: submit proposals through dream_memory and leave meaningful changes for owner review. If dream_memory or get_dream is unavailable, explain the missing capability; never simulate Dreaming with generic document mutations.`;
}

export function updatePolicy(client) {
  const prefix = skillDirectory(client).slice(0, -SKILL_NAME.length);
  return readFileSync(new URL('../templates/update-policy.md', import.meta.url), 'utf8')
    .replaceAll('{{UPDATE_GUIDE_PATH}}', `${prefix}foundocs/references/updates.md`).trim();
}

export function skillAssets(client) {
  const prefix = skillDirectory(client).slice(0, -SKILL_NAME.length);
  return [
    ...SKILL_FILES.map(name => ({ name: `${SKILL_NAME}/${name}` })),
    ...['SKILL.md', 'references/dreaming.md', 'references/updates.md', 'scripts/check-update.mjs'].map(name => ({ name: `foundocs/${name}` })),
  ].map(({ name }) => ({
    name: `${prefix}${name}`,
    content: readFileSync(new URL(`../skills/${name}`, import.meta.url), 'utf8'),
  })).concat([{
    name: `${prefix}foundocs/release.json`,
    content: `${JSON.stringify({ version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version })}\n`,
  }]);
}
