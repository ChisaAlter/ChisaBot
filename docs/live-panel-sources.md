# 面板的直连数据源与看板布局（2026-10-22）

参考 [dsh-pad](https://github.com/ChisaAlter/dsh-pad) 的坞式面板，把 ChisaBot 右栏「自定义面板」补上三件事：
秒级直连数据源、多卡平铺 / 单卡高度 / 折叠、卡片 ⋯ 菜单的能力。改动的设计条目写进 DESIGN.md 新章节，
用户可见的说法与限制写在这里。

## 1. 直连数据源（`live_panels.data_sources` / `source_state`）

以前面板只能靠机器人回合刷新（最少 60 分钟，一次一轮，花 token）。现在可以给面板挂 **最多 3 个数据源**：

| 字段 | 说明 |
|---|---|
| `id` | 稳定 id（`src_` 前缀）。规范里 `{"$state": "/live/<id>"}` 用它，改 id 等于改绑定 |
| `kind` | `http` 或 `command` |
| `name` | 卡片底部「来源」写的名字（如 CoinGecko、本机 uptime） |
| `intervalSec` | 轮询间隔，2–3600 |
| `url` / `method` / `headers` / `body` / `parse` | http：只允许 https、不带账号密码、不跟随重定向；`parse` 为 `json`（整段）/ `text`（原文）/ `number`（原文里一个数） |
| `command` | command：本机命令（仅管理员，且部署设了 `CHISABOT_PANEL_COMMANDS=1`） |

**回填方式**：前端在规范 state 里放一份 `live`（`{ [sourceId]: value }`），值变了用 `store.update` 写进去；
规范里绑 `/live/<id>` 或 `/live/<id>/字段` 的 Metric / List / Table 原地更新，布局不动（与 §32、§77 同一条路）。

**取数**：浏览器只在卡片可见、没折叠时轮询 `GET /api/live-panels/:id/live`。宿主按每个源自己的间隔判断新鲜度，
过期的取一次，最多 3 个并发；结果写回 `source_state` 并返回。没人在看就不取——和 dsh-pad「坞收起就停」同一个意思。

**密钥**：请求头 / 网址里写 `{{secret:名字}}`，走保险箱（只发往它绑定的域名，回来的内容抹掉密钥值）。
明文密钥不进数据库、不进 DTO、不进日志。带密钥的请求只能 https。

**命令**：默认关闭。`CHISABOT_PANEL_COMMANDS=1` 且面板主人是管理员才执行；超时 5 秒、输出最多 64 KB。
多用户部署里这是管理员自己的机器，别人的机器人拿不到这个能力（工具会直接拒绝并说明原因）。

**机器人怎么写**：`panel_create` / `panel_update` 带 `dataSources`（整份替换；不传则保持）。
数据只在「会变、而且变得比一小时快」时才用数据源（价格、负载、额度、倒计时）；正文仍然由机器人写一次规范。
有数据源时 `emptyMetrics` / `emptySections` 不拦 `/live/` 开头的绑定——值是运行时才有的。

## 2. 看板布局

- 卡片可以两两并排（右栏宽 ≥ 480px 时），中间分隔条拖动调比例（0.25–0.75）；最多一行两张，卡片最小 200px。
- 拖动卡片标题左边的握把：放到另一张卡片上 = 同一行 / 换位置；放到空白处 = 单独一行。
- 每张卡底部一条细横条：上下拖动调高度（最小 120px），双击回到自动高度。
- 点标题折叠：只留标题一行；折叠的卡片不再取数（直连数据源与整列轮询都停）。
- 布局按机器人记在 `localStorage`（`chisabot-ui-memory:v1` 的 `bots.<id>.panelLayout`），换设备不跟随；
  服务端只记 `position`（机器人新建面板的先后）。窄窗口抽屉里永远是单列。

## 3. ⋯ 菜单

| 项 | 行为 |
|---|---|
| 立即刷新 | 不变（机器人回合刷新） |
| 自动刷新 | 不变 |
| 让 AI 修改… | 把「帮我改一下右栏这张「标题」面板：」填进输入框（不自动发送） |
| 数据来源… | 列出每个来源：名字、网址 / 命令、间隔、最近一次取数结果与时间、失败原因；带「立即取数」 |
| 撤销上次修改 / 删除面板 | 不变 |

「面板模型」需要给无头回合加模型覆盖（`TurnRunner` 目前没有这个入参），这一版不做，记在 BACKLOG。

## 4. 接口

```
GET  /api/live-panels?botId=…            → { items: LivePanelDto[] }（多 dataSources）
GET  /api/live-panels/:id/live           → { sources: { [id]: Reading }, refreshed: string[] }
POST /api/live-panels/:id/live/refresh   → 同上，强制重取
POST /api/live-panels/:id/refresh        → 不变（机器人回合）
PATCH /api/live-panels/:id               → 不变（刷新频率）
```

`LivePanelDto` 新增：

```ts
dataSources: {
  id: string; kind: "http" | "command"; name: string;
  intervalSec: number;
  /** 展示用：http 写 host + path（不含 query 里的密钥），command 写命令原文（截断 200 字）。 */
  label: string;
}[];
```

`Reading = { ok: boolean; value: unknown; error?: string; at: string; ms: number }`。

## 5. 测试

- `server/tests/live-panel-sources.test.ts`：校验（https、内网、明文密钥、间隔夹取、最多 3 个）、解析（json / text / number）、
  新鲜度与单飞、命令开关与管理员限制、HTTP 失败的中文原因与密钥抹除、DTO / 两个 `/live` 路由的形状（取数失败也是 200）。
- `app/tests/panel-layout.test.ts`：行的合并 / 拆分 / 换位、比例夹取、高度与折叠落盘、宽窄栏的单列 / 并排。
- `app/tests/panel-board.test.tsx`：看板能画出来、折叠落到 `panelLayout`、窄栏 / 抽屉不并排（JSX 与事件那一层）。
- `app/tests/panel-live-values.test.ts`：读数合并进 state、失败不覆盖上一个好值（留旧值 + 标红）、不可见 / 折叠不轮询。

## 6. 手机与没轮询过的客户端

`GET /api/live-panels` 返回的 `spec` 里会带上每个源**最近一次的好值**（`state.live`）。浏览器拿到第一个读数之后用更新的值覆盖；
Android 原生版不轮询 `/live`，因此显示的是最近一次成功取到的数（和网页打开前的那一帧一致），不是空白磁贴。
只读注入，数据库里的规范不变。
