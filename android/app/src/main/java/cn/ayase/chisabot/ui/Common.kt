package cn.ayase.chisabot.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.ContentScale
import cn.ayase.chisabot.Bot
import cn.ayase.chisabot.BotAvatarSpec
import cn.ayase.chisabot.net.absUrl
import coil.compose.AsyncImage
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * 异步按钮（DESIGN §2/§6 状态机）：idle → 进行中（转圈 + 「xx中…」，不可点）→ 成功（✓ 绿色，约 1.5 秒复原）或失败（✕ 红色，可重试）。
 * 宽度固定（fillMaxWidth 或外部给定），至少显示 300ms 进行中，避免一闪。
 */
enum class BtnState { Idle, Pending, Done, Failed }

@Composable
fun AsyncButton(
    label: String,
    pendingLabel: String,
    doneLabel: String,
    modifier: Modifier = Modifier,
    primary: Boolean = true,
    enabled: Boolean = true,
    action: suspend () -> Boolean,
) {
    val sky = LocalSky.current
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf(BtnState.Idle) }
    val bg by animateColorAsState(
        when (state) {
            BtnState.Done -> sky.success
            BtnState.Failed -> sky.danger
            else -> if (primary) sky.accent else sky.glass2
        }, tween(200), label = "bg",
    )
    val fg = if (primary || state == BtnState.Done || state == BtnState.Failed) Color.White else sky.ink1
    Box(
        modifier
            .height(46.dp)
            .clip(RoundedCornerShape(23.dp))
            .background(if (enabled || state != BtnState.Idle) bg else bg.copy(alpha = 0.45f))
            .clickable(enabled = enabled && state != BtnState.Pending, role = Role.Button) {
                scope.launch {
                    state = BtnState.Pending
                    val started = System.currentTimeMillis()
                    val ok = runCatching { action() }.getOrDefault(false)
                    val wait = 300 - (System.currentTimeMillis() - started)
                    if (wait > 0) delay(wait)
                    state = if (ok) BtnState.Done else BtnState.Failed
                    delay(if (ok) 1500 else 2200)
                    if (state != BtnState.Pending) state = BtnState.Idle
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        AnimatedContent(state, transitionSpec = { fadeIn(tween(180)) togetherWith fadeOut(tween(150)) }, label = "btn") { s ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                when (s) {
                    BtnState.Pending -> CircularProgressIndicator(Modifier.size(16.dp), color = fg, strokeWidth = 2.dp)
                    BtnState.Done -> Text("✓", color = fg, fontWeight = FontWeight.Bold)
                    BtnState.Failed -> Text("✕", color = fg, fontWeight = FontWeight.Bold)
                    BtnState.Idle -> Unit
                }
                if (s != BtnState.Idle) Spacer(Modifier.width(8.dp))
                Text(
                    when (s) { BtnState.Idle -> label; BtnState.Pending -> pendingLabel; BtnState.Done -> doneLabel; BtnState.Failed -> "失败，点此重试" },
                    color = fg, fontSize = 15.sp, fontWeight = FontWeight.Medium,
                )
            }
        }
    }
}

/** DESIGN §81 头像底色：140° 渐变（浅 → 深），白字。键和网页一致。 */
private val AVATAR_GRADIENTS = linkedMapOf(
    "sky" to (0xFF6CB6FF to 0xFF2F74F0), "ocean" to (0xFF3CC3D3 to 0xFF1662A8), "mint" to (0xFF5AD8AE to 0xFF1B9474),
    "lime" to (0xFFA8DC55 to 0xFF4B952B), "amber" to (0xFFFFC765 to 0xFFE2850F), "coral" to (0xFFFF9478 to 0xFFDC4F38),
    "rose" to (0xFFFF8BB0 to 0xFFCF3D76), "violet" to (0xFFB896FF to 0xFF6A4FD6), "slate" to (0xFF95A2B8 to 0xFF4B586E),
)

private fun gradientFor(color: String?, seed: String): Brush {
    val (a, b) = AVATAR_GRADIENTS[color] ?: AVATAR_GRADIENTS.values.elementAt((seed.hashCode() and 0x7fffffff) % AVATAR_GRADIENTS.size)
    return Brush.linearGradient(listOf(Color(a), Color(b)), start = Offset(0f, 0f), end = Offset(Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY))
}

/** 首字（拉丁字母大写），和网页 monogram 一致。 */
fun monogram(name: String): String {
    val first = name.trim().codePoints().findFirst()
    if (!first.isPresent) return "?"
    return String(Character.toChars(first.asInt)).uppercase()
}

/**
 * 机器人头像（DESIGN §81）。形象（shape）→ 不裁圆的形状 + 眼睛（ShapeAvatar.kt）；其余一律圆形。上传的图 → 圆形图（加载中 / 失败显示首字底）；emoji / monogram → 渐变底；
 * 没设头像 → 按 avatarSeed 选一个渐变 + 首字（网页默认是 boring-avatars 图案，原生先用首字，第二阶段对齐）。
 */
@Composable
fun BotAvatar(name: String, seed: String, size: Dp = 40.dp, avatar: BotAvatarSpec? = null) {
    val key = seed.ifEmpty { name }
    // 形象（shape）：不裁圆，直接画形状 + 眼睛；解析时已保证形状和颜色都认识。
    if (avatar?.kind == "shape" && avatar.shape != null && AvatarShapes.geometry(avatar.shape) != null) {
        ShapeAvatar(avatar.shape, avatar.color, size)
        return
    }
    Box(Modifier.size(size).clip(CircleShape).background(gradientFor(avatar?.color, key)), contentAlignment = Alignment.Center) {
        if (avatar?.kind == "emoji" && !avatar.emoji.isNullOrBlank()) {
            Text(avatar.emoji, fontSize = (size.value * 0.5f).sp)
        } else {
            Text(monogram(name), color = Color.White, fontSize = (size.value * 0.42f).sp, fontWeight = FontWeight.SemiBold)
        }
        if (avatar?.kind == "image" && !avatar.url.isNullOrBlank()) {
            AsyncImage(
                model = absUrl(avatar.url), contentDescription = null, contentScale = ContentScale.Crop,
                modifier = Modifier.size(size).clip(CircleShape),
            )
        }
    }
}

@Composable
fun BotAvatar(bot: Bot, size: Dp = 40.dp) = BotAvatar(bot.name, bot.seed, size, bot.avatar)

/** 顶部栏：玻璃条 + 返回 + 标题 + 右侧动作。 */
@Composable
fun TopBar(title: String, subtitle: String? = null, onBack: (() -> Unit)? = null, actions: @Composable RowScope.() -> Unit = {}) {
    val sky = LocalSky.current
    Row(
        Modifier.fillMaxWidth().background(sky.glass1).statusBarsPadding().height(56.dp).padding(horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) IconText("‹", "返回", onBack, size = 26.sp) else Spacer(Modifier.width(10.dp))
        androidx.compose.foundation.layout.Column(Modifier.weight(1f).padding(horizontal = 4.dp)) {
            Text(title, color = sky.ink1, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!subtitle.isNullOrBlank()) Text(subtitle, color = sky.ink3, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically, content = actions)
    }
}

/** 文字图标按钮（不引入图标库，保持 APK 小）。description 给读屏用。 */
@Composable
fun IconText(glyph: String, description: String, onClick: () -> Unit, size: androidx.compose.ui.unit.TextUnit = 18.sp, tint: Color? = null) {
    val sky = LocalSky.current
    Box(
        Modifier.size(44.dp).clip(CircleShape).clickable(role = Role.Button, onClickLabel = description, onClick = onClick)
            .androidxSemantics(description),
        contentAlignment = Alignment.Center,
    ) { Text(glyph, color = tint ?: sky.ink2, fontSize = size) }
}

fun Modifier.androidxSemantics(desc: String) = this.semantics { contentDescription = desc }

/** 「几分钟前」。 */
fun relativeTime(iso: String?): String {
    if (iso.isNullOrBlank()) return ""
    val t = parseIso(iso) ?: return ""
    val s = (System.currentTimeMillis() - t) / 1000
    return when {
        s < 60 -> "刚刚"
        s < 3600 -> "${s / 60} 分钟前"
        s < 86400 -> "${s / 3600} 小时前"
        else -> "${s / 86400} 天前"
    }
}

@Composable
fun Ticker(periodMs: Long = 1000L): Long {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(periodMs) { while (true) { delay(periodMs); now = System.currentTimeMillis() } }
    return now
}

/** ISO-8601（服务器 toISOString，UTC，带毫秒）→ 毫秒。minSdk 24 没有 java.time，用 SimpleDateFormat。 */
fun parseIso(iso: String): Long? {
    for (pattern in listOf("yyyy-MM-dd'T'HH:mm:ss.SSSX", "yyyy-MM-dd'T'HH:mm:ssX")) {
        val f = java.text.SimpleDateFormat(pattern, java.util.Locale.US)
        runCatching { return f.parse(iso)?.time }
    }
    return null
}
