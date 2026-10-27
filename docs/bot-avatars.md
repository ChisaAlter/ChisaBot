# 机器人资料表单与头像

设计规范：DESIGN.md §81。代码：`app/src/components/agents/bot-profile-form.tsx`（表单）、`avatar-picker.tsx`（头像窗 + 圆形取景）、`bot-avatar.tsx`（显示）、`app/src/lib/agents/avatars.ts`；服务器 `server/src/bot-avatars/service.ts`；共用约定 `shared/bot-avatars.ts`。

## 一张表，新建和编辑一样
字段固定四格、顺序固定：**头像 · 名称（必填）· 职责 · 它做什么**。

- 职责：显示在名字下面的一句话。新建时跟着「它做什么」的第一句自动写（看得见、能改；一改就不再跟），清空也会回到自动；两样都没写 =「私人助手」。
- 它做什么：就是提示词，原样保存。留空存「我的私人助手：回答问题、查资料、帮我把事情办好。」名字和说话方式服务器每轮另外加（`shared/bot-prompt.ts` 的 `botIdentityGuidance` / `WORK_STYLE_GUIDANCE`），所以不再像 §74.2 那样在提示词前后补字。
- 出现在：新建弹窗（左栏 ＋ / Shift+N / 空状态）、机器人资料页「资料」卡的「编辑」、聊天旁「管理机器人」弹窗的「通用」。三处是同一个组件。
- 模型、暂停、通知不属于「它是谁」，在资料页「运行」卡和输入框的模型选择里，表单里没有，所以也没有「更多设置」。

## 头像
- 四种：**形象**（形状 + 颜色，带表情）、上传图片、表情 + 底色、名字首字 + 底色。没设置 = 以前的花纹头像（按机器人 id 生成），老机器人看起来不变。新建默认是名字首字（底色按名字挑）；打开头像窗时停在「形象」页。
- 图片 / 表情 / 首字处处是圆形：左栏（宽 / 窄）、聊天页、新聊天、资料页、机器人列表、管理弹窗、工作流里的机器人选择。形象保持自己的形状，不裁成圆。

## 形象（shape）
- 14 个形状（`AVATAR_SHAPES`）× 11 种颜色（`SHAPE_COLORS`），库里只存两个键名（`chisabot_bot_avatars.shape` / `color`）。形状和颜色值只在前端：`app/src/lib/agents/avatar-shapes.ts`。
- 形状是自己画的：每个形状是围着中心的 32 个半径，转成**结构完全一样**的闭合平滑曲线，所以任意两个形状之间直接逐点插值就能变形（换形状时用 `motion` 的弹簧驱动），不需要路径插值库。眼睛（一对竖条）的位置、间距、倾斜、大小跟着形状一起插值。
- 表情（`app/src/components/agents/shape-avatar.tsx`，样式 `styles.css` 的 `.sa-*`）：**在跑 > 刚做完 > 被选中 > 待机**。
  - 待机：什么动画都没有（左栏一屏几十个头像，不能都在动）。
  - 被选中（左栏当前打开的那一行）：眼睛变大，弹一下。
  - 在跑（频道的 `busy`）：呼吸、眼睛左右看、偶尔眨眼——持续动画，只有在跑的那几个有。
  - 做完（`busy` 从 true 变 false）：弯成开心的眼睛，跳两下，约 2.4 秒后回到原来的样子。
  - 「减少动态效果」下全部动画关掉，只保留静态表情。
- 头像窗的「形象」页里有「选中 / 工作中 / 做完了」三个按钮，只改预览，不改保存的内容。
- 旧客户端不认识 `shape` 时：网页退回默认花纹；Android 原生退回「渐变底 + 名字首字」（不崩）。Android 上画形象是后续工作。
- 上传：在浏览器里选图 → **圆形取景框**（拖动平移，滚轮 / 双指 / 滑杆 / + − 缩放，方向键平移）→ 裁出圆框外接的正方形，画成 256×256，压成 WebP（不支持就 JPEG），≤ 256 KB → 上传。原图最大 15 MB；打不开的格式（例如某些设备上的 HEIC）会提示换 PNG / JPEG。
- 图片读不出来时显示名字首字。

## 接口（全部要登录）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/bot-avatars` | `{ avatars: { [agentId]: BotAvatar } }`，只含设置过的、你看得到的机器人 |
| GET | `/api/bot-avatars/:agentId/image?v=<version>` | 图片字节；版本对得上时 `immutable` 长缓存，`nosniff` + 沙箱 CSP |
| PUT | `/api/bot-avatars/:agentId` | JSON `{kind:"emoji", emoji, color}` 或 `{kind:"monogram", color}` |
| PUT | `/api/bot-avatars/:agentId/image` | 原始字节，PNG / JPEG / WebP（看文件头），≤ 256 KB |
| DELETE | `/api/bot-avatars/:agentId` | 回到默认花纹 |

`BotAvatar` = `{kind:"image", url, version}` | `{kind:"emoji", emoji, color}` | `{kind:"monogram", color}`。`color` ∈ sky, ocean, mint, lime, amber, coral, rose, violet, slate（颜色值只在前端）。读：能看到这个机器人的人；写：能修改它的人（部署包自带的机器人不能改）。

## 存储与回滚
- 表 `chisabot_bot_avatars`（开机 `CREATE TABLE IF NOT EXISTS`；一个机器人一行，图片字节存库里，跟着数据库卷和备份走）。没有改任何已有表。
- 回滚到旧镜像：旧镜像不读这张表，所有机器人回到花纹头像；表和数据留着，再升级就回来。
- 机器人删除时头像行留着（软删除可恢复）；孤儿行留给以后的数据清理（BACKLOG）。
