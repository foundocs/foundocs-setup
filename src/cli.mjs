#!/usr/bin/env node
import { install, doctor, rollback, updateSkills, SetupError } from './setup.mjs';

const [command, ...args] = process.argv.slice(2);
try {
  if (command === '--help' || command === '-h') {
    process.stdout.write('foundocs-setup install --root ABSOLUTE_PATH < private-input.json\nfoundocs-setup doctor --root ABSOLUTE_PATH\nfoundocs-setup update-skills --root ABSOLUTE_PATH\nfoundocs-setup rollback --root ABSOLUTE_PATH\nInstall reads the one-time code from private stdin only. Never put credentials in argv or shell command text.\n');
  } else {
    if (!['install', 'doctor', 'rollback', 'update-skills'].includes(command) || args.length !== 2 || args[0] !== '--root') throw new SetupError('input', 'Use install, doctor, rollback, or update-skills with --root ABSOLUTE_PATH.');
    let result;
    if (command === 'install') {
      if (process.stdin.isTTY) throw new SetupError('input', 'Supply installation JSON through private stdin.');
      let input = '';
      for await (const chunk of process.stdin) {
        input += chunk;
        if (Buffer.byteLength(input) > 16384) throw new SetupError('input', 'Installation input exceeds 16 KiB.');
      }
      try { input = JSON.parse(input); } catch { throw new SetupError('input', 'Installation input must be JSON.'); }
      result = await install(args[1], input);
    } else result = await (command === 'doctor' ? doctor : command === 'update-skills' ? updateSkills : rollback)(args[1]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  const safe = error instanceof SetupError ? { stage: error.stage, message: error.message, ...error.details } : { stage: 'local', message: 'Local operation failed. Check permissions and rerun; existing files and saved credentials are preserved.' };
  process.stderr.write(`${JSON.stringify({ ok: false, ...safe })}\n`);
  process.exitCode = 1;
}
