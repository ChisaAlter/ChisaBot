package cn.ayase.chisabot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.ayase.chisabot.AppViewModel
import cn.ayase.chisabot.chat.o
import cn.ayase.chisabot.chat.s
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** 同网页 GITHUB_NEW_TOKEN_URL（shared/github.ts）：预填名称、90 天、contents/issues/pull_requests 读写。 */
private const val GITHUB_NEW_TOKEN_URL =
    "https://github.com/settings/personal-access-tokens/new?name=ChisaBot&description=ChisaBot%20%E6%9C%BA%E5%99%A8%E4%BA%BA%E4%BD%BF%E7%94%A8&expires_in=90&contents=write&issues=write&pull_requests=write"

/** 对话里的「连接 GitHub」胶囊指向的站内路径（同网页 GITHUB_CONNECT_HREF）。 */
const val GITHUB_CONNECT_HREF = "/settings/connected-accounts/github"

/**
 * GitHub 令牌连接对话框（同网页 GithubTokenDialog，DESIGN §53）：两步——去 GitHub 建令牌、粘贴连接。
 * 令牌只 POST 给 /api/github/connect，不进对话记录；已连着时是「更换」。
 */
@Composable
fun GithubConnectDialog(vm: AppViewModel, onClose: () -> Unit) {
    val sky = LocalSky.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var token by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var connected by remember { mutableStateOf<String?>(null) }  // 已连接的 @login
    var done by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        val api = vm.api ?: return@LaunchedEffect
        runCatching { api.get("/api/github").o("connection") }
            .getOrNull()?.s("login")?.let { connected = it }
    }

    val trimmed = token.trim()
    val valid = trimmed.length >= 20 && !trimmed.any { it.isWhitespace() }

    AlertDialog(
        onDismissRequest = { if (!busy) onClose() },
        title = { Text(if (connected != null) "更换 GitHub 令牌" else "连接 GitHub", fontWeight = FontWeight.SemiBold) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text("令牌只发往 api.github.com，加密保存；保存后谁也看不到，包括你自己。", fontSize = 13.sp)
                if (connected != null) Text("当前已连接 @$connected", color = sky.accent, fontSize = 12.5.sp, modifier = Modifier.padding(top = 6.dp))
                Spacer(Modifier.height(12.dp))
                Row {
                    Text("1", color = sky.accent, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.width(8.dp))
                    Column {
                        Text("在 GitHub 创建令牌", fontSize = 13.5.sp, fontWeight = FontWeight.Medium)
                        Text("已预填名称、90 天有效期和 Contents · Issues · Pull requests 读写权限；在 Repository access 里选要给机器人的仓库。", color = sky.ink3, fontSize = 12.sp)
                        Text(
                            "打开 GitHub 创建令牌 ↗", color = sky.accent, fontSize = 13.sp,
                            modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable { openUrl(ctx, GITHUB_NEW_TOKEN_URL) }.padding(vertical = 6.dp),
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
                Row {
                    Text("2", color = sky.accent, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.width(8.dp))
                    Column(Modifier.weight(1f)) {
                        Text("粘贴令牌", fontSize = 13.5.sp, fontWeight = FontWeight.Medium)
                        androidx.compose.material3.OutlinedTextField(
                            value = token,
                            onValueChange = { token = it; error = null },
                            placeholder = { Text("github_pat_…", fontFamily = FontFamily.Monospace, fontSize = 13.sp) },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                        )
                        Text("也可以用 Classic 令牌（勾 repo），但 Fine-grained 只开放选中的仓库，更安全。", color = sky.ink3, fontSize = 11.5.sp, modifier = Modifier.padding(top = 4.dp))
                    }
                }
                error?.let { Text(it, color = sky.danger, fontSize = 12.5.sp, modifier = Modifier.padding(top = 8.dp)) }
                if (done) Text("已连接，可以在对话里让我读写 GitHub 了。", color = sky.accent, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
            }
        },
        confirmButton = {
            TextButton(
                enabled = valid && !busy && !done,
                onClick = {
                    val api = vm.api ?: return@TextButton
                    busy = true; error = null
                    scope.launch {
                        val res = runCatching {
                            api.post("/api/github/connect", buildJsonObject { put("token", JsonPrimitive(trimmed)) })
                        }
                        busy = false
                        if (res.isSuccess) { done = true; connected = res.getOrNull()?.o("connection")?.s("login") }
                        else error = res.exceptionOrNull()?.message?.take(80) ?: "连接失败，请重试"
                    }
                },
            ) { Text(if (busy) "验证中…" else if (done) "已连接" else if (connected != null) "更换" else "连接") }
        },
        dismissButton = { TextButton(onClick = onClose, enabled = !busy) { Text(if (done) "完成" else "取消") } },
    )
}
