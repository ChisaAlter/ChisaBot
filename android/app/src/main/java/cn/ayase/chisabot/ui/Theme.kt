package cn.ayase.chisabot.ui

import android.os.Build
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** 蓝天磨砂玻璃（DESIGN §7 / §9–§14 的 Android 版）：天空渐变底 + 半透明玻璃 + 1px 亮边；墨色文字四级。 */
@Immutable
data class Sky(
    val dark: Boolean,
    val skyTop: Color, val skyBottom: Color, val cloud: Color,
    val glass1: Color, val glass2: Color, val glass3: Color, val glassEdge: Color,
    val ink1: Color, val ink2: Color, val ink3: Color, val ink4: Color,
    val accent: Color, val accentSoft: Color, val userBubble: Color, val onUser: Color,
    val success: Color, val warn: Color, val danger: Color, val brandRed: Color,
    val codeBg: Color,
)

/** API 31+ 才有 RenderEffect 模糊；以下用更不透明的玻璃代替（看起来接近，但没有真的模糊）。 */
val canBlur = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

fun skyLight() = Sky(
    dark = false,
    skyTop = Color(0xFFDCEBFF), skyBottom = Color(0xFFF4F8FF), cloud = Color(0xFFFFFFFF),
    glass1 = Color.White.copy(alpha = if (canBlur) 0.55f else 0.72f),
    glass2 = Color.White.copy(alpha = if (canBlur) 0.72f else 0.84f),
    glass3 = Color.White.copy(alpha = 0.92f),
    glassEdge = Color.White.copy(alpha = 0.85f),
    ink1 = Color(0xFF14233A), ink2 = Color(0xFF3B4C66), ink3 = Color(0xFF6B7A90), ink4 = Color(0xFFA3AEBE),
    accent = Color(0xFF3F86EE), accentSoft = Color(0x1F3F86EE), userBubble = Color(0xFF3F86EE), onUser = Color.White,
    success = Color(0xFF1F9D61), warn = Color(0xFFD08A12), danger = Color(0xFFD9443B), brandRed = Color(0xFFE5484D),
    codeBg = Color(0xFF0F1B2D).copy(alpha = 0.06f),
)

fun skyDark() = Sky(
    dark = true,
    skyTop = Color(0xFF0B1A30), skyBottom = Color(0xFF101E33), cloud = Color(0xFF2A4A7A),
    glass1 = Color(0xFF1B2B44).copy(alpha = if (canBlur) 0.55f else 0.78f),
    glass2 = Color(0xFF22344F).copy(alpha = if (canBlur) 0.70f else 0.88f),
    glass3 = Color(0xFF26395A).copy(alpha = 0.95f),
    glassEdge = Color.White.copy(alpha = 0.10f),
    ink1 = Color(0xFFE8EEF8), ink2 = Color(0xFFBCC8DA), ink3 = Color(0xFF8B9AB2), ink4 = Color(0xFF5E6C83),
    accent = Color(0xFF6AA6FF), accentSoft = Color(0x296AA6FF), userBubble = Color(0xFF3F7FE0), onUser = Color.White,
    success = Color(0xFF3CC985), warn = Color(0xFFF0B044), danger = Color(0xFFFF6B61), brandRed = Color(0xFFFF6369),
    codeBg = Color.Black.copy(alpha = 0.25f),
)

val LocalSky = staticCompositionLocalOf { skyLight() }

@Composable
fun ChisaTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val sky = if (dark) skyDark() else skyLight()
    val scheme = if (dark) darkColorScheme(primary = sky.accent, background = sky.skyBottom, surface = sky.glass3, onSurface = sky.ink1, onBackground = sky.ink1, error = sky.danger)
    else lightColorScheme(primary = sky.accent, background = sky.skyBottom, surface = sky.glass3, onSurface = sky.ink1, onBackground = sky.ink1, error = sky.danger)
    CompositionLocalProvider(LocalSky provides sky) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}

/** 整个应用一个颜色（用户 2026-10-12「中间不要白板，整个应用一个颜色」）：天空渐变 + 几朵模糊的云。 */
@Composable
fun SkyBackground(
    modifier: Modifier = Modifier,
    showClouds: Boolean = true,
    content: @Composable BoxScope.() -> Unit,
) {
    val sky = LocalSky.current
    Box(modifier.fillMaxSize().background(Brush.verticalGradient(listOf(sky.skyTop, sky.skyBottom)))) {
        if (showClouds) {
            // Unbounded：模糊不按方框裁切（Rectangle 会在云朵外圈留一条看得见的方边）
            val cloud = Modifier.blur(if (canBlur) 60.dp else 0.dp, androidx.compose.ui.draw.BlurredEdgeTreatment.Unbounded)
            Box(cloud.offset((-60).dp, (-40).dp).size(260.dp).alpha(if (sky.dark) 0.35f else 0.8f)
                .background(Brush.radialGradient(listOf(sky.cloud, Color.Transparent)), CircleShape))
            Box(cloud.offset(200.dp, 180.dp).size(300.dp).alpha(if (sky.dark) 0.25f else 0.6f)
                .background(Brush.radialGradient(listOf(sky.cloud, Color.Transparent)), CircleShape))
            Box(cloud.offset(20.dp, 520.dp).size(240.dp).alpha(if (sky.dark) 0.2f else 0.5f)
                .background(Brush.radialGradient(listOf(sky.accentSoft, Color.Transparent)), CircleShape))
        }
        content()
    }
}

fun Modifier.glass(sky: Sky, shape: Shape = RoundedCornerShape(18.dp), level: Int = 1): Modifier =
    this.clip(shape)
        .background(when (level) { 1 -> sky.glass1; 2 -> sky.glass2; else -> sky.glass3 }, shape)
        .border(1.dp, sky.glassEdge, shape)

/** 三个跳动的小点（「思考中」、§78.2 停顿、面板搭建中共用一种）。 */
@Composable
fun Dots(color: Color, dot: Dp = 5.dp, modifier: Modifier = Modifier) {
    val t = rememberInfiniteTransition(label = "dots")
    val phase by t.animateFloat(0f, 3f, infiniteRepeatable(tween(1200, easing = LinearEasing), RepeatMode.Restart), label = "p")
    Row(modifier) {
        for (i in 0 until 3) {
            val d = ((phase - i + 3) % 3f)
            val a = if (d < 1f) 0.35f + 0.65f * (1f - kotlin.math.abs(d - 0.5f) * 2f).coerceIn(0f, 1f) else 0.35f
            Box(Modifier.padding(horizontal = 1.5.dp).size(dot).alpha(a).background(color, CircleShape))
        }
    }
}

@Composable
fun Spacer6() = Box(Modifier.width(6.dp))
