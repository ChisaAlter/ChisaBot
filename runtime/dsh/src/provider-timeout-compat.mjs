import { registerHooks } from "node:module";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";

// Node fetch otherwise applies its own five-minute header/body idle deadlines.
// Compose with the existing dispatcher so proxy and connection setup stay intact.
setGlobalDispatcher(
  getGlobalDispatcher().compose(
    (dispatch) => (options, handler) =>
      dispatch({ ...options, headersTimeout: 0, bodyTimeout: 0 }, handler),
  ),
);

// The locked adapter rejects a zero idle deadline; the OpenAI/Anthropic SDKs arm
// an immediate timer for timeout: 0. Give zero its usual no-deadline meaning in
// this Host only, without modifying installed dependencies or dropping stop signals.
// Remove this bridge when those dependencies natively support unbounded requests.
const adapter = "/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js";
const sdks = [
  "/node_modules/openai/client.mjs",
  "/node_modules/@anthropic-ai/sdk/client.mjs",
];

function replace(source, before, after, url) {
  if (!source.includes(before))
    throw new Error(`Provider timeout compatibility needs updating: ${url}`);
  return source.replace(before, after);
}

registerHooks({
  load(url, context, nextLoad) {
    const isAdapter = url.endsWith(adapter);
    if (!isAdapter && !sdks.some((path) => url.endsWith(path)))
      return nextLoad(url, context);
    const loaded = nextLoad(url, context);
    let source = String(loaded.source);
    if (isAdapter) {
      source = replace(
        source,
        "streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE)",
        "streamIdleTimeoutMs: z.number().min(0)",
        url,
      );
      source = replace(
        source,
        "streamIdleTimeoutMs <= 0",
        "streamIdleTimeoutMs < 0",
        url,
      );
      source = replace(
        source,
        'idleWatchdog(upstream, streamIdleTimeoutMs, "LLM_STREAM_IDLE_TIMEOUT")',
        '(streamIdleTimeoutMs === 0 ? { signal: upstream, next: (iterator) => iterator.next(), [Symbol.dispose]() {} } : idleWatchdog(upstream, streamIdleTimeoutMs, "LLM_STREAM_IDLE_TIMEOUT"))',
        url,
      );
    } else {
      source = replace(
        source,
        "const timeout = setTimeout(abort, ms);",
        "const timeout = ms > 0 ? setTimeout(abort, ms) : undefined;",
        url,
      );
    }
    return { ...loaded, source };
  },
});
