import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

// Product readers retain all preceding product contracts; native DSH formats must match exactly.
export function canReadDshState(current, candidate) {
  return !!current && !!candidate
    && Number.isSafeInteger(current.protocol) && current.protocol > 0 && candidate.protocol === current.protocol
    && typeof current.runtimeVersion === 'string' && current.runtimeVersion.length > 0 && candidate.runtimeVersion === current.runtimeVersion
    && typeof current.historyReader === 'string' && current.historyReader.length > 0 && candidate.historyReader === current.historyReader
    && Number.isSafeInteger(current.conversationReader) && current.conversationReader > 0
    && Number.isSafeInteger(candidate.conversationReader) && candidate.conversationReader >= current.conversationReader;
}

// The release caller serializes writers with the host's reader lock. A snapshot or an old process
// observed after failed startup must never lower the floor already committed for a migrating image.
export function recordReaderFloor(path, observed) {
  if (!canReadDshState(observed, observed)) throw new Error('Invalid reader descriptor.');
  let current;
  try { current = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let next = observed;
  if (current) {
    if (canReadDshState(observed, current)) return current;
    if (!canReadDshState(current, observed)) throw new Error('Reader floor cannot change native formats.');
  }
  const temporary = `${path}.tmp-${process.pid}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(next)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path);
    // Persist the rename before a Linux deployment is allowed to start its migration.
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return next;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--record') recordReaderFloor(resolve(process.argv[3]), JSON.parse(process.argv[4]));
    else if (!canReadDshState(JSON.parse(process.argv[2]), JSON.parse(process.argv[3]))) process.exitCode = 1;
  }
  catch { process.exitCode = 1; }
}
