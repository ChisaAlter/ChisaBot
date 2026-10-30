package cn.ayase.chisabot

import cn.ayase.chisabot.ui.AvatarShapes
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/** 形象头像（kind = "shape"）：解析 + 几何和网页 app/src/lib/agents/avatar-shapes.ts 对齐。 */
class ShapeAvatarTest {
    private fun avatar(json: String) = parseAvatar(Json.parseToJsonElement(json))

    /** 网页 shapePath(SHAPES[x]) 的输出（bun 跑 avatar-shapes.ts 得到）。圆、水滴、三角：对称和按外框居中的都有。 */
    private val webPaths = mapOf(
        "round" to "M94.00 50.00C94.00 52.86 93.71 55.78 93.15 58.58C92.60 61.39 91.75 64.19 90.65 66.84C89.56 69.48 88.17 72.07 86.58 74.45C84.99 76.82 83.14 79.09 81.11 81.11C79.09 83.14 76.82 84.99 74.45 86.58C72.07 88.17 69.48 89.56 66.84 90.65C64.19 91.75 61.39 92.60 58.58 93.15C55.78 93.71 52.86 94.00 50.00 94.00C47.14 94.00 44.22 93.71 41.42 93.15C38.61 92.60 35.81 91.75 33.16 90.65C30.52 89.56 27.93 88.17 25.55 86.58C23.18 84.99 20.91 83.14 18.89 81.11C16.86 79.09 15.01 76.82 13.42 74.45C11.83 72.07 10.44 69.48 9.35 66.84C8.25 64.19 7.40 61.39 6.85 58.58C6.29 55.78 6.00 52.86 6.00 50.00C6.00 47.14 6.29 44.22 6.85 41.42C7.40 38.61 8.25 35.81 9.35 33.16C10.44 30.52 11.83 27.93 13.42 25.55C15.01 23.18 16.86 20.91 18.89 18.89C20.91 16.86 23.18 15.01 25.55 13.42C27.93 11.83 30.52 10.44 33.16 9.35C35.81 8.25 38.61 7.40 41.42 6.85C44.22 6.29 47.14 6.00 50.00 6.00C52.86 6.00 55.78 6.29 58.58 6.85C61.39 7.40 64.19 8.25 66.84 9.35C69.48 10.44 72.07 11.83 74.45 13.42C76.82 15.01 79.09 16.86 81.11 18.89C83.14 20.91 84.99 23.18 86.58 25.55C88.17 27.93 89.56 30.52 90.65 33.16C91.75 35.81 92.60 38.61 93.15 41.42C93.71 44.22 94.00 47.14 94.00 50.00Z",
        "drop" to "M83.00 56.00C83.00 58.15 82.79 60.33 82.37 62.44C81.95 64.54 81.31 66.65 80.49 68.63C79.67 70.61 78.63 72.55 77.44 74.33C76.25 76.12 74.85 77.82 73.33 79.33C71.82 80.85 70.12 82.25 68.33 83.44C66.55 84.63 64.61 85.67 62.63 86.49C60.65 87.31 58.54 87.95 56.44 88.37C54.33 88.78 52.15 89.00 50.00 89.00C47.85 89.00 45.67 88.78 43.56 88.37C41.46 87.95 39.35 87.31 37.37 86.49C35.39 85.67 33.45 84.63 31.67 83.44C29.88 82.25 28.18 80.85 26.67 79.33C25.15 77.82 23.75 76.12 22.56 74.33C21.37 72.55 20.33 70.61 19.51 68.63C18.69 66.65 18.05 64.54 17.63 62.44C17.21 60.33 17.00 58.15 17.00 56.00C16.99 53.85 17.21 51.67 17.61 49.56C18.01 47.44 18.64 45.35 19.40 43.32C20.16 41.30 21.12 39.35 22.15 37.39C23.18 35.43 24.33 33.56 25.56 31.56C26.79 29.56 28.04 27.51 29.55 25.39C31.06 23.27 32.62 20.87 34.61 18.85C36.61 16.83 38.94 14.58 41.50 13.27C44.07 11.96 47.17 11.00 50.00 11.00C52.83 11.00 55.93 11.96 58.50 13.27C61.06 14.58 63.39 16.83 65.39 18.85C67.38 20.87 68.94 23.27 70.45 25.39C71.96 27.51 73.21 29.56 74.44 31.56C75.67 33.56 76.82 35.43 77.85 37.39C78.88 39.35 79.84 41.30 80.60 43.32C81.36 45.35 81.99 47.44 82.39 49.56C82.79 51.67 83.01 53.85 83.00 56.00Z",
        "tri" to "M86.53 50.00C86.53 52.43 79.16 55.27 76.22 57.30C73.28 59.33 71.04 60.73 68.89 62.16C66.73 63.59 65.02 64.74 63.29 65.88C61.56 67.01 60.04 68.00 58.49 68.97C56.95 69.94 55.51 70.82 54.02 71.70C52.54 72.58 51.10 73.40 49.57 74.24C48.04 75.09 46.52 75.89 44.85 76.76C43.17 77.63 41.50 78.47 39.53 79.45C37.55 80.44 35.59 81.39 33.03 82.67C30.46 83.95 27.10 86.53 24.15 87.13C21.19 87.73 16.86 88.34 15.27 86.29C13.69 84.25 14.85 78.09 14.66 74.86C14.47 71.64 14.30 69.32 14.16 66.95C14.01 64.58 13.88 62.63 13.78 60.66C13.68 58.70 13.60 56.94 13.55 55.17C13.50 53.39 13.47 51.72 13.47 50.00C13.47 48.28 13.50 46.61 13.55 44.83C13.60 43.06 13.68 41.30 13.78 39.34C13.88 37.37 14.01 35.42 14.16 33.05C14.30 30.68 14.47 28.36 14.66 25.14C14.85 21.91 13.69 15.75 15.27 13.71C16.86 11.66 21.19 12.27 24.15 12.87C27.10 13.47 30.46 16.05 33.03 17.33C35.59 18.61 37.55 19.56 39.52 20.55C41.50 21.53 43.17 22.37 44.85 23.24C46.52 24.11 48.04 24.91 49.57 25.76C51.10 26.60 52.54 27.42 54.02 28.30C55.51 29.18 56.95 30.06 58.49 31.03C60.04 32.00 61.56 32.99 63.29 34.12C65.02 35.26 66.73 36.41 68.89 37.84C71.04 39.27 73.28 40.67 76.22 42.70C79.16 44.73 86.53 47.57 86.53 50.00Z",
    )

    private fun numbers(path: String) = Regex("-?[0-9]+(?:\\.[0-9]+)?").findAll(path).map { it.value.toDouble() }.toList()

    @Test fun shapeAvatarIsParsed() {
        val spec = avatar("""{"kind":"shape","shape":"cloud","color":"teal"}""")
        assertNotNull(spec)
        assertEquals("shape", spec!!.kind)
        assertEquals("cloud", spec.shape)
        assertEquals("teal", spec.color)
    }

    @Test fun unknownShapeOrColorFallsBackToDefault() {
        assertNull(avatar("""{"kind":"shape","shape":"octopus","color":"teal"}"""))
        assertNull(avatar("""{"kind":"shape","shape":"cloud","color":"sky"}"""))
        assertNull(avatar("""{"kind":"shape","color":"teal"}"""))
        assertNull(avatar("""{"kind":"hologram"}"""))
    }

    @Test fun otherKindsStillParse() {
        assertEquals("emoji", avatar("""{"kind":"emoji","emoji":"🐱","color":"sky"}""")?.kind)
        assertEquals("monogram", avatar("""{"kind":"monogram","color":"rose"}""")?.kind)
        assertEquals("/api/bot-avatars/a/image?v=1", avatar("""{"kind":"image","url":"/api/bot-avatars/a/image?v=1","version":"1"}""")?.url)
    }

    @Test fun everyWebShapeAndColorIsKnown() {
        val shapes = listOf("round", "cloud", "tile", "sparkle", "bloom", "bean", "scallop", "drop", "pill", "tri", "hex", "burst", "gem", "fruit")
        assertEquals(shapes, AvatarShapes.SHAPES)
        assertEquals(listOf("ink", "brown", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink", "gray"), AvatarShapes.COLORS.keys.toList())
        for (shape in shapes) {
            val g = AvatarShapes.geometry(shape)
            assertNotNull(shape, g)
            assertEquals(AvatarShapes.ANCHORS, g!!.radii.size)
            assertTrue(shape, g.radii.all { it in 12.0..47.0 })
        }
        assertNull(AvatarShapes.geometry("octopus"))
    }

    @Test fun outlineMatchesWeb() {
        for ((shape, web) in webPaths) {
            val mine = numbers(AvatarShapes.svgPath(AvatarShapes.geometry(shape)!!))
            val theirs = numbers(web)
            assertEquals(shape, theirs.size, mine.size)
            mine.zip(theirs).forEachIndexed { i, (a, b) -> assertTrue("$shape #$i: $a vs $b", abs(a - b) <= 0.011) }
        }
    }

    @Test fun faceFollowsTheCentredShape() {
        // 水滴不对称：外框居中后眼睛跟着移（网页 SHAPES.drop.face）。
        val face = AvatarShapes.geometry("drop")!!.face
        assertEquals(50.0, face.x, 0.01)
        assertEquals(64.0, face.y, 0.01)
        assertEquals(16.0, face.gap, 0.0)
        assertEquals(0.95, face.scale, 0.0)
        assertEquals(34.525, AvatarShapes.geometry("tri")!!.face.x, 0.01)
    }
}
