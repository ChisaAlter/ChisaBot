# Android 客户端

Android（`android/`）以全屏 WebView 加载服务器提供的 React 前端，使用与桌面相同的组件、主题、消息气泡、卡片和设置，在手机 viewport 下应用现有响应式布局。没有额外的原生聊天顶栏、输入框或机器人列表。

## 主入口与系统能力

- `MainActivity.kt`：启动已有服务器会话；保留扫码绑定、系统相机收到的 `chisabot://pair` 链接、桌面快捷方式和 APK 更新。
- `AppViewModel.kt`：沿用 SharedPreferences `chisabot` 与 CookieManager 的登录状态；按服务器恢复上次网页路由。首启/切换服务器使用原有登录页。
- `ui/WebScreen.kt`：承载完整 React 应用。同源页面在壳内导航，站外 HTTP(S)、邮件和电话链接交给系统。Android 返回键先调用网页已有 `window.__chisabotBack()` 关闭抽屉，再退网页历史，最后将 App 移到后台。
- 文件选择沿用网页 `<input type=file>` 的类型和多选要求；拍照入口使用系统相机和 FileProvider。录音仅向同源页面授予麦克风权限。
- 文件下载由 Android DownloadManager 执行，同源下载携带 Cookie，完成通知和下载目录由系统管理。
- 代码块和任务的 `blob:` 导出由 `ui/WebExports.kt` 捕获这次用户点击产生的同源内容，交给系统“保存文件”。保留文件名与字节；通用文本 MIME 的保存提示按已知扩展名补充类型，避免 `.js` 被系统改成 `.js.txt`。取消后页面照常使用；单次导出上限 20 MB。
- 网页使用真实可用 viewport；系统栏与软键盘 Insets 由壳处理，网页继续使用自身手机断点。网页主题存储是主界面的外观来源，导航不会覆盖用户选择。

WebView UA 带 `ChisaBotAndroid/<version>`，**不带 `native` 后缀**。网页由此识别 App 壳并关闭 PWA 安装提示；服务器只有旧 `ChisaBotAndroid/<version> native` 客户端归类为受限原生协议 surface，主界面使用完整 web 工具与交互合同。

## 登录、恢复和更新

登录、扫码绑定和设备令牌续期复用 `GatewayAuth.kt`、`Pairing.kt` 与 CookieManager。同源页面登录过期时先尝试已绑定设备续期，失败再回服务器登录页。切换服务器和退出登录仍可由桌面图标长按快捷方式进入；后台自动检查 APK 更新。服务器前端更新继续使用网页自己的刷新提示。

debug 包才开放 WebView 调试。应用不暴露任意 JavaScript 调用原生权限的通用桥；返回处理仅消费既有网页布尔回执。

## 兼容代码

`chat/Model.kt`、`chat/Turns.kt`、`ui/BotsScreen.kt`、`ui/ChatScreen.kt`、`ui/PanelsScreen.kt` 与原生历史轮询仍保留，供旧协议回归和迁移兼容使用；它们不再构成 Android 的主产品界面。先前原生页面验收不能替代当前完整网页手机布局验收。

## 构建与验证

使用 JDK 17、Gradle 8.9、Android SDK 34：`cd android && gradle assembleDebug`。发布构建 `gradle assembleRelease`，签名仅从现有环境变量加载；`gradle testDebugUnitTest` 运行原生边界单测。

升级用 `adb install -r app/build/outputs/apk/debug/app-debug.apk` 保留账号、Cookie、网页存储和历史。验收需实际安装后检查网页 DOM/资源与服务器前端一致，手机抽屉、键盘/输入框、发送/停止、确认卡、文件选择/下载和关闭重开。桌面浏览器的窄屏预览是视觉参考，不能替代实际 WebView 与 Android 系统能力检查。
