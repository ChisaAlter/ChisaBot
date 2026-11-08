import { writeFileSync } from 'node:fs';

export const name = 'chisabot-durability-fault';
export const inject = ['sessions'];
export function apply(ctx, config) {
  let armed = true;
  ctx.on('session/event', (session, event) => {
    if (!armed || event.type !== 'tool/result') return;
    armed = false;
    const crash = () => {
      writeFileSync(config.evidence, JSON.stringify({ seq: event.seq, event, mode: config.mode }));
      process.kill(process.pid, 'SIGKILL');
    };
    // Synchronous exit prevents the 200ms buffer drain or next model checkpoint from
    // committing the result; the tool call itself was checkpointed before execution.
    if (config.mode === 'unflushed') crash();
    // Finish synchronous event publication before taking the barrier: persistence's
    // session/event listener must first receive the just-published event.
    else void Promise.resolve().then(() => ctx.sessions.flush(session)).then(crash);
  });
}
