# 机器人浏览器：多标签 + 收藏夹

DESIGN.md §95 的对外说明。

## 标签
- 每个机器人的云端浏览器可以同时开最多 8 个标签（`COMPUTER_MAX_TABS`）。机器人和你看到的是同一组标签：网站弹出的窗口、机器人新开的标签都会出现在标签栏上，当前标签高亮。
- 点标签切换、× 关闭、+ 新开（新标签页是起始页：时钟、搜索框、你的收藏）。还没接管控制时，这些点击会先走一次接管（和「接管控制」按钮同一条路），成功后再执行这次操作；接管不到（机器人正忙、断线）才在标签栏下面说明原因。只看着时标签栏照样显示，看得出机器人在哪个标签上。
- 浏览器重启（部署、空闲 30 分钟自动关闭、停止后再用）后会恢复上次开着的网页标签。`COMPUTER_RESTORE_TABS=0` 关掉。重置电脑会清空。
- 机器人工具：`computer_tabs`（list / new / switch / close）。其他电脑工具都作用在当前标签上。

## 收藏夹
- 每个账号一份，所有机器人的浏览器共用。第一次打开时放进起始页原来的五个网站。
- 地址栏右边的星标收藏 / 取消收藏当前页；地址栏下面是收藏栏（窄屏是「收藏夹」下拉）；⚙ 打开管理（改名、改网址、排序、删除、添加）。收藏栏也可以拖动排序、右键「在新标签页打开」。
- 新标签页上的常用网站就是收藏夹的前 12 个。
- 机器人工具：`computer_bookmarks`（list / open / add / remove）——只有你明确让它收藏 / 取消收藏时才会改收藏夹。

## 接口
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/computers/:bot/tabs` | 标签列表（浏览器没在运行时列出保存的，不拉起） |
| POST | `/api/computers/:bot/tabs` | 机器人：`{action: new\|activate\|close, id?, url?}`；人接管时拒绝 |
| POST | `/api/computers/:bot/human/tab` | 人：`{action, id?}`；只在接管时 |
| GET / POST | `/api/browser-bookmarks` | 列出（第一次种五个）/ 新增 `{title?, url}` |
| PATCH / DELETE | `/api/browser-bookmarks/:id` | 改名改网址 / 删除 |
| PUT | `/api/browser-bookmarks/order` | `{ids}` 排序 |
| POST | `/api/browser-bookmarks/sync/:bot` | 把收藏夹推给这个机器人的起始页 |

表：`chisabot_browser_bookmarks`、`chisabot_browser_bookmark_seeds`（开机建表，只新增；回滚镜像即可，表留着无害，起始页回到默认五个）。
