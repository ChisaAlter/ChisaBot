# Pipeline run: dogfood deploy catch-up v0.1.44 → v0.1.48 (2026-10-20)

## Scope
日常狗粮发现 Haupt 停在 v0.1.44，而 main/mirror 已到 v0.1.48（behind 18）。本轮只做 updater 追部署，不做新功能 / 不 resume 电车。

## Deploy
- Host: kvm18048 / `sh /opt/chisabot-ops/deploy-serial.sh 1c97047 dogfood-routine`
- Image: `local/chisabot:auto-202610200205-1c97047`
- Commit: `1c970471990ff7fdbe40fe919c6b1c3c4d0bd027` (release/v0.1.48 merge)
- `/api/version` = **0.1.48**
- post-deploy-smoke: PASSED
- sync-nginx --check: ALL GREEN
- isolate-sidecar --verify: ALL GREEN

## Not done
- UI dogfood blocked on login (box browser at `/login`)
- No new app PR; tram schedule left paused

