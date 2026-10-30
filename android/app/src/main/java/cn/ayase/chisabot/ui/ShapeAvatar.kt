package cn.ayase.chisabot.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.unit.Dp
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/**
 * 形象头像（DESIGN §81，shared/bot-avatars.ts 的 kind = "shape"）。几何照搬网页 app/src/lib/agents/avatar-shapes.ts：
 * 每个形状是围着中心的 32 个半径，连成闭合的 Catmull-Rom 曲线；画布 100×100，眼睛（一对白色竖条）的位置、倾斜、
 * 大小跟着形状走。原生只画静态的待机样子：不做换形变形、不做表情动画，所以也没有要跟「减少动态效果」的动效。
 * 形状不是圆的，不裁圆。
 */
object AvatarShapes {
    const val ANCHORS = 32
    private const val TAU = PI * 2
    private const val UP = -PI / 2

    val SHAPES = listOf("round", "cloud", "tile", "sparkle", "bloom", "bean", "scallop", "drop", "pill", "tri", "hex", "burst", "gem", "fruit")

    /** 底色键名 → 颜色（和网页 SHAPE_COLOR_HEX 一致）。 */
    val COLORS: Map<String, Long> = linkedMapOf(
        "ink" to 0xFF16161A, "brown" to 0xFFA0693A, "red" to 0xFFFF2D46, "orange" to 0xFFFF6A13,
        "amber" to 0xFFF7931E, "green" to 0xFF12C26A, "teal" to 0xFF14B8A6, "blue" to 0xFF2188FF,
        "violet" to 0xFF9B59F5, "pink" to 0xFFFF3D9A, "gray" to 0xFF8E8E93,
    )

    fun isShape(value: String?) = value != null && value in SHAPES
    fun isColor(value: String?) = value != null && value in COLORS

    data class Face(val x: Double, val y: Double, val gap: Double, val scale: Double, val rot: Double)
    data class Geometry(val radii: List<Double>, val dx: Double, val dy: Double, val face: Face)

    private fun fromUp(t: Double) = ((((t - UP + PI) % TAU) + TAU) % TAU) - PI

    private fun superellipse(a: Double, b: Double, n: Double, rot: Double = 0.0) = { t: Double ->
        val c = abs(cos(t - rot))
        val s = abs(sin(t - rot))
        ((c / a).pow(n) + (s / b).pow(n)).pow(-1 / n)
    }

    private fun polygon(m: Int, rot: Double, radius: Double, k: Double) = { t: Double ->
        val seg = TAU / m
        val apothem = radius * cos(PI / m)
        val local = ((((t - rot) % seg) + seg) % seg) - seg / 2
        val edge = apothem / cos(local)
        val round = apothem + (radius - apothem) * 0.35
        edge * (1 - k) + round * k
    }

    private val RADIUS: Map<String, (Double) -> Double> = mapOf(
        "round" to { _ -> 44.0 },
        "cloud" to { t -> 33 + 11 * abs(sin(3 * t + 0.5)).pow(0.55) },
        "tile" to superellipse(39.0, 39.0, 3.8, 0.2),
        "sparkle" to { t -> 27 + 18 * abs(cos(2 * t)).pow(1.7) },
        "bloom" to { t -> 38 + 6 * cos(5 * (t - UP)) },
        "bean" to { t -> 38 + 5 * cos(t - 0.6) + 3 * cos(2 * t + 1) + 2 * cos(3 * t) },
        "scallop" to { t -> 38 + 3.5 * cos(8 * t) },
        "drop" to { t -> 33 + 12 * exp(-((fromUp(t) / 0.55).pow(2))) },
        "pill" to superellipse(46.0, 30.0, 2.8),
        "tri" to polygon(3, 0.0, 50.0, 0.12),
        "hex" to polygon(6, 0.0, 47.0, 0.3),
        "burst" to { t -> 31 + 12 * abs(cos(4 * t)).pow(0.8) },
        "gem" to superellipse(40.0, 40.0, 2.6, PI / 4),
        "fruit" to { t -> 41 - 9 * exp(-((fromUp(t) / 0.22).pow(2))) + 2 * cos(2 * t) },
    )

    private val FACE: Map<String, Face> = mapOf(
        "round" to Face(50.0, 48.0, 17.0, 1.0, 0.0),
        "cloud" to Face(50.0, 49.0, 17.0, 1.0, 0.0),
        "tile" to Face(50.0, 50.0, 17.0, 1.0, 10.0),
        "sparkle" to Face(50.0, 50.0, 14.0, 0.75, 0.0),
        "bloom" to Face(50.0, 50.0, 17.0, 1.0, 0.0),
        "bean" to Face(48.0, 50.0, 17.0, 1.0, -8.0),
        "scallop" to Face(50.0, 49.0, 17.0, 1.0, 0.0),
        "drop" to Face(50.0, 58.0, 16.0, 0.95, 0.0),
        "pill" to Face(50.0, 50.0, 24.0, 1.0, 0.0),
        "tri" to Face(45.0, 50.0, 15.0, 0.9, 0.0),
        "hex" to Face(50.0, 50.0, 17.0, 1.0, 0.0),
        "burst" to Face(50.0, 50.0, 14.0, 0.8, 0.0),
        "gem" to Face(50.0, 50.0, 16.0, 0.95, 0.0),
        "fruit" to Face(50.0, 52.0, 17.0, 1.0, 0.0),
    )

    private val cache = HashMap<String, Geometry>()

    /** 不认识的形状返回 null（调用方退回首字头像）。 */
    fun geometry(shape: String): Geometry? {
        val radius = RADIUS[shape] ?: return null
        return synchronized(cache) {
            cache.getOrPut(shape) {
                val radii = List(ANCHORS) { i -> min(47.0, max(12.0, radius(i.toDouble() / ANCHORS * TAU))) }
                val xs = radii.mapIndexed { i, r -> r * cos(i.toDouble() / ANCHORS * TAU) }
                val ys = radii.mapIndexed { i, r -> r * sin(i.toDouble() / ANCHORS * TAU) }
                // 不对称的形状（水滴、三角）按外框居中。
                val dx = -(xs.min() + xs.max()) / 2
                val dy = -(ys.min() + ys.max()) / 2
                val face = FACE.getValue(shape)
                Geometry(radii, dx, dy, face.copy(x = face.x + dx, y = face.y + dy))
            }
        }
    }

    /** 一段三次贝塞尔：两个控制点 + 终点（100×100 坐标）。 */
    data class Cubic(val c1x: Double, val c1y: Double, val c2x: Double, val c2y: Double, val x: Double, val y: Double)

    /** 和网页 shapePath 同一条曲线：起点 + 32 段闭合 Catmull-Rom → 贝塞尔。 */
    fun outline(g: Geometry): Pair<Pair<Double, Double>, List<Cubic>> {
        val n = g.radii.size
        fun point(i: Int): Pair<Double, Double> {
            val k = ((i % n) + n) % n
            val t = k.toDouble() / n * TAU
            val r = g.radii[k]
            return (50 + g.dx + r * cos(t)) to (50 + g.dy + r * sin(t))
        }
        val segments = (0 until n).map { i ->
            val p0 = point(i - 1); val p1 = point(i); val p2 = point(i + 1); val p3 = point(i + 2)
            Cubic(
                p1.first + (p2.first - p0.first) / 6, p1.second + (p2.second - p0.second) / 6,
                p2.first - (p3.first - p1.first) / 6, p2.second - (p3.second - p1.second) / 6,
                p2.first, p2.second,
            )
        }
        return point(0) to segments
    }

    /** 和网页一样的 SVG 路径字符串（两位小数），测试用来和网页对齐。 */
    fun svgPath(g: Geometry): String {
        val (start, segments) = outline(g)
        fun f(v: Double) = String.format(java.util.Locale.ROOT, "%.2f", v)
        val sb = StringBuilder("M${f(start.first)} ${f(start.second)}")
        for (c in segments) sb.append("C${f(c.c1x)} ${f(c.c1y)} ${f(c.c2x)} ${f(c.c2y)} ${f(c.x)} ${f(c.y)}")
        return sb.append('Z').toString()
    }
}

/** 静态的形象头像；shape 不认识时什么都不画（BotAvatar 只在认识时才走这里）。 */
@Composable
fun ShapeAvatar(shape: String, color: String?, size: Dp) {
    val geometry = remember(shape) { AvatarShapes.geometry(shape) } ?: return
    val fill = Color(AvatarShapes.COLORS[color] ?: AvatarShapes.COLORS.getValue("ink"))
    val path = remember(shape) {
        val (start, segments) = AvatarShapes.outline(geometry)
        Path().apply {
            moveTo(start.first.toFloat(), start.second.toFloat())
            segments.forEach { c -> cubicTo(c.c1x.toFloat(), c.c1y.toFloat(), c.c2x.toFloat(), c.c2y.toFloat(), c.x.toFloat(), c.y.toFloat()) }
            close()
        }
    }
    Canvas(Modifier.size(size)) {
        val unit = this.size.minDimension / 100f
        scale(unit, unit, pivot = Offset.Zero) {
            drawPath(path, fill)
            val face = geometry.face
            translate(face.x.toFloat(), face.y.toFloat()) {
                rotate(face.rot.toFloat(), pivot = Offset.Zero) {
                    scale(face.scale.toFloat(), face.scale.toFloat(), pivot = Offset.Zero) {
                        val half = (face.gap / 2).toFloat()
                        // 网页的眼睛：6.5×15.5、圆角 3.25 的白色竖条。
                        for (x in floatArrayOf(-half, half)) {
                            drawRoundRect(Color.White, topLeft = Offset(x - 3.25f, -7.75f), size = Size(6.5f, 15.5f), cornerRadius = CornerRadius(3.25f, 3.25f))
                        }
                    }
                }
            }
        }
    }
}
