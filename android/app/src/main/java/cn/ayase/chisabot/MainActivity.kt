package cn.ayase.chisabot

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import cn.ayase.chisabot.ui.BotsScreen
import cn.ayase.chisabot.ui.ChatScreen
import cn.ayase.chisabot.ui.ChisaTheme
import cn.ayase.chisabot.ui.LoginScreen
import cn.ayase.chisabot.ui.PanelsScreen
import cn.ayase.chisabot.ui.SkyBackground
import cn.ayase.chisabot.ui.WebScreen
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.launch

/**
 * ChisaBot Android 原生版（Kotlin + Jetpack Compose）。登录、机器人列表、聊天（流式、干活卡、富卡片）、面板是原生的；
 * 设置 / 管理等还没做成原生的页面在应用内的网页页（WebScreen）里打开，同一个会话，不会走到死路。
 * 登录状态沿用 WebView 版（SharedPreferences「chisabot」+ CookieManager），从旧版更新过来不用重新登录。
 */
class MainActivity : ComponentActivity() {

    private val vm: AppViewModel by viewModels()
    private lateinit var updater: Updater
    private var pairPrompt by mutableStateOf<Pairing.Link?>(null)
    private var confirmLogout by mutableStateOf(false)
    private var onScanned: ((String?) -> Unit)? = null

    private val scanner = registerForActivityResult(ScanContract()) { result ->
        onScanned?.invoke(result.contents)
        onScanned = null
    }

    fun scan(callback: (String?) -> Unit) {
        onScanned = callback
        scanner.launch(
            ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("扫描网页「设置 → 设备 → 绑定手机」里的二维码")
                .setBeepEnabled(false).setOrientationLocked(false),
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
        )
        // 图片走同一个会话 Cookie（上传的机器人头像、对话里的服务器文件都要登录才能取）。
        coil.Coil.setImageLoader(coil.ImageLoader.Builder(this).okHttpClient { cn.ayase.chisabot.net.Api.imageClient }.crossfade(180).build())
        updater = Updater(this)
        vm.start()
        setContent {
            // 外观（设置 → 外观）：跟随系统 / 浅色 / 深色；状态栏 / 导航栏图标颜色跟着变
            val dark = when (vm.themeMode) { "light" -> false; "dark" -> true; else -> isSystemInDarkTheme() }
            androidx.compose.runtime.LaunchedEffect(dark) {
                val bar = if (dark) SystemBarStyle.dark(android.graphics.Color.TRANSPARENT) else SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = bar, navigationBarStyle = bar)
            }
            ChisaTheme(dark = dark) {
                SkyBackground { App() }
            }
        }
        if (savedInstanceState == null) {
            updater.check(silent = true)
            handleIntent(intent)
        }
    }

    override fun onResume() {
        super.onResume()
        updater.onResume()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    /** 桌面图标长按「切换服务器」/「退出登录」；系统相机扫到的 chisabot://pair 链接。 */
    private fun handleIntent(intent: Intent?) {
        when (intent?.action) {
            ACTION_SERVER -> { vm.stack.clear(); vm.stack += Screen.Login }
            ACTION_LOGOUT -> confirmLogout = true
            Intent.ACTION_VIEW -> intent.data?.toString()?.let { text ->
                val link = Pairing.parse(text)
                if (link == null) Toast.makeText(this, "这不是 ChisaBot 的绑定二维码", Toast.LENGTH_SHORT).show() else pairPrompt = link
            }
        }
    }

    fun checkUpdate() = updater.check(silent = false)

    @Composable
    private fun App() {
        val screen = vm.screen
        BackHandler(enabled = vm.stack.size > 1) { vm.back() }
        AnimatedContent(
            targetState = screen,
            transitionSpec = {
                val forward = vm.stack.size >= 2 && targetState == vm.stack.last() && initialState != targetState && targetState !is Screen.Login && targetState !is Screen.Bots
                if (forward) (slideInHorizontally(tween(260)) { it / 6 } + fadeIn(tween(220))) togetherWith fadeOut(tween(160))
                else fadeIn(tween(220)) togetherWith (slideOutHorizontally(tween(240)) { it / 6 } + fadeOut(tween(180)))
            },
            label = "screen",
        ) { s ->
            when (s) {
                Screen.Login -> LoginScreen(vm, this@MainActivity)
                Screen.Bots -> BotsScreen(vm, onCheckUpdate = ::checkUpdate, onLogout = { confirmLogout = true })
                Screen.Settings -> cn.ayase.chisabot.ui.SettingsScreen(vm, onCheckUpdate = ::checkUpdate, onLogout = { confirmLogout = true })
                is Screen.Chat -> ChatScreen(vm, s.bot)
                is Screen.Panels -> PanelsScreen(vm, s.bot)
                is Screen.Web -> WebScreen(vm, s.path, s.title)
            }
        }
        pairPrompt?.let { link ->
            AlertDialog(
                onDismissRequest = { pairPrompt = null },
                title = { Text("绑定这台手机？") },
                text = { Text("将这台手机绑定到\n${link.server}\n\n绑定后会登录到生成二维码的账号，并出现在它的设备列表里。只在你自己刚生成二维码时继续。") },
                confirmButton = {
                    TextButton(onClick = {
                        pairPrompt = null
                        Toast.makeText(this, "正在绑定…", Toast.LENGTH_SHORT).show()
                        lifecycleScope.launch {
                            runCatching { vm.pair(link) }
                                .onSuccess { vm.enterApp() }
                                .onFailure { Toast.makeText(this@MainActivity, it.message ?: "绑定失败", Toast.LENGTH_LONG).show() }
                        }
                    }) { Text("绑定") }
                },
                dismissButton = { TextButton(onClick = { pairPrompt = null }) { Text("取消") } },
            )
        }
        if (confirmLogout) {
            AlertDialog(
                onDismissRequest = { confirmLogout = false },
                title = { Text("退出登录？") },
                text = { Text("这台手机会退出 ${vm.origin() ?: "服务器"}，扫码绑定也会解除。") },
                confirmButton = { TextButton(onClick = { confirmLogout = false; vm.logout() }) { Text("退出") } },
                dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text("取消") } },
            )
        }
    }

    companion object {
        const val ACTION_SERVER = "cn.ayase.chisabot.SERVER"
        const val ACTION_LOGOUT = "cn.ayase.chisabot.LOGOUT"
    }
}
