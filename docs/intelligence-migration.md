# 将托管历史迁入本地对话

DSH 版本使用 ChisaBot 的 PostgreSQL 会话服务。旧 Intelligence 执行模式已退休；旧部署配置会明确要求迁移，不会自动切到一个空历史库。已经使用 `CHISABOT_RUNTIME_MODE=local` 的部署无需导入。

先停止旧服务的新运行，并完成或取消仍在执行、等待审批的回合。保留原数据库、附件存储和连接器配置。下面命令只迁移会话历史与状态；Bot、账号、频道映射和附件仍使用同一 ChisaBot 业务数据库及存储，不能换成一个新业务库后只导入聊天。

对每一对已有账号 ID 与 Bot ID 导出一次。在原部署配置的 `INTELLIGENCE_API_URL`、`INTELLIGENCE_API_KEY` 环境下执行：

```sh
bun server/scripts/migrate-intelligence.ts inventory \
  --user "$OWNER_ID" --agent "$BOT_ID" --out ./history-snapshot.json
```

快照包含私密对话，请保存在受控目录，不提交仓库。命令不会覆盖已有文件；默认最多 1,000 个线程，可显式使用 `--limit` 增加。导出包含归档线程、消息 ID、工具结果、原线程元数据、状态和事件。发现仍在执行、待答审批、未完成工具、截断事件或损坏状态时，命令报错并要求先处置原线程。

公开的旧服务 API 按账号与 Bot 查询，不提供本项目全部账号的可信枚举。维护者需用现有账号、Bot、频道映射确认所有组合都已导出，不能把一次导出当作全站盘点完成。

导入时使用原 ChisaBot 的 `DATABASE_URL`，并暂停新运行：

```sh
export CHISABOT_DSH_ROOT=/var/lib/chisabot/dsh
mkdir -p "$CHISABOT_DSH_ROOT"
printf 'history-import\n' > "$CHISABOT_DSH_ROOT/.maintenance"
bun server/scripts/migrate-intelligence.ts import --snapshot ./history-snapshot.json
```

导入在一个事务中保留 owner、Bot、thread、message ID，建立本地历史表；原元数据与事件保存在 `chisabot_legacy_imports`。任何本地同 ID 线程都会拒绝整份导入，不覆盖原记录，也不会运行模型或工具。

核对导出的线程数、消息数和导入结果，使用保留的业务数据库检查旧频道与附件。全部组合迁完后设置 `CHISABOT_RUNTIME_MODE=local`、`CHISABOT_AGENT_KERNEL=dsh`，启动新服务。确认健康和历史读取后删除本次创建的 `.maintenance` 标记，再允许新对话执行。

导出后的旧服务保持停止写入；若两边都继续写，同一份快照无法证明完整迁移。原快照、旧数据和兼容版本用于回滚，详见 [DSH 运行维护](ops/dsh-runtime.md)。
