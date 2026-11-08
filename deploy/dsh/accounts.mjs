import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, chown } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
const docker = async (...args) => (await execute('docker', args, { maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const nap = ms => new Promise(resolve => setTimeout(resolve, ms));
const usage = 'node deploy/dsh/accounts.mjs reconcile <host-config.json> [--owners <owners.json> | --owner <id> ...] [--replace]\nnode deploy/dsh/accounts.mjs snapshot <host-config.json> <new-backup-directory>';
const [command, configPath, ...flags] = process.argv.slice(2);
const backupDirectory = command === 'snapshot' ? flags.shift() : undefined;
let replace = false, ownersPath;
const explicitOwners = [];
let invalid = false;
for (let at = 0; at < flags.length; at++) {
  if (flags[at] === '--replace') replace = true;
  else if (flags[at] === '--owners' && flags[at + 1]) ownersPath = flags[++at];
  else if (flags[at] === '--owner' && flags[at + 1]) explicitOwners.push(flags[++at]);
  else invalid = true;
}
if (!['reconcile', 'snapshot'].includes(command) || !configPath || invalid || (ownersPath && explicitOwners.length)
  || (command === 'snapshot' && (!backupDirectory || flags.length))) {
  console.error(usage); process.exit(2);
}
const config = JSON.parse(await readFile(resolve(configPath), 'utf8'));
for (const key of ['apiContainer', 'image', 'stateDirectory', 'apiTargetsDirectory']) {
  if (typeof config[key] !== 'string' || !config[key]) throw new Error(`Host config requires ${key}.`);
}
if (!isAbsolute(config.stateDirectory) || !isAbsolute(config.apiTargetsDirectory)) throw new Error('Target directories must be absolute.');
const uid = config.apiUid ?? 1002, gid = config.apiGid ?? 1002;
if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) throw new Error('API uid/gid must be non-root integers.');
const prefix = config.resourcePrefix ?? 'chisabot-dsh';
if (!/^[a-z][a-z0-9-]{0,20}$/.test(prefix)) throw new Error('resourcePrefix must be a short lowercase Docker name.');
function ipv4Range(cidr) {
  if (typeof cidr !== 'string') return undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr);
  if (!match) return undefined;
  const parts = match.slice(1, 5).map(Number), bits = Number(match[5]);
  if (parts.some(part => part > 255) || bits > 32) return undefined;
  const size = 2 ** (32 - bits), address = parts.reduce((value, part) => value * 256 + part, 0);
  return { start: Math.floor(address / size) * size, end: Math.floor(address / size) * size + size, bits, address };
}
const pool = config.networkPool === undefined ? undefined : ipv4Range(config.networkPool);
if (config.networkPool !== undefined && (!pool || pool.bits < 16 || pool.bits > 24 || pool.start !== pool.address
  || !['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].some(value => { const range = ipv4Range(value); return pool.start >= range.start && pool.end <= range.end; }))) {
  throw new Error('networkPool must be an aligned private IPv4 /16 to /24 range.');
}
async function networkSubnet() {
  if (!pool) return [];
  const ids = (await docker('network', 'ls', '--quiet')).split('\n').filter(Boolean);
  const networks = ids.length ? JSON.parse(await docker('network', 'inspect', ...ids)) : [];
  const used = networks.flatMap(network => network.IPAM?.Config ?? []).map(entry => ipv4Range(entry.Subnet)).filter(Boolean);
  for (let start = pool.start; start + 8 <= pool.end; start += 8) {
    if (used.some(range => start < range.end && start + 8 > range.start)) continue;
    const address = [24, 16, 8, 0].map(shift => Math.floor(start / 2 ** shift) % 256).join('.');
    return ['--subnet', `${address}/29`];
  }
  throw new Error('No account subnet is available inside networkPool.');
}
const port = config.apiPort ?? 3001;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid apiPort.');
const gatewayUrl = `http://chisabot-api:${port}/api/internal/dsh-tools`;
await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
await chown(config.stateDirectory, uid, gid);
const targetsPath = join(config.stateDirectory, 'targets.json');
try { await writeFile(targetsPath, '[]\n', { flag: 'wx', mode: 0o600 }); await chown(targetsPath, uid, gid); }
catch (error) { if (error.code !== 'EEXIST') throw error; }

// An OS lease keeps periodic and manual reconciliation from racing, without stale PID ownership.
if (!process.env.CHISABOT_ACCOUNTS_LOCKED) {
  const child = await execute('flock', ['--nonblock', '--conflict-exit-code', '73', join(config.stateDirectory, '.reconcile.lock'),
    process.execPath, ...process.argv.slice(1)], { env: { ...process.env, CHISABOT_ACCOUNTS_LOCKED: '1' }, maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  process.exit(0);
}
async function inspect(kind, name) {
  try { return JSON.parse(await docker(kind, 'inspect', name))[0]; }
  catch (error) {
    if (/No such (object|container|volume|network)|not found/i.test(String(error.stderr))) return undefined;
    throw error;
  }
}
async function atomic(path, data) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  await chown(`${path}.tmp`, uid, gid);
  await rename(`${path}.tmp`, path);
}
async function writeContainerInput(name, code, input) {
  // JSON is stdin data, never shell source or a Docker label interpreted by a shell.
  const { spawn } = await import('node:child_process');
  const child = spawn('docker', ['exec', '-i', name, '/usr/local/bin/node', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdin.end(JSON.stringify(input));
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (exit !== 0) throw new Error(`Runtime check failed (${exit}).`);
  return output.trim();
}
const inventoryProgram = `const postgres=require('/app/node_modules/postgres'); const sql=postgres(process.env.DATABASE_URL,{max:1});
try {const [table]=await sql\`select to_regclass('public.chisabot_runtime_bindings') as name\`;
if(table?.name){const [old]=await sql\`select count(*)::int as count from chisabot_runtime_bindings where runtime_id like 'managed:%'\`;if(old.count)throw Error('Existing managed DSH bindings need their Session volumes transferred before switching to account containers.');}
const rows=await sql\`select id from users order by id\`; console.log(JSON.stringify(rows.map(row=>row.id))); } finally {await sql.end({timeout:5});}`;
const owners = explicitOwners.length ? explicitOwners : ownersPath ? JSON.parse(await readFile(resolve(ownersPath), 'utf8'))
  : JSON.parse(await docker('exec', '-e', 'PATH=/command:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', config.apiContainer,
    '/command/with-contenv', '/command/s6-setuidgid', 'apiuser', '/usr/local/bin/bun', '-e', inventoryProgram));
if (!Array.isArray(owners) || owners.some(owner => typeof owner !== 'string' || !owner || owner.length > 256) || new Set(owners).size !== owners.length) throw new Error('Account inventory is invalid.');
const api = await inspect('container', config.apiContainer);
if (!api?.State?.Running) throw new Error('The API container must be running before reconciliation.');
// Each runtime can reach the API gateway. Anonymous single-user administrator access would turn
// that network path into cross-account authority even though the containers themselves are split.
await docker('exec', '-e', 'PATH=/command:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', config.apiContainer,
  '/command/with-contenv', '/command/s6-setuidgid', 'apiuser', '/usr/local/bin/bun', '-e',
  "const {loadConfig}=await import('/app/server/src/config.ts');const {gatewaySecretFromEnvironment,trustUnsignedLocal}=await import('/app/server/src/auth/gateway-identity.ts');const config=loadConfig();if(trustUnsignedLocal()||(config.singleUser&&!gatewaySecretFromEnvironment(process.env)))throw Error('Isolated account runtimes require authenticated API access; unsigned administrator access is not allowed.');");
const mount = api.Mounts.find(mount => mount.Destination === config.apiTargetsDirectory);
if (!mount || resolve(mount.Source) !== resolve(config.stateDirectory) || mount.RW) {
  throw new Error('Mount stateDirectory read-only at apiTargetsDirectory on the API container.');
}
const image = await inspect('image', config.image);
if (!image?.Id) throw new Error('The configured candidate image is not present.');
const index = [];
const report = { ready: 0, preparing: 0, updateRequired: 0 };
const healthProgram = `const fs=require('node:fs/promises'); const {pathToFileURL}=require('node:url');
(async()=>{const {DshHostClient}=await import(pathToFileURL('/app/runtime/dsh/src/client.mjs')); const address=JSON.parse(await fs.readFile('/state/connection.json','utf8'));
const endpoint=new URL(address.endpoint);
let input='';for await(const chunk of process.stdin)input+=chunk;const {sessionIds=[]}=JSON.parse(input);
let client; try {client=await DshHostClient.connect(endpoint.toString(),{signal:AbortSignal.timeout(5000)}); const health=await client.health(AbortSignal.timeout(5000)); if(health.ownerUserId!==JSON.parse(await fs.readFile('/state/chisabot.json','utf8')).ownerUserId||health.protocol!==1)throw Error('identity');
const watermarks=[];for(const sessionId of sessionIds){const history=await client.events(sessionId,{maxMessages:1},AbortSignal.timeout(10000));watermarks.push({sessionId,cursor:history.cursor})}
console.log(JSON.stringify({address,health:{ownerUserId:health.ownerUserId,version:health.version,generation:health.generation,running:health.sessions.filter(s=>s.state!=='idle').length},watermarks}));}finally{await client?.close()}})().catch(()=>process.exit(1));`;
if (replace || command === 'snapshot') {
  await docker('exec', '-e', 'PATH=/command:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', config.apiContainer,
    '/command/with-contenv', '/command/s6-setuidgid', 'apiuser', '/usr/local/bin/bun', '-e',
    "const {conversationAdmissionClosed}=await import('/app/server/src/conversations/maintenance.ts');if(!conversationAdmissionClosed())throw Error('Pause admission before replacing account runtimes.');");
}
if (command === 'snapshot') {
  const busy = await docker('exec', '-e', 'PATH=/command:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', config.apiContainer,
    '/command/with-contenv', '/command/s6-setuidgid', 'apiuser', '/usr/local/bin/bun', '-e',
    "const postgres=require('/app/node_modules/postgres');const sql=postgres(process.env.DATABASE_URL,{max:1});try{const [r]=await sql`select (select count(*) from openbot_local_threads where lock_expires_at>now())+(select count(*) from chisabot_dsh_runs where status in ('admitting','observing','projecting'))+(select count(*) from chisabot_tool_operations where status='dispatching') as count`;console.log(r.count)}finally{await sql.end({timeout:5})}");
  if (busy !== '0') throw new Error('Product execution or an external operation is still active; snapshot refused.');
  const savedTargets = JSON.parse(await readFile(targetsPath, 'utf8'));
  if (savedTargets.length !== owners.length || owners.some(owner => !savedTargets.some(target => target.ownerUserId === owner))) {
    throw new Error('Every account must have a ready runtime before taking the coordinated snapshot.');
  }
  const projection = JSON.parse(await docker('exec', '-e', 'PATH=/command:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', config.apiContainer,
    '/command/with-contenv', '/command/s6-setuidgid', 'apiuser', '/usr/local/bin/bun', '-e',
    "const postgres=require('/app/node_modules/postgres');const sql=postgres(process.env.DATABASE_URL,{max:1});try{const [projection]=await sql`select coalesce(max(sequence),0)::text as cursor from openbot_local_events`;const bindings=await sql`select id,thread_id,revision,owner_user_id,runtime_id,session_id,active from chisabot_runtime_bindings where kernel='dsh' order by owner_user_id,thread_id,revision`;console.log(JSON.stringify({cursor:projection.cursor,bindings}))}finally{await sql.end({timeout:5})}"));
  if (projection.bindings.some(binding => !savedTargets.some(target => target.ownerUserId === binding.owner_user_id && target.id === binding.runtime_id))) {
    throw new Error('A conversation binding has no matching account runtime; snapshot refused.');
  }
  const destination = resolve(backupDirectory);
  await mkdir(destination, { mode: 0o700 });
  const manifest = [];
  for (const owner of owners) {
    const key = createHash('sha256').update(owner).digest('hex').slice(0, 32);
    const name = `${prefix}-${key}`, volume = `${name}-state`;
    const container = await inspect('container', name);
    if (!container?.State.Running || container.Config.Labels?.['chisabot.runtime-owner'] !== owner) throw new Error('An account runtime is missing; snapshot incomplete.');
    const bindings = projection.bindings.filter(binding => binding.owner_user_id === owner);
    const status = JSON.parse(await writeContainerInput(name, healthProgram, { sessionIds: bindings.map(binding => binding.session_id) }));
    if (status.health.running) throw new Error('An account runtime is still running; snapshot incomplete.');
    const info = await inspect('volume', volume);
    if (!info || info.Labels?.['chisabot.runtime-owner'] !== owner) throw new Error('Account volume ownership mismatch.');
    await execute('tar', ['czf', join(destination, `${key}.tgz`), '-C', info.Mountpoint, '.']);
    manifest.push({ ownerUserId: owner, volume, archive: `${key}.tgz`, image: container.Image,
      runtime: status.health, bindings, watermarks: status.watermarks });
  }
  const { spawn } = await import('node:child_process');
  const { createWriteStream } = await import('node:fs');
  const dump = createWriteStream(join(destination, 'chisabot.dump'), { mode: 0o600 });
  const child = spawn('docker', ['exec', '-e', 'PATH=/command:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', config.apiContainer,
    '/command/with-contenv', '/bin/sh', '-c', 'exec pg_dump -Fc "$DATABASE_URL"'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(dump); child.stderr.resume();
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('Database snapshot failed.'))); });
  await Promise.all([done, new Promise((resolve, reject) => { dump.once('finish', resolve); dump.once('error', reject); })]);
  await writeFile(join(destination, 'accounts.json'), `${JSON.stringify({ capturedAt: new Date().toISOString(), projectionCursor: projection.cursor, accounts: manifest })}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: 'ok', accounts: manifest.length }));
  process.exit(0);
}
for (const owner of owners) {
  // Stable resource identity, not a content-integrity check. Full owner label is checked on reuse.
  const key = createHash('sha256').update(owner).digest('hex').slice(0, 32);
  const name = `${prefix}-${key}`, network = `${name}-net`, volume = `${name}-state`;
  const label = 'chisabot.runtime-owner';
  let existing = await inspect('container', name);
  if (existing && existing.Config.Labels?.[label] !== owner) throw new Error('An unrelated container owns the account resource name.');
  if (existing && existing.Image !== image.Id && replace) {
    const status = JSON.parse(await writeContainerInput(name, healthProgram, {}));
    if (status.health.running) throw new Error('An account execution is still active; runtime replacement refused.');
    const before = await docker('exec', name, 'cat', '/app/deploy/dsh/runtime-compat.json');
    const after = await docker('run', '--rm', '--network', 'none', '--entrypoint', 'cat', image.Id, '/app/deploy/dsh/runtime-compat.json');
    if (before !== after) throw new Error('The replacement image must have a verified compatible DSH reader.');
    await docker('stop', '--time', '30', name);
    await docker('rm', name);
    existing = undefined;
  }
  const previousNetwork = await inspect('network', network);
  if (previousNetwork && previousNetwork.Labels?.[label] !== owner) throw new Error('An unrelated network owns the account resource name.');
  if (!previousNetwork) await docker('network', 'create', '--label', `${label}=${owner}`, ...await networkSubnet(), network);
  if (!api.NetworkSettings.Networks[network]) await docker('network', 'connect', '--alias', 'chisabot-api', network, config.apiContainer);
  const previousVolume = await inspect('volume', volume);
  if (previousVolume && previousVolume.Labels?.[label] !== owner) throw new Error('An unrelated volume owns the account resource name.');
  if (!previousVolume) await docker('volume', 'create', '--label', `${label}=${owner}`, volume);
  if (!existing) {
    const init = `const fs=require('node:fs');const dir='/state';const c=JSON.parse(process.argv[1]);fs.mkdirSync(dir,{recursive:true});fs.chownSync(dir,${uid},${gid});fs.chmodSync(dir,448);const path=dir+'/chisabot.json';if(fs.existsSync(path)&&JSON.parse(fs.readFileSync(path,'utf8')).ownerUserId!==c.ownerUserId)throw Error('owner mismatch');fs.writeFileSync(path,JSON.stringify(c),{mode:384});fs.chownSync(path,${uid},${gid});`;
    await docker('run', '--rm', '--network', 'none', '--user', '0', '--read-only', '--mount', `type=volume,src=${volume},dst=/state`,
      '--entrypoint', '/usr/local/bin/node', image.Id, '-e', init, JSON.stringify({ ownerUserId: owner, port: 3086,
        trustedHosts: [name], gatewayUrl, providers: {} }));
    // DSH intentionally rejects wildcard binds. Docker may assign a new IP on restart;
    // derive the one account bridge address inside the container on each launch.
    const start = "const fs=await import('node:fs/promises');const os=await import('node:os');const addresses=Object.values(os.networkInterfaces()).flat().filter(a=>a.family==='IPv4'&&!a.internal);if(addresses.length!==1)throw Error('Expected one private account network.');const file='/state/chisabot.json';const config=JSON.parse(await fs.readFile(file,'utf8'));config.host=addresses[0].address;config.trustedHosts=[os.hostname(),config.host];await fs.writeFile(file,JSON.stringify(config),{mode:384});await import('/app/runtime/dsh/src/start.mjs');";
    await docker('run', '-d', '--name', name, '--hostname', name, '--network', network, '--network-alias', name,
      '--user', `${uid}:${gid}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '96',
      '--memory', config.runtimeMemory ?? '512m', '--cpus', String(config.runtimeCpus ?? 1), '--restart', 'unless-stopped',
      '--log-driver', 'json-file', '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864', '--mount', `type=volume,src=${volume},dst=/state`,
      '--label', `${label}=${owner}`, '--label', `chisabot.runtime-family=${prefix}`, '--workdir', '/state',
      '--no-healthcheck', '--entrypoint', '/usr/bin/env', image.Id, '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/state',
      // The official loader otherwise dlopens a copy under /tmp, whose tmpfs is intentionally
      // non-executable. Immutable image binaries need no Windows DLL-replacement cache.
      'NARB_DISABLE_NATIVE_CACHE=1', 'CHISABOT_DSH_HOME=/state', 'DO_NOT_TRACK=1', '/usr/local/bin/node', '--input-type=module', '-e', start);
    existing = await inspect('container', name);
  } else if (!existing.State.Running) {
    await docker('start', name);
  }
  if (existing.Image !== image.Id) report.updateRequired++;
  let result;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { result = JSON.parse(await writeContainerInput(name, healthProgram, {})); break; }
    catch { await nap(500); }
  }
  if (!result || result.health.ownerUserId !== owner) { report.preparing++; continue; }
  const address = new URL(result.address.endpoint);
  address.hostname = name; address.port = '3086';
  const connectionName = `${key}.json`;
  await atomic(join(config.stateDirectory, connectionName), { ...result.address, endpoint: address.toString() });
  index.push({ id: `account:${key}`, ownerUserId: owner, connectionFile: join(config.apiTargetsDirectory, connectionName) });
  report.ready++;
}
await atomic(targetsPath, index);
console.log(JSON.stringify(report));
if (report.preparing || report.updateRequired) process.exitCode = 1;
