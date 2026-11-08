import { createRequire } from 'node:module';

const require = createRequire(new URL('../../runtime/dsh/package.json', import.meta.url));
const runtimeVersion = require('@deepseek-ai/dsh/package.json').version;
const declaredVersion = require('../../runtime/dsh/package.json').dependencies['@deepseek-ai/dsh'];
if (runtimeVersion !== declaredVersion) throw new Error('The installed DSH version does not match its manifest.');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 9)) throw new Error('DSH requires Node >= 24.9.');
// The product reader includes typed inbox payloads and their retained attachments/skills.
// A pre-release DSH image can read native logs yet lose these product-level pending inputs.
export const compatibility = { protocol: 1, runtimeVersion, historyReader: `dsh-${runtimeVersion}`, conversationReader: 1 };
if (process.argv.includes('--print')) console.log(JSON.stringify(compatibility));
