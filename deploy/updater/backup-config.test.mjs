import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const script = fileURLToPath(new URL('./backup-config.mjs', import.meta.url));

test('configuration preflight requires external active mounts and excludes operational targets/spool', async t => {
  const root = await mkdtemp(join(tmpdir(), 'chisabot-backup-config-'));
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true }); });
  const destination = join(root, 'backup', 'config'), compose = join(root, 'deployment'), certs = join(root, 'certificates');
  for (const path of [destination, compose, certs, join(compose, 'auth')]) await mkdir(path, { recursive: true });
  await writeFile(join(destination, 'dsh-accounts.json'), JSON.stringify({ apiTargetsDirectory: '/runtime-targets' }));
  await writeFile(join(destination, 'containers.json'), JSON.stringify([{ Mounts: [
    { Type: 'bind', Source: join(compose, 'auth'), Destination: '/auth' },
    { Type: 'bind', Source: certs, Destination: '/etc/letsencrypt' },
    { Type: 'bind', Source: '/not-read-targets', Destination: '/runtime-targets' },
    { Type: 'bind', Source: '/not-read-spool', Destination: '/var/lib/chisabot-updater/requests' },
  ] }]));
  await assert.rejects(execute(process.execPath, [script, destination, compose, '[]', '--check']), error => /CHISABOT_BACKUP_EXTRA_PATHS/.test(error.stderr));
  await execute(process.execPath, [script, destination, compose, JSON.stringify([certs]), '--check']);
  await assert.rejects(execute(process.execPath, [script, destination, compose, JSON.stringify([root]), '--check']), error => /outside the backup tree/.test(error.stderr));
});
