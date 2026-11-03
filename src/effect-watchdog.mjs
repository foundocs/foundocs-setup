// Non-model supervisor: remains alive when the coordinator dies, kills its CLI group.
import { spawn } from 'node:child_process';
const [serializedArgs, timeoutText] = process.argv.slice(2);
let child, ended = false, stopping = false, input = '';
const timers = [];
function signal(name) { if (!child?.pid || ended) return; try { process.kill(-child.pid, name); } catch { child.kill(name); } }
function stop() {
  if (stopping) return; stopping = true;
  if (!child) { process.exit(1); return; }
  signal('SIGINT'); timers.push(setTimeout(() => signal('SIGTERM'), 3000), setTimeout(() => signal('SIGKILL'), 5000));
}
process.on('disconnect', stop);
process.on('message', message => { if (message?.type === 'stop') stop(); });
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, stop);
process.stdout.on('error', stop);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (Buffer.byteLength(input) > 256 * 1024) stop(); });
process.stdin.on('end', () => {
  if (stopping || !process.connected) return stop();
  child = spawn('claude', JSON.parse(serializedArgs), { cwd: process.cwd(), env: process.env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const timeout = setTimeout(stop, Number(timeoutText));
  child.stdout.pipe(process.stdout); child.stdin.on('error', () => {}); child.stdin.end(input); input = '';
  child.once('error', () => { clearTimeout(timeout); process.exit(1); });
  child.once('close', code => { ended = true; clearTimeout(timeout); timers.forEach(clearTimeout); process.exit(code ?? 1); });
});
