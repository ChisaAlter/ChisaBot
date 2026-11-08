import { readFile } from 'node:fs/promises';
import { DshHostClient } from './client.mjs';

/** Same owner/version/history checks for deployment and authenticated product health. No model calls. */
export async function inspectDshRuntime({ target, ownerUserId, sessionIds = [], expected, signal }) {
  const manifest = expected ?? { protocol: 1, runtimeVersion: JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).dependencies['@deepseek-ai/dsh'] };
  if (target.ownerUserId !== ownerUserId) throw new Error('DSH target owner mismatch.');
  const address = JSON.parse(await readFile(target.connectionFile, 'utf8'));
  const client = await DshHostClient.connect(address.endpoint, { signal });
  try {
    const health = await client.health(signal);
    if (!health.ok || health.ownerUserId !== ownerUserId || health.protocol !== manifest.protocol || health.version !== manifest.runtimeVersion) {
      throw new Error('DSH readiness identity, protocol or runtime version mismatch.');
    }
    const watermarks = [];
    for (const sessionId of sessionIds) {
      const history = await client.events(sessionId, { maxMessages: 1 }, signal);
      watermarks.push({ sessionId, cursor: history.cursor });
    }
    return { ok: true, version: health.version, protocol: health.protocol, sessions: health.sessions.length,
      running: health.sessions.filter(session => session.state !== 'idle').length, watermarks };
  } finally { await client.close(); }
}
