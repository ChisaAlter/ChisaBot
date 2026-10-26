# 输入框两边留白（DESIGN.md §24 / §92）

真浏览器里量聊天输入框卡片到左右最近的卡（左栏卡、右栏卡）或窗口边的距离、到底边的距离、到「面板」把手的距离，
以及它和消息列内容边的偏差。只读：所有非 GET 请求一律在本地 fulfill。

```
BASE=http://127.0.0.1:<预览端口> CH=/channel/<对话 id> AGENT=<机器人 id> OUT_DIR=/out TAG=after \
  node tests/composer-gutter/gutter.mjs
```

- 宽度（`WIDTHS`，默认 390,700,800,884,1000,1100,1280,1440），390 / 884 / 1280 亮暗各一遍；
- 每个宽度：对话、右栏收起 / 展开（宽屏）、左栏收起（Ctrl B，桌面）、新话题（`/channel/new?agent=…&topic=new`）；
- 门槛：左右 ≥ `MIN`（16）、底边 ≥ 8、离把手 ≥ `HANDLE_MIN`（4）；`ASSERT=0` 只记录（量旧版本）。退出码 1 = 有失败。
- 结果 `$OUT_DIR/composer-gutter-$TAG/results.json` + 每个情况一张截图。
