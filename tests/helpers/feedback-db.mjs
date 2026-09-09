import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { userInfo } from 'node:os';

function command(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${bin} failed: ${result.error?.message || result.stderr}`);
}

export async function disposablePostgres() {
  const available = spawnSync('initdb', ['--version'], { encoding: 'utf8' });
  if (available.error?.code === 'ENOENT') return null;
  const dir = await mkdtemp(resolve('../feedback-pg-'));
  const data = join(dir, 'data');
  const listener = net.createServer();
  await new Promise((done) => listener.listen(0, '127.0.0.1', done));
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  command('initdb', ['-D', data, '-A', 'trust', '--no-locale', '-E', 'UTF8']);
  command('pg_ctl', ['-D', data, '-l', join(dir, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ''`, '-w', 'start']);
  return {
    url: `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:${port}/postgres`,
    async close() {
      command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
