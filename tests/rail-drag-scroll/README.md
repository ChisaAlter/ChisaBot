# 宽度变化 → 聊天记录回归（DESIGN.md §106）

拖右栏左边缘的把手（或收起右栏、缩窗口）时，本意只是右栏变宽、中间那列重新换行。**修之前**松手时整段对话会被
推到上面，底下一整屏空白，`scrollTop` 还停在「底部」——视口正好落在留白里；同一篇文档卡还会因为多折两行跨过
300px 门槛，当场收起 / 展开。

两处根因都在「宽度变了，但代码还按上一次换行在算」：

- `app/src/components/channels/chat-transcript.tsx` 的 `SettleAtEnd`：§94.6 的「跟着变」留白给内容列钉了
  `min-height: max(100%, floor)`，`floor` 取「上次看到的总高度」，差额由 `.chat-slack` 补。宽度一变，
  `floor` 只会跟着更窄那次换行往上涨，拖回来不会降，差额全变成底部留白。
- `app/src/components/chat/bot-bubbles.tsx` 的 `DocCard`：`ResizeObserver` 盯着正文高度算「超过 300px 才收起」，
  宽度一变就重算，卡片跟着收起 / 展开。

## 跑法

真浏览器 + 一段已经比一屏长的对话（右栏要展开，窗口 ≥1280 宽）：

```
BASE=http://127.0.0.1:3097 CHANNEL=channel_xxxxxxxx ASSERT=1 SCENARIO=bottom,mid,collapse node tests/rail-drag-scroll/drag-scroll.mjs
```

- `CHROME=/path/to/chrome` 指定浏览器；镜像里默认用 `/ms-playwright` 里的 chromium，本机默认 `channel: "chrome"`。
- `DRAG=120` 拖动距离（px），`WIDTH` / `HEIGHT` 视口，默认 1280×800；`SCENARIO` 默认 `bottom`。

脚本先把对话滚到指定位置，量一次；再把把手往左拖 120px 拖回来、松开；再量一次。

## 判据（`ASSERT=1` 时不过就退出码 1）

| 场景 | 判据 |
| --- | --- |
| `bottom` | 内容列高度回到拖动前 ±8px、留白 < 8px、离底 ≤4px、最后一条消息在视口里 |
| `mid` | 翻在历史中间拖：第一条可见消息同一个 id、屏幕位置 ±2px，不留新留白 |
| `collapse` | Ctrl+Alt+B 收起再展开右栏（260ms 宽度动画），判据同 `bottom` |

文档卡另有一条人工核对（没有进脚本，得造一张卡在门槛附近的会话）：拖动全程 `[data-testid="chat-doc-card"]`
的 `data-collapsed` 与「展开全文」按钮不变。

## 修前 / 修后

| | 修前 | 修后 |
| --- | --- | --- |
| `bottom` 内容列 | 6362 → **7749**px（+1387） | 6362 → 6362px |
| `bottom` 留白 | **1388**px | 0–1px |
| `bottom` 视口 | 一条消息都没有 | 最后一条回答 |
| `mid` 第一条可见消息 | — | 位移 0px |
| 文档卡 | 拖动中收起（状态翻转） | 全程不换状态 |

修前 `ASSERT=1` 退出码 1（`FAIL 6362px → 7749px，留白 1388px`），修后三个场景全过。
