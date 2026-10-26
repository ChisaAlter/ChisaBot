package cn.ayase.chisabot.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.ayase.chisabot.AppViewModel
import cn.ayase.chisabot.Bot
import cn.ayase.chisabot.Screen

/** 机器人列表（ADR-0001：只列机器人，主机器人置顶，不列对话）。点一下进聊天；长按 / ⋯ 有面板、机器人资料。 */
@Composable
fun BotsScreen(vm: AppViewModel, onCheckUpdate: () -> Unit, onLogout: () -> Unit) {
    val sky = LocalSky.current
    var menu by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        TopBar("ChisaBot", subtitle = vm.origin()?.removePrefix("https://")) {
            IconText("⚙", "设置", { vm.openSettings() })
            Box {
                IconText("⋯", "更多", { menu = true }, size = 22.sp)
                DropdownMenu(menu, { menu = false }) {
                    DropdownMenuItem({ Text("待处理") }, { menu = false; vm.push(Screen.Web("/approvals", "待处理")) })
                    DropdownMenuItem({ Text("新建机器人") }, { menu = false; vm.push(Screen.Web("/agents", "机器人")) })
                    DropdownMenuItem({ Text("完整网页版") }, { menu = false; vm.push(Screen.Web("/", "ChisaBot")) })
                    DropdownMenuItem({ Text("检查更新") }, { menu = false; onCheckUpdate() })
                    DropdownMenuItem({ Text("退出登录", color = sky.danger) }, { menu = false; onLogout() })
                }
            }
        }
        val bots = vm.bots
        when {
            bots.isEmpty() && vm.botsLoading -> Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                repeat(3) { Box(Modifier.fillMaxWidth().height(68.dp).glass(sky, level = 1)) } // 骨架，和真行一样高，不跳
            }
            bots.isEmpty() && vm.botsError != null -> ErrorCard(vm.botsError ?: "", onRetry = vm::loadBots)
            bots.isEmpty() -> Text("还没有机器人。在网页上新建一个吧。", color = sky.ink3, modifier = Modifier.padding(24.dp))
            else -> LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 12.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (vm.botsError != null) item { Text(vm.botsError ?: "", color = sky.warn, fontSize = 12.sp) }
                items(bots, key = { it.id }) { bot -> BotRow(vm, bot) }
                item { Spacer(Modifier.navigationBarsPadding()) }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BotRow(vm: AppViewModel, bot: Bot) {
    val sky = LocalSky.current
    var menu by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.fillMaxWidth().glass(sky, level = 2)
                .combinedClickable(onClick = { vm.openChat(bot) }, onLongClick = { menu = true })
                .padding(horizontal = 14.dp, vertical = 12.dp).animateContentSize(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BotAvatar(bot, 44.dp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(bot.name, color = sky.ink1, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (bot.main) {
                        Spacer(Modifier.width(6.dp))
                        Text("主机器人", color = sky.accent, fontSize = 11.sp, modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(sky.accentSoft).padding(horizontal = 6.dp, vertical = 2.dp))
                    }
                }
                if (bot.title.isNotBlank()) Text(bot.title, color = sky.ink3, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconText("⋯", "${bot.name} 的更多操作", { menu = true })
        }
        DropdownMenu(menu, { menu = false }) {
            DropdownMenuItem({ Text("面板") }, { menu = false; vm.openPanels(bot) })
            DropdownMenuItem({ Text("机器人资料") }, { menu = false; vm.push(Screen.Web("/bots/${bot.id}", bot.name)) })
            DropdownMenuItem({ Text("历史对话（网页）") }, { menu = false; vm.push(Screen.Web("/channel/new?agent=${bot.id}", bot.name)) })
        }
    }
}

@Composable
fun ErrorCard(text: String, onRetry: () -> Unit) {
    val sky = LocalSky.current
    Column(Modifier.padding(16.dp).fillMaxWidth().glass(sky, level = 2).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("出了点问题", color = sky.ink1, fontWeight = FontWeight.SemiBold)
        Text(text, color = sky.ink2, fontSize = 14.sp)
        AsyncButton("重试", "重试中…", "好了", Modifier.width(140.dp), primary = false) { onRetry(); true }
    }
}
