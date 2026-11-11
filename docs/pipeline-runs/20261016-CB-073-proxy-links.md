# Pipeline run: CB-073 proxy links / sing-box (#174)

- Date: 2026-10-16 (Asia/Shanghai)
- Requirement: CB-073 Claude 上游代理支持节点链接（sing-box 转换，DESIGN §85）
- PR: https://github.com/ChisaAlter/ChisaBot/pull/174
- Plan: merge after own regression (standing approval); web/server via main updater; cloud-node image needs manual rebuild

## Status log

- 2026-10-16 ~14:11 CST: PR opened as CB-072 / §84 (feat/cc-proxy-links)
- 2026-10-16 ~14:33 CST: #175 (mode-switch, also CB-072 / §84) merged to main → #174 CONFLICTING
- 2026-10-16 ~14:50 CST: merged main into PR; renumbered this work to CB-073 / §85
- 2026-10-16 ~14:53 CST: box regression: `bun install --frozen-lockfile --linker hoisted` OK; `bun run typecheck` OK; `bun test shared/proxy-links.test.ts` 25 pass / 11 skip (no sing-box); left-mode-switch 7 pass; admin-smoke + health 17 pass
- 2026-10-16 ~14:55 CST: PR CI green after push
- 2026-10-16 14:56 CST: merged to main (`b38f0d81`); no client bump (PC unchanged; cloud-node image rebuild is manual)

## Notes

- ID clash with #175 resolved in merge commit docs only.
- Prod still needs `deploy/cloud-node` image rebuild for sing-box; old image keeps plain proxies.
