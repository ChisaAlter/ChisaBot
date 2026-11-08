import { createRequire } from 'node:module';

const require = createRequire(new URL('../../runtime/dsh/package.json', import.meta.url));
const runtimeVersion = require('@deepseek-ai/dsh/package.json').version;
const declaredVersion = require('../../runtime/dsh/package.json').dependencies['@deepseek-ai/dsh'];
if (runtimeVersion !== declaredVersion) throw new Error('The installed DSH version does not match its manifest.');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 9)) throw new Error('DSH requires Node >= 24.9.');
// Product readers retain preceding contracts: 1 = typed inbox/attachments/skills;
// 2 = durable personal sends and verified task outcomes. Reader 1 could replay these effects
// or mark a task complete without its required evidence, even though native logs still open.
export const compatibility = { protocol: 1, runtimeVersion, historyReader: `dsh-${runtimeVersion}`, conversationReader: 2 };
if (process.argv.includes('--print')) console.log(JSON.stringify(compatibility));
