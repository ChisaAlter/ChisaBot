package cn.ayase.chisabot.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.ayase.chisabot.AppViewModel
import cn.ayase.chisabot.BuildConfig
import cn.ayase.chisabot.GatewayAuth
import cn.ayase.chisabot.MainActivity
import cn.ayase.chisabot.Pairing
import cn.ayase.chisabot.R
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch

/** 登录（DESIGN §33）：扫码绑定是主路径；账号密码是备用（同一个登录网关）。 */
@Composable
fun LoginScreen(vm: AppViewModel, activity: MainActivity) {
    val sky = LocalSky.current
    val scope = rememberCoroutineScope()
    var server by remember { mutableStateOf(vm.prefs.getString("server", null)?.takeIf { it.isNotBlank() } ?: BuildConfig.DEFAULT_SERVER) }
    var username by remember { mutableStateOf(vm.prefs.getString("username", "") ?: "") }
    var password by remember { mutableStateOf("") }
    var remember by remember { mutableStateOf(vm.prefs.getBoolean("remember", true)) }
    var showPassword by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val notice = vm.notice

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).statusBarsPadding().navigationBarsPadding().imePadding().padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(36.dp))
        Image(painterResource(R.drawable.splash_logo), contentDescription = null, modifier = Modifier.size(84.dp).clip(CircleShape))
        Spacer(Modifier.height(14.dp))
        Text(buildAnnotatedString {
            withStyle(SpanStyle(color = sky.brandRed, fontWeight = FontWeight.Bold)) { append("Chisa") }
            withStyle(SpanStyle(color = sky.ink1, fontWeight = FontWeight.Bold)) { append("Bot") }
        }, fontSize = 28.sp)
        Text("登录 ChisaBot", color = sky.ink3, fontSize = 14.sp)
        Spacer(Modifier.height(22.dp))

        Column(
            Modifier.widthIn(max = 440.dp).fillMaxWidth().glass(sky, RoundedCornerShape(22.dp), level = 2).padding(18.dp).animateContentSize(tween(220)),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (notice.isNotBlank() || error.isNotBlank()) {
                Text(
                    error.ifBlank { notice }, color = if (error.isNotBlank()) sky.danger else sky.ink2, fontSize = 13.5.sp,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                        .background(if (error.isNotBlank()) sky.danger.copy(alpha = 0.10f) else sky.accentSoft).padding(10.dp),
                )
            }
            Text("在电脑上打开 ChisaBot 网页 →「设置 → 设备 → 绑定手机」，扫一下二维码就能登录。", color = sky.ink2, fontSize = 14.sp, lineHeight = 21.sp)
            AsyncButton("扫码绑定", "正在绑定…", "已绑定", Modifier.fillMaxWidth()) {
                error = ""
                val text = CompletableDeferred<String?>()
                activity.scan { text.complete(it) }
                val contents = text.await() ?: return@AsyncButton null // 扫码页被划掉 = 取消，不是失败
                val scanned = Pairing.inspect(contents)
                if (scanned !is Pairing.Result.Ok) { error = (scanned as Pairing.Result.Bad).reason; return@AsyncButton false }
                try { vm.pair(scanned.link); scope.launch { kotlinx.coroutines.delay(500); vm.enterApp() }; true }
                catch (e: Exception) { error = e.message ?: "绑定失败"; false }
            }
            Text(
                if (showPassword) "收起账号密码登录" else "用账号密码登录",
                color = sky.accent, fontSize = 14.sp,
                modifier = Modifier.align(Alignment.CenterHorizontally).clip(RoundedCornerShape(8.dp)).clickable { showPassword = !showPassword }.padding(8.dp),
            )
            AnimatedVisibility(showPassword, enter = fadeIn(tween(200)), exit = fadeOut(tween(150))) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Field("服务器地址", server, { server = it }, placeholder = "chisabot.example.com:8443", type = KeyboardType.Uri)
                    val recent = vm.recentServers().filter { it != server }.take(3)
                    if (recent.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        recent.forEach { r ->
                            Text(r.removePrefix("https://"), color = sky.ink2, fontSize = 12.sp, maxLines = 1,
                                modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(sky.glass1).clickable { server = r }.padding(horizontal = 10.dp, vertical = 5.dp))
                        }
                    }
                    Field("账号", username, { username = it })
                    Field("密码", password, { password = it }, password = true)
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { remember = !remember }) {
                        Checkbox(remember, { remember = it }, colors = CheckboxDefaults.colors(checkedColor = sky.accent))
                        Text("记住登录（30 天）", color = sky.ink2, fontSize = 14.sp)
                    }
                    AsyncButton("登录", "登录中…", "登录成功", Modifier.fillMaxWidth()) {
                        error = ""
                        try {
                            vm.passwordLogin(server, username, password, remember)
                            password = ""
                            scope.launch { kotlinx.coroutines.delay(500); vm.enterApp() }
                            true
                        } catch (e: GatewayAuth.LoginError) {
                            // 自己部署、没有登录网关的服务器（如本机预览）：两个登录端点都 404 → 只记地址直接进
                            if (e.kind == "nogw") {
                                runCatching { vm.openWithoutGateway(server) }.onSuccess { scope.launch { vm.enterApp() } }.isSuccess
                            } else { error = e.message ?: "登录失败"; false }
                        } catch (e: Exception) { error = e.message ?: "登录失败"; false }
                    }
                    if (BuildConfig.ALLOW_LOCAL_HTTP) {
                        AsyncButton("直接打开（无登录网关的服务器）", "连接中…", "已连接", Modifier.fillMaxWidth(), primary = false) {
                            error = ""
                            try { vm.openWithoutGateway(server); scope.launch { vm.enterApp() }; true } catch (e: Exception) { error = e.message ?: "连接失败"; false }
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(18.dp))
        Text("版本 ${BuildConfig.VERSION_NAME}", color = sky.ink4, fontSize = 12.sp)
        Box(Modifier.height(24.dp))
    }
}

@Composable
private fun Field(label: String, value: String, onChange: (String) -> Unit, placeholder: String = "", password: Boolean = false, type: KeyboardType = KeyboardType.Text) {
    val sky = LocalSky.current
    OutlinedTextField(
        value, onChange, label = { Text(label) }, singleLine = true,
        placeholder = { if (placeholder.isNotEmpty()) Text(placeholder, color = sky.ink4) },
        visualTransformation = if (password) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = if (password) KeyboardType.Password else type),
        shape = RoundedCornerShape(14.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = sky.accent, unfocusedBorderColor = sky.ink4.copy(alpha = 0.5f),
            focusedContainerColor = sky.glass3, unfocusedContainerColor = sky.glass2,
            focusedTextColor = sky.ink1, unfocusedTextColor = sky.ink1, focusedLabelColor = sky.accent, unfocusedLabelColor = sky.ink3,
        ),
        modifier = Modifier.fillMaxWidth(),
    )
}
