#!/usr/bin/env node
import { install, doctor, rollback, updateSkills, migrate, SetupError } from './setup.mjs';

const [command, ...args] = process.argv.slice(2);
try {
  if (command === '--help' || command === '-h') {
    process.stdout.write('foundocs-setup install --root ABSOLUTE_PATH < private-input.json\nfoundocs-setup doctor --root ABSOLUTE_PATH\nfoundocs-setup update-skills --root ABSOLUTE_PATH\nfoundocs-setup rollback --root ABSOLUTE_PATH\nfoundocs-setup migrate --root ABSOLUTE_PATH\nfoundocs-setup mcp --project-id UUID\nfoundocs-setup measure prepare|run|flush --root ABSOLUTE_PATH < private-task.json\nInstall reads the one-time code from private stdin only. Never put credentials in argv or shell command text.\n');
  } else if (command === 'measure') {
    if (args.length !== 3 || !['prepare', 'run', 'flush'].includes(args[0]) || args[1] !== '--root') throw new SetupError('input', 'Use measure prepare|run|flush --root ABSOLUTE_PATH with JSON on stdin.');
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 65536) throw new SetupError('input', 'Measurement input exceeds 64 KiB.'); }
    let parsed; try { parsed = JSON.parse(input); } catch { throw new SetupError('input', 'Measurement input must be JSON.'); }
    const { measure } = await import('./effect.mjs');
    try { process.stdout.write(`${JSON.stringify(await measure(args[0], args[2], parsed))}\n`); }
    catch (error) { throw new SetupError('measurement', 'Measurement did not complete. Ordinary Foundocs work may continue without a sample; do not recreate the task or repeat inference.', { reason: error.code ?? 'local_failure' }); }
  } else if (command === 'mcp') {
    if (args.length !== 2 || args[0] !== '--project-id') throw new SetupError('runtime', 'Use mcp --project-id UUID from the configured project directory.');
    const { startRuntime } = await import('./runtime.mjs');
    await startRuntime(args[1]);
  } else {
    if (!['install', 'doctor', 'rollback', 'update-skills', 'migrate'].includes(command) || args.length !== 2 || args[0] !== '--root') throw new SetupError('input', 'Use install, doctor, rollback, migrate, or update-skills with --root ABSOLUTE_PATH.');
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
    } else result = await (command === 'doctor' ? doctor : command === 'update-skills' ? updateSkills : command === 'migrate' ? migrate : rollback)(args[1]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  const safe = error instanceof SetupError ? { stage: error.stage, message: error.message, ...error.details } : { stage: 'local', message: 'Local operation failed. Check permissions and rerun; existing files and saved credentials are preserved.' };
  process.stderr.write(`${JSON.stringify({ ok: false, ...safe })}\n`);
  process.exitCode = 1;
}
