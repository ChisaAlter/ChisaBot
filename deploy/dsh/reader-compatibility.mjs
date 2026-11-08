import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Product readers retain all preceding product contracts; native DSH formats must match exactly.
export function canReadDshState(current, candidate) {
  return !!current && !!candidate
    && Number.isSafeInteger(current.protocol) && current.protocol > 0 && candidate.protocol === current.protocol
    && typeof current.runtimeVersion === 'string' && current.runtimeVersion.length > 0 && candidate.runtimeVersion === current.runtimeVersion
    && typeof current.historyReader === 'string' && current.historyReader.length > 0 && candidate.historyReader === current.historyReader
    && Number.isSafeInteger(current.conversationReader) && current.conversationReader > 0
    && Number.isSafeInteger(candidate.conversationReader) && candidate.conversationReader >= current.conversationReader;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!canReadDshState(JSON.parse(process.argv[2]), JSON.parse(process.argv[3]))) process.exitCode = 1; }
  catch { process.exitCode = 1; }
}
