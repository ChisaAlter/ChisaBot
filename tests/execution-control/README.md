# 连续对话执行控制回归（CB-086）

`mock-model.mjs` 是确定性 OpenAI 兼容模型，实际派发前端 `computer_run_command`；命令写入带随机运行标识的专用日志，不触碰已有工作文件。`web.mjs` 在真实 Chrome 中创建受 guard 保护的一次性机器人，模拟早补话、工具执行期间补话、Stop、刷新与另一页面仍暂停、单条主动发送、恢复，并从工具读回日志核实副作用。

仅对隔离预览运行：

```powershell
$env:BASE='http://127.0.0.1:3298'
$env:OUT='C:\path\to\evidence'
$env:CHROME='C:\Program Files\Google\Chrome\Application\chrome.exe'
node tests/execution-control/web.mjs
```

预览模型配置为 `BOT_MODEL=mock-execution-control`、`OPENAI_BASE_URL=http://127.0.0.1:4012/v1`；用 `PORT=4012 node tests/execution-control/mock-model.mjs` 启动模型。服务器与计算机服务必须使用本次代码，数据库、workspace 和端口独立于生产。脚本初始化预览的新用户资料；不要对真实账号运行。

服务端与前端自动回归：

```sh
TEST_DATABASE_URL=postgres://... bun test server/tests/local-conversations-inbox.integration.test.ts
NODE_ENV=test bun test app/tests/thread-inbox-concurrency.test.tsx
CHISABOT_COMPUTER_STOP_HTTP=1 bun test server/tests/computer-stop.test.ts agent-computer/tests/shell.test.ts
```

最后一项需要 Linux `/bin/bash`，会启动真实 agent-computer 服务和短生命周期命令，等待超过延迟写入期限，验证进程组已停止。集成数据库须为专用空测试库。
