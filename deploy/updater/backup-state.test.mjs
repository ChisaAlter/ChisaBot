import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { beginBackup, completeBackup, pruneBackups, backupStatus } from './backup-state.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'chisabot-backup-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true });
  });
  const batch = async (name, kind = 'update', date = new Date().toISOString(), complete = true) => {
    const path = join(root, name);
    await mkdir(path);
    await beginBackup(path, kind);
    await writeFile(join(path, 'database.dump'), 'retained data');
    if (complete) await completeBackup(path);
    const marker = JSON.parse(await readFile(join(path, 'backup-manifest.json'), 'utf8'));
    marker.createdAt = date;
    marker.completedAt = date;
    await writeFile(join(path, 'backup-manifest.json'), JSON.stringify(marker));
    return path;
  };
  return { root, batch };
}

test('update retention removes only its complete batches and preserves manual/protected/partial backups', async t => {
  const f = await fixture(t);
  const old = await f.batch('old', 'update', '2026-11-01T00:00:00Z');
  const keep = await f.batch('new', 'update', '2026-11-08T00:00:00Z');
  const protectedPath = await f.batch('protected', 'update', '2026-10-01T00:00:00Z');
  await writeFile(join(protectedPath, '.keep'), 'migration restore');
  const partial = await f.batch('partial', 'update', '2026-09-01T00:00:00Z', false);
  const full = await f.batch('full', 'full', '2026-10-01T00:00:00Z');
  const manual = join(f.root, 'dsh-cutover-20261108');
  await mkdir(manual); await writeFile(join(manual, 'valuable.dump'), 'original history');
  assert.deepEqual(await pruneBackups(f.root, 'update', 1), { removed: 1, retained: 2 });
  await assert.rejects(stat(old), { code: 'ENOENT' });
  for (const path of [keep, protectedPath, partial, full, manual]) assert.ok((await stat(path)).isDirectory());
  assert.equal(await readFile(join(manual, 'valuable.dump'), 'utf8'), 'original history');
});

test('full retention keeps distinct days and weeks, not repeated snapshots from one day', async t => {
  const f = await fixture(t);
  const dayOld = await f.batch('today-old', 'full', '2026-11-08T00:00:00Z');
  const today = await f.batch('today', 'full', '2026-11-08T12:00:00Z');
  const yesterday = await f.batch('yesterday', 'full', '2026-11-07T00:00:00Z');
  const previousWeek = await f.batch('previous-week', 'full', '2026-10-31T00:00:00Z');
  const older = await f.batch('older', 'full', '2026-10-20T00:00:00Z');
  await pruneBackups(f.root, 'full', 2, 2);
  for (const path of [today, yesterday, previousWeek]) assert.ok((await stat(path)).isDirectory());
  for (const path of [dayOld, older]) await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('backup readiness detects missing or changed artifacts, stale age and absent offsite evidence', async t => {
  const f = await fixture(t), now = Date.parse('2026-11-08T08:00:00Z');
  assert.equal((await backupStatus(f.root, 30, false, now)).local, 'missing');
  const path = await f.batch('full', 'full', '2026-11-08T00:00:00Z');
  assert.equal((await backupStatus(f.root, 30, false, now)).ok, true);
  assert.equal((await backupStatus(f.root, 30, true, now)).ok, false);
  await writeFile(join(path, 'offsite-receipt.json'), JSON.stringify({ transport: 'restic', snapshotId: 'abcdef1234567890' }));
  assert.equal((await backupStatus(f.root, 30, true, now)).ok, true);
  assert.equal((await backupStatus(f.root, 1, true, now)).local, 'stale');
  await writeFile(join(path, 'database.dump'), 'short');
  assert.equal((await backupStatus(f.root, 30, true, now)).local, 'incomplete');
});

test('partial empty backup cannot be promoted to complete or rotated away', async t => {
  const f = await fixture(t), path = join(f.root, 'partial');
  await mkdir(path); await beginBackup(path, 'full');
  await writeFile(join(path, 'database.dump'), '');
  await assert.rejects(completeBackup(path), /Empty backup artifact/);
  await pruneBackups(f.root, 'full', 1, 1);
  assert.equal((await backupStatus(f.root)).local, 'missing');
  assert.ok((await stat(path)).isDirectory());
});
