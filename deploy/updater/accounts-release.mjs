import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const [command, configPath, apiContainer, targetsDirectory, image] = process.argv.slice(2);
if (!['check', 'replace'].includes(command) || !configPath || !isAbsolute(configPath) || !apiContainer || !targetsDirectory) {
  throw new Error('accounts-release requires check|replace, an absolute config path, API container and mounted targets directory.');
}
const original = await readFile(configPath, 'utf8');
const config = JSON.parse(original);
if (config.apiContainer !== apiContainer || config.apiTargetsDirectory !== targetsDirectory) {
  throw new Error('Account host config does not belong to this API container/targets mount.');
}
if (command === 'replace') {
  if (!image || /\s/.test(image)) throw new Error('Replacement image is required.');
  const path = `${configPath}.release-${process.pid}.json`;
  try {
    await writeFile(path, `${JSON.stringify({ ...config, image })}\n`, { flag: 'wx', mode: 0o600 });
    const script = join(dirname(fileURLToPath(import.meta.url)), 'accounts.mjs');
    const result = await execute(process.execPath, [script, 'reconcile', path, '--replace'], { maxBuffer: 8 * 1024 * 1024 });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    // A concurrent operator edit must survive. Never replace its other account settings.
    if (await readFile(configPath, 'utf8') !== original) throw new Error('Account config changed during replacement; reconcile its image before resuming admission.');
    await rename(path, configPath);
  } finally {
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
} else {
  const metadata = await stat(configPath);
  if (!metadata.isFile()) throw new Error('Account config is not a regular file.');
}
