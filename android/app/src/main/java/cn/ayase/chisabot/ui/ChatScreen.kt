package cn.ayase.chisabot.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.ayase.chisabot.AppViewModel
import cn.ayase.chisabot.Bot
import cn.ayase.chisabot.Screen
import cn.ayase.chisabot.chat.Row as ChatRow
import cn.ayase.chisabot.chat.Turns
import cn.ayase.chisabot.chat.WorkSteps
import coil.compose.AsyncImage
import cn.ayase.chisabot.net.absUrl
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** 原生聊天：历史、发送、流式回复、干活卡（§75）、停顿小点（§78.2）、短气泡（§69）、富卡片（render_ui）。 */
@Composable
fun ChatScreen(vm: AppViewModel, bot: Bot) {
    val sky = LocalSky.current
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    val rows = remember(vm.messages, vm.running, vm.runError, vm.confirms) { Turns.build(vm.messages, vm.running, vm.runError, vm.confirms) }
    val list = rememberLazyListState()
    val atBottom by remember { derivedStateOf { list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset < 40 } }
    val webFallback = { vm.push(Screen.Web(vm.channelId?.let { "/channel/$it" } ?: "/channel/new?agent=${bot.id}", bot.name)) }
    val actions = remember(bot.id) { RenderActions(ask = { text -> scope.launch { vm.send(text) } }, fallback = webFallback) }
    // 站内操作胶囊：GitHub 连接就地弹原生令牌对话框（同网页 GITHUB_CONNECT_HREF 拦截）；其它站内路径在壳内网页里打开。
    var githubConnect by remember { mutableStateOf(false) }

    // 刚发出 / 自己在底部：新内容来了贴着底部（reverseLayout，index 0 = 最底下）。
    // 「跟着底部」在手指滑完时才更新：新的一行插在 index 0 时列表按 key 保住原来那一行，atBottom 会先变 false，
    // 只看 atBottom 的话末尾新出的卡片（确认卡片等）会落在屏幕外。
    var follow by remember { mutableStateOf(true) }
    LaunchedEffect(list.isScrollInProgress) { if (!list.isScrollInProgress) follow = atBottom }
    LaunchedEffect(rows.size, vm.running, rows.lastOrNull()?.key) { if (follow || atBottom) { list.animateScrollToItem(0); follow = true } }

    Column(Modifier.fillMaxSize().imePadding()) {
        TopBar(bot.name, subtitle = if (vm.running) "正在回复…" else if (bot.main) "主机器人" else bot.title, onBack = { vm.back() }) {
            IconText("▦", "面板", { vm.openPanels(bot) })
            Box {
                IconText("⋯", "更多", { menu = true }, size = 22.sp)
                DropdownMenu(menu, { menu = false }) {
                    DropdownMenuItem({ Text("新话题") }, { menu = false; vm.newTopic() }, enabled = !vm.running)
                    DropdownMenuItem({ Text("在网页中打开这段对话") }, { menu = false; webFallback() })
                    DropdownMenuItem({ Text("机器人资料") }, { menu = false; vm.push(Screen.Web("/bots/${bot.id}", bot.name)) })
                }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            CompositionLocalProvider(
                LocalActionPill provides { href: String ->
                    if (href == GITHUB_CONNECT_HREF) githubConnect = true
                    else vm.push(Screen.Web(href, href.substringAfterLast('/')))
                },
                LocalPreviewFallback provides webFallback,
            ) {
            when {
                rows.isEmpty() && vm.chatLoading -> Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Box(Modifier.align(Alignment.End).width(180.dp).height(40.dp).glass(sky, level = 1))
                    Box(Modifier.width(260.dp).height(64.dp).glass(sky, level = 1))
                    Box(Modifier.width(220.dp).height(40.dp).glass(sky, level = 1))
                }
                rows.isEmpty() && vm.chatLoadError != null -> ErrorCard(vm.chatLoadError ?: "") { vm.loadChat(bot) }
                rows.isEmpty() -> Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    BotAvatar(bot, 64.dp)
                    Spacer(Modifier.height(12.dp))
                    Text("有什么可以帮你？", color = sky.ink2, fontSize = 16.sp)
                }
                else -> LazyColumn(
                    state = list, reverseLayout = true, modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(rows.asReversed(), key = { it.key }) { row -> RowView(vm, row, actions) }
                }
            }
            }
            NoticePill(vm, Modifier.align(Alignment.TopCenter))
            // 回到底部：手机上是 36dp 圆形 ↓（§78.4）
            androidx.compose.animation.AnimatedVisibility(visible = !atBottom && rows.isNotEmpty(), Modifier.align(Alignment.BottomCenter).padding(bottom = 10.dp), enter = fadeIn(tween(180)) + scaleIn(initialScale = 0.8f), exit = fadeOut(tween(150)) + scaleOut(targetScale = 0.8f)) {
                Box(Modifier.size(36.dp).clip(CircleShape).glass(sky, CircleShape, 3).clickable { scope.launch { list.animateScrollToItem(0) } }.semantics { contentDescription = "回到底部" }, contentAlignment = Alignment.Center) {
                    Text("↓", color = sky.ink1, fontSize = 17.sp)
                }
            }
        }
        Composer(vm, onSent = { scope.launch { delay(50); list.scrollToItem(0) } })
    }
    if (githubConnect) GithubConnectDialog(vm) { githubConnect = false }
}

@Composable
private fun RowView(vm: AppViewModel, row: ChatRow, actions: RenderActions) {
    val sky = LocalSky.current
    val ctx = LocalContext.current
    when (row) {
        is ChatRow.User -> UserMessage(vm, row.msg, row.editable)
        is ChatRow.Server -> ServerNote(row.text)
        is ChatRow.Confirm -> ConfirmCardView(vm, row.card)
        is ChatRow.Bot -> {
            val shown = rememberSmoothText(row.text, row.streaming)
            Column(Modifier.fillMaxWidth()) {
                if (row.kind == ChatRow.Kind.Process) InlineText(shown, sky.ink3, 13.5f)
                else BotBubbles(if (row.streaming) hideIncompleteTail(shown) else shown)
                if ((row.copyable && row.kind == ChatRow.Kind.Result) || row.regenerate) Row(Modifier.padding(top = 2.dp)) {
                    if (row.copyable && row.kind == ChatRow.Kind.Result) CopyChip(sky.ink3) { copyText(ctx, row.text) }
                    if (row.regenerate) ActionChip("↻", "重新生成", "生成中…", enabled = !vm.running) { vm.regenerate() }
                }
            }
        }
        is ChatRow.Work -> WorkCard(vm, row)
        is ChatRow.Card -> JsonRenderView(row.spec, actions, Modifier.fillMaxWidth())
        is ChatRow.FileCards -> FileCardsView(row.files)
        is ChatRow.Thinking -> ThinkingPill()
        is ChatRow.Pause -> PauseDots(row.lastText)
        is ChatRow.Error -> Column {
            Text(
                row.text, color = sky.danger, fontSize = 13.5.sp,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(sky.danger.copy(alpha = 0.10f)).padding(10.dp),
            )
            if (!vm.running) ActionChip("↻", "重新生成", "生成中…") { vm.regenerate() }
        }
    }
}

@Composable
private fun ThinkingPill() {
    val sky = LocalSky.current
    Row(Modifier.height(38.dp).clip(RoundedCornerShape(19.dp)).background(sky.glass2).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("思考中", color = sky.ink3, fontSize = 13.5.sp)
        Spacer(Modifier.width(6.dp))
        Dots(sky.ink3, 4.dp)
    }
}

/** §78.2：最后一段字停住 0.9 秒还没有下文时淡入三个小点；有新字一来就收起（key 跟着字长变）。 */
@Composable
private fun PauseDots(lastText: String) {
    val sky = LocalSky.current
    var show by remember(lastText.length) { mutableStateOf(false) }
    LaunchedEffect(lastText.length) { delay(900); show = true }
    Box(Modifier.height(20.dp)) {
        AnimatedVisibility(show, enter = fadeIn(tween(200)), exit = fadeOut(tween(120))) { Dots(sky.ink3, 5.dp, Modifier.padding(start = 6.dp, top = 6.dp)) }
    }
}

/**
 * 干活卡（§75）：一轮一张，画在第一个干活的工具那一行。实时：「● 正在搜索「…」 · 第 3 步 · 12 秒」；
 * 结束：同一个按钮原地变成「✓ 搜索 2 次 · 看了 3 个网页 · 12 秒 ⌄」，高度不变。点开列出每一步。
 */
@Composable
private fun WorkCard(vm: AppViewModel, row: ChatRow.Work) {
    val sky = LocalSky.current
    var open by remember(row.turnKey) { mutableStateOf(false) }
    val now = Ticker(1000)
    if (row.live && row.turnKey !in vm.workStarted) vm.workStarted[row.turnKey] = System.currentTimeMillis()
    if (!row.live && row.turnKey in vm.workStarted && row.turnKey !in vm.workEnded) vm.workEnded[row.turnKey] = System.currentTimeMillis()
    val started = vm.workStarted[row.turnKey]
    val seconds = started?.let { (((vm.workEnded[row.turnKey] ?: now) - it) / 1000).toInt() }
    val bg by animateColorAsState(if (row.live) sky.glass2 else Color.Transparent, tween(240), label = "bg")
    val ink by animateColorAsState(if (row.live) sky.ink2 else sky.ink3, tween(240), label = "ink")
    val arrow by animateFloatAsState(if (open) 180f else 0f, tween(180), label = "arrow")
    val current = WorkSteps.current(row.calls)
    val label = if (row.live) {
        listOfNotNull(current, WorkSteps.stepCount(row.calls).takeIf { it > 1 }?.let { "第 $it 步" }, seconds?.takeIf { it > 2 }?.let { "$it 秒" }).joinToString(" · ")
    } else listOfNotNull(WorkSteps.doneLabel(row.calls) ?: "完成", seconds?.takeIf { it > 0 }?.let { "$it 秒" }).joinToString(" · ")
    val steps = WorkSteps.lines(row.calls)
    Column(Modifier.fillMaxWidth().animateContentSize(tween(200))) {
        Row(
            Modifier.widthIn(max = 520.dp).height(38.dp).clip(RoundedCornerShape(19.dp)).background(bg).clickable { open = !open }
                .padding(horizontal = 14.dp).semantics { contentDescription = label },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (row.live) Box(Modifier.size(7.dp).clip(CircleShape).background(sky.accent)) else Text("✓", color = sky.success, fontSize = 13.sp)
            Spacer(Modifier.width(8.dp))
            // 换字：旧的一行往上 8dp 淡出、新的一行从下面 8dp 淡入（§78.3）
            AnimatedContent(label, transitionSpec = {
                (slideInVertically(tween(200)) { it / 3 } + fadeIn(tween(200))) togetherWith (slideOutVertically(tween(200)) { -it / 3 } + fadeOut(tween(160)))
            }, label = "step", modifier = Modifier.weight(1f, fill = false)) { t ->
                Text(t, color = ink, fontSize = 13.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (steps.isNotEmpty()) Text(" ⌄", color = sky.ink3, fontSize = 13.sp, modifier = Modifier.rotate(arrow))
        }
        if (open && steps.isNotEmpty()) Row(Modifier.padding(start = 16.dp, top = 4.dp).height(IntrinsicSize.Min)) {
            Box(Modifier.width(2.dp).fillMaxHeight().background(sky.accent.copy(alpha = 0.35f)))
            Column(Modifier.padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                steps.forEachIndexed { i, s ->
                    Text(s, color = if (row.live && i == steps.lastIndex) sky.ink1 else sky.ink3, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@Composable
private fun Composer(vm: AppViewModel, onSent: () -> Unit) {
    val sky = LocalSky.current
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    // 照片：系统照片选择器（Android 13+ 不要权限；老系统回落到 GET_CONTENT）；文件：只给能读的类型；拍照：存到 cache/camera 再上传
    val pickPhotos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(8)) { uris -> if (uris.isNotEmpty()) vm.addFiles(uris) }
    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> if (uris.isNotEmpty()) vm.addFiles(uris) }
    var photoUri by remember { mutableStateOf<android.net.Uri?>(null) }
    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok -> photoUri?.let { if (ok) vm.addFiles(listOf(it)) } }
    val uploading = vm.files.any { it.state == "uploading" }
    val readyFiles = vm.files.count { it.state == "ready" }
    Column(Modifier.fillMaxWidth().background(sky.glass1).navigationBarsPadding()) {
        AttachmentStrip(vm)
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.Bottom) {
            AttachButton(
                onPhotos = { pickPhotos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                onCamera = { runCatching { vm.cameraUri() }.getOrNull()?.let { photoUri = it; runCatching { takePhoto.launch(it) }.onFailure { vm.notice = "这台手机没有可用的相机" } } },
                onFiles = { pickFiles.launch(arrayOf("image/png", "image/jpeg", "image/gif", "image/webp", "text/*", "application/json")) },
                enabled = vm.files.size < 8,
            )
            Spacer(Modifier.width(8.dp))
            Box(Modifier.weight(1f).heightIn(min = 44.dp).clip(RoundedCornerShape(22.dp)).background(sky.glass3).padding(horizontal = 16.dp, vertical = 11.dp)) {
                if (text.isEmpty()) Text(if (readyFiles > 0 || uploading) "说点什么（可以不写）…" else "发消息…", color = sky.ink4, fontSize = 15.5.sp)
                BasicTextField(
                    text, { text = it }, textStyle = TextStyle(color = sky.ink1, fontSize = 15.5.sp, lineHeight = 22.sp),
                    cursorBrush = SolidColor(sky.accent), maxLines = 6, modifier = Modifier.fillMaxWidth().semantics { contentDescription = "消息输入框" },
                )
            }
            Spacer(Modifier.width(8.dp))
            val canSend = (text.isNotBlank() || readyFiles > 0) && !uploading && !sending
            AnimatedContent(vm.running, transitionSpec = { fadeIn(tween(150)) togetherWith fadeOut(tween(150)) }, label = "send") { running ->
                if (running) {
                    // 停止（§38）：点了原地转圈「停止中」，服务器停下、流断开后变回发送
                    Box(
                        Modifier.size(44.dp).clip(CircleShape).background(sky.ink1).clickable(enabled = !vm.stopping) { vm.stop() }
                            .semantics { contentDescription = if (vm.stopping) "停止中" else "停止" },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (vm.stopping) CircularProgressIndicator(Modifier.size(18.dp), color = sky.skyBottom, strokeWidth = 2.dp)
                        else Box(Modifier.size(12.dp).clip(RoundedCornerShape(2.dp)).background(sky.skyBottom))
                    }
                } else {
                    Box(
                        Modifier.size(44.dp).clip(CircleShape).background(if (canSend) sky.accent else sky.accent.copy(alpha = 0.35f))
                            .clickable(enabled = canSend) {
                                val msg = text.trim()
                                sending = true
                                scope.launch {
                                    text = ""
                                    val ok = vm.send(msg)
                                    if (!ok) text = msg // 发送失败：字放回去，可以重试
                                    sending = false
                                    onSent()
                                }
                            }.semantics { contentDescription = if (uploading) "发送（附件上传中）" else "发送" },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (uploading) CircularProgressIndicator(Modifier.size(18.dp), color = Color.White, strokeWidth = 2.dp)
                        else Text("↑", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.alpha(if (sending) 0.5f else 1f))
                    }
                }
            }
        }
    }
}

/** 流式时最后一行还没写完的图片 / 链接记号（「![示例图](https:/」）先不显示，写完再出来（和网页 Streamdown 一样不露半截记号）。 */
fun hideIncompleteTail(text: String): String {
    val lastLine = text.substringAfterLast('\n')
    val open = lastLine.lastIndexOf("![").takeIf { it >= 0 } ?: lastLine.lastIndexOf('[').takeIf { it >= 0 && !lastLine.substring(it).contains(')') }
    if (open == null || lastLine.substring(open).contains(')')) return text
    return text.substring(0, text.length - lastLine.length + open)
}
