# 并行开发协议

需求多的时候，几个开发者 / 自动化 worker 同时做不同功能。下面这套规则保证互不踩脚、`main` 永远可部署。
（2026-10-14 起实行；部署细节见 [ops/deploy.md](../ops/deploy.md)，PR 要求见 [CONTRIBUTING.md](../../CONTRIBUTING.md)。）

## 1. 先认领

- 在 [BACKLOG](../BACKLOG.md) 找到或新增一条（GitHub Issues 打开后用 issue），加上 `status: in-progress`，在 [ROADMAP](../ROADMAP.md)
  「现在」里写上分支名。
- 一个分支只做一条（或强相关的几条）。碰到别人正在改的同一块代码 / 同一个页面，先协调，不要两个人同时改。

## 2. 自己的 worktree 和分支

```sh
git fetch origin
git worktree add ../wt-<名字> -b <类型>/<名字> origin/main     # 类型：feat / fix / chore / docs
```

- 永远从最新的 `origin/main` 开分支；不要在别人的 worktree 或主维护者的检出里改东西。
- 分支名：`feat/<功能>`、`fix/<问题>`、`chore/<事>`、`docs/<文档>`。

## 3. 自己的预览环境

在部署宿主机上每个分支用自己的一套名字，避免互相杀掉：

| 东西            | 命名                                                     |
| --------------- | -------------------------------------------------------- |
| 目录            | `/opt/cb-<名字>/`                                        |
| 预览容器 / 卷   | `cb-<名字>-preview`，卷 `cb-<名字>-preview-{db,ws,prof}` |
| 测试容器 / 网络 | `cb<名字>-test`、`cb<名字>-pg`、网络 `cb<名字>-net`      |
| 端口            | 每人一个未占用的 loopback 端口（在 ROADMAP 那一行写上）  |
| 日志            | `/tmp/cb<名字>-test.log`                                 |

内存有限：预览 `--memory 3g`、测试 `--memory 5g`，同时构建的测试最多约 3 个。做完 `preview.sh down` 拆掉。

## 4. DESIGN.md 章节号和文档

- 新章节写在 DESIGN.md 末尾，标题先用占位 `## XX. …`；**合并前**改成 main 上最大编号 + 1，同时改 docs 里的交叉引用和
  DESIGN.md 顶部的章节索引表。
- 每个功能一份 `docs/<功能>.md`（怎么用、怎么实现、数据表、开关、已知限制），并加进 [docs/README.md](../README.md) 和
  [architecture.md](../architecture.md) 的功能表。

## 5. 合并

```sh
git fetch origin && git rebase origin/main      # 合并前一刻再 rebase；有冲突就解决并重跑测试
git push --force-with-lease origin <你的分支>     # 只对自己的分支 force-with-lease
```

- 开 PR（模板会列出检查项），GitHub 上用 merge commit 合并，记下合并提交。
- **永远不要 force-push `main`，不要删别人的分支和 tag。**（2026-10-14 出过一次 main 被强推、PR #84–#92 被抹掉的事故。）

## 6. 部署（串行）

`sh deploy-serial.sh <合并提交前 7 位> <名字>`，退出码 0 才算上线。不要直接调 updater。详见 [ops/deploy.md](../ops/deploy.md)。

## 7. 生产验证

只用一次性机器人 + 临时会话，跑完清理；绝不动用户真实的机器人、对话、数据。

## 8. 不删上游功能

瘦身由专门的分支按 [slimming.md](../slimming.md) 分阶段做；功能分支不要顺手删上游模块，也不要在明显没人用的上游模块上继续加东西。

## 9. 收尾

- PR 里：勾掉 BACKLOG 条目的验收标准、ROADMAP 那一行移到「最近完成」、CHANGELOG `Unreleased` 加一行。
- 拆掉预览，删掉合并后的本地 worktree。
