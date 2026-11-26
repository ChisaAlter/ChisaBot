package cn.ayase.chisabot

import android.media.AudioDeviceInfo
import android.os.Build
import cn.ayase.chisabot.ui.cleanupStaleCameraCache
import cn.ayase.chisabot.ui.shouldUsePublicDownloadsDir
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files

class HardeningLogicTest {

    // ---- P1-11: Updater HTTPS 校验与版本号防路径穿越 ----

    @Test
    fun updaterAllowsOnlyHttpsWithoutUserInfo() {
        val ok = requireHttpsUpdateUrl("https://github.com/org/repo/releases/latest/download/chisabot-android.json")
        assertEquals("https", ok.protocol)
        assertEquals("github.com", ok.host)

        for (bad in listOf(
            "",
            "   ",
            "http://github.com/org/repo/releases/latest/download/chisabot-android.json",
            "http://192.168.1.5:8080/update.json",
            "file:///etc/passwd",
            "ftp://example.com/app.apk",
            "https://user:pass@example.com/app.apk",
            "not-a-url",
        )) {
            try {
                requireHttpsUpdateUrl(bad)
                fail("Expected rejection for URL: $bad")
            } catch (_: IllegalArgumentException) {
                // expected
            }
        }
    }

    @Test
    fun updaterVersionWhitelistRejectsPathTraversal() {
        for (good in listOf("0.1.191", "1.0.0-rc.1", "v2.3.4_beta", "2026.11.27")) {
            assertEquals(good, validateUpdateVersion(good))
        }

        for (bad in listOf(
            "",
            "   ",
            "..",
            ".",
            "../evil",
            "0.1.0/../../evil",
            "0.1.0\\evil",
            "0.1..2",
            ".hidden",
            "-leading-dash",
            "0.1.0 evil",
            "a".repeat(65),
        )) {
            try {
                validateUpdateVersion(bad)
                fail("Expected rejection for version: $bad")
            } catch (_: IllegalArgumentException) {
                // expected
            }
        }
    }

    @Test
    fun updaterResolveSafeApkStaysInsideUpdatesDir() {
        val dir = Files.createTempDirectory("chisa-updates-test").toFile()
        try {
            val file = resolveSafeUpdateApkFile(dir, "0.1.192")
            assertEquals(dir.canonicalFile, file.parentFile)
            assertEquals("ChisaBot-Android-0.1.192.apk", file.name)

            try {
                resolveSafeUpdateApkFile(dir, "../../pwn")
                fail("Expected path traversal rejection")
            } catch (_: IllegalArgumentException) {
                // expected
            }
        } finally {
            dir.deleteRecursively()
        }
    }

    // ---- P1-12: 拍照缓存过期清理 & 同源语音桥零阻塞校验 ----

    @Test
    fun cleanupStaleCameraCacheDeletesOnlyExpiredCameraFiles() {
        val dir = Files.createTempDirectory("chisa-camera-test").toFile()
        try {
            val now = 1_700_000_000_000L
            val staleCapture = File(dir, "capture-1.jpg").apply { writeText("old"); setLastModified(now - 60_000L) }
            val stalePhoto = File(dir, "photo-2.jpg").apply { writeText("old2"); setLastModified(now - 60_000L) }
            val activeCapture = File(dir, "capture-3.jpg").apply { writeText("active"); setLastModified(now - 60_000L) }
            val freshCapture = File(dir, "capture-4.jpg").apply { writeText("fresh"); setLastModified(now - 1_000L) }
            val unrelated = File(dir, "keep.txt").apply { writeText("other"); setLastModified(now - 60_000L) }

            val removed = cleanupStaleCameraCache(dir, nowMs = now, maxAgeMs = 30_000L, keepFile = activeCapture)
            assertEquals(2, removed)
            assertFalse(staleCapture.exists())
            assertFalse(stalePhoto.exists())
            assertTrue(activeCapture.exists())
            assertTrue(freshCapture.exists())
            assertTrue(unrelated.exists())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun voiceOriginKeyNormalizationMatchesSameOriginOnly() {
        assertEquals("https://chat.example.com:443", normalizeVoiceOriginKey("https://Chat.Example.COM/channel/1"))
        assertEquals("https://chat.example.com:443", normalizeVoiceOriginKey("https://chat.example.com:443/"))
        assertEquals("http://192.168.1.10:80", normalizeVoiceOriginKey("http://192.168.1.10/settings"))
        assertNull(normalizeVoiceOriginKey("javascript:alert(1)"))
        assertNull(normalizeVoiceOriginKey("file:///android_asset/index.html"))
        assertNull(normalizeVoiceOriginKey(null))
    }

    // ---- P1-13: API <= 28 下载目录策略 ----

    @Test
    fun publicDownloadsDirStrategyHandlesApi28WithoutPermission() {
        assertTrue(shouldUsePublicDownloadsDir(sdkInt = Build.VERSION_CODES.Q, hasWriteExternalStoragePermission = false))
        assertTrue(shouldUsePublicDownloadsDir(sdkInt = Build.VERSION_CODES.TIRAMISU, hasWriteExternalStoragePermission = false))
        assertTrue(shouldUsePublicDownloadsDir(sdkInt = Build.VERSION_CODES.P, hasWriteExternalStoragePermission = true))
        assertFalse(shouldUsePublicDownloadsDir(sdkInt = Build.VERSION_CODES.P, hasWriteExternalStoragePermission = false))
        assertFalse(shouldUsePublicDownloadsDir(sdkInt = Build.VERSION_CODES.O, hasWriteExternalStoragePermission = false))
    }

    // ---- P2: GatewayAuth 响应体上限防 OOM ----

    @Test
    fun gatewayAuthBoundedReadEnforcesMaxBytes() {
        val small = "hello-chisa".toByteArray(Charsets.UTF_8)
        assertEquals("hello-chisa", GatewayAuth.readResponseBodyBounded(ByteArrayInputStream(small), maxBytes = 16))

        val exact = ByteArray(16) { 'a'.code.toByte() }
        assertEquals("a".repeat(16), GatewayAuth.readResponseBodyBounded(ByteArrayInputStream(exact), maxBytes = 16))

        val tooLarge = ByteArray(17) { 'b'.code.toByte() }
        try {
            GatewayAuth.readResponseBodyBounded(ByteArrayInputStream(tooLarge), maxBytes = 16)
            fail("Expected LoginError for oversized response")
        } catch (e: GatewayAuth.LoginError) {
            assertEquals("invalid", e.kind)
        }
    }

    // ---- P2: VoiceCallAudioManager API 31+ 通信设备选路 ----

    @Test
    fun preferredCommunicationDevicePrioritizesExternalHeadsets() {
        val withBtAndSpeaker = listOf(
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        )
        assertEquals(
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            selectPreferredCommunicationDeviceType(withBtAndSpeaker, speakerphoneOn = true),
        )

        val withUsbAndSpeaker = listOf(
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
            AudioDeviceInfo.TYPE_USB_HEADSET,
        )
        assertEquals(
            AudioDeviceInfo.TYPE_USB_HEADSET,
            selectPreferredCommunicationDeviceType(withUsbAndSpeaker, speakerphoneOn = true),
        )

        val builtInOnly = listOf(
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
        )
        assertEquals(
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
            selectPreferredCommunicationDeviceType(builtInOnly, speakerphoneOn = true),
        )
        assertEquals(
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
            selectPreferredCommunicationDeviceType(builtInOnly, speakerphoneOn = false),
        )

        assertNull(selectPreferredCommunicationDeviceType(emptyList(), speakerphoneOn = true))
    }
}
