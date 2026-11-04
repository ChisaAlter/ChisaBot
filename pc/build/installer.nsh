; ChisaBot 安装脚本补充（package.json build.nsis.include；docs/online-update.md §2.1）。
;
; electron-builder 的安装包在更新模式（--updated，在线更新默认就是这样运行的）下会保留旧的快捷方式
; （keepShortcuts），也不刷新 Windows 图标缓存：exe 里的图标换了，桌面 / 开始菜单 / 任务栏上看到的还是旧的。
; 只刷新缓存也不一定够（0.1.11 在 Windows 11 上重新安装后图标仍是旧的）：资源管理器按「图标文件路径 + 序号」
; 缓存，exe 路径没变就可能继续用旧图。所以快捷方式的图标不再指向 exe，而是指向按内容哈希命名的
; resources\icons\chisabot-<哈希>.ico（build/icons/，pc/scripts/win-icon.mjs 生成）——新路径缓存里没有，一定按新文件读。
; 每次安装（全新安装、更新、重新安装）结束时这里都会：
;   1. 把还存在的桌面、开始菜单快捷方式重写一遍，图标 = 上面的 .ico（找不到就用 exe）；用户删掉的不会再建；
;   2. 通知资源管理器这几个文件变了（SHCNE_UPDATEITEM）和图标关联变了（SHCNE_ASSOCCHANGED + SHCNF_FLUSH）；
;   3. 运行 ie4uinit.exe -show（Windows 10/11 重建图标缓存；旧系统用 -ClearIconCache），失败就算了。
; 任务栏固定的快捷方式由客户端启动时更新（src/shell-refresh.js），安装程序不碰它。

!ifndef BUILD_UNINSTALLER
Var chisabotIcon
!endif

; 改名迁移（ChisaBot PC → ChisaBot，0.1.129）：productName 换了以后默认安装目录变成 Programs\ChisaBot，
; 不把旧安装卸掉，更新会并排装出第二个程序。这里在安装前先找到旧版的卸载入口静默卸掉——
; 旧进程此时已退出（自动更新走 quitAndInstall），文件能删干净；旧卸载程序只删自己的安装目录和
; 快捷方式，userData 在别处不受影响。入口两处都查：注册表卸载串（自定义目录装法）+ 默认安装目录。
!macro customInit
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\cn.ayase.chisabot.pc" "UninstallString"
  ${if} $0 == ""
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChisaBot PC" "UninstallString"
  ${endIf}
  ${if} $0 == ""
    ${if} ${FileExists} "$LOCALAPPDATA\Programs\ChisaBot PC\Uninstall ChisaBotPC.exe"
      StrCpy $0 '"$LOCALAPPDATA\Programs\ChisaBot PC\Uninstall ChisaBotPC.exe"'
    ${endIf}
  ${endIf}
  ${if} $0 != ""
    ExecWait '$0 /S'
  ${endIf}
!macroend

!macro chisabotFindIcon
  Push $R8
  Push $R9
  StrCpy $chisabotIcon "$appExe"
  ClearErrors
  FindFirst $R8 $R9 "$INSTDIR\resources\icons\chisabot-*.ico"
  ${if} $R9 != ""
    StrCpy $chisabotIcon "$INSTDIR\resources\icons\$R9"
  ${endIf}
  FindClose $R8
  ClearErrors
  Pop $R9
  Pop $R8
!macroend

!macro chisabotRefreshLink LINK
  ${if} ${FileExists} "${LINK}"
    CreateShortCut "${LINK}" "$appExe" "" "$chisabotIcon" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "${LINK}" "${APP_ID}"
    ; SHCNE_UPDATEITEM = 0x2000, SHCNF_PATHW = 0x0005
    System::Call 'shell32::SHChangeNotify(i 0x2000, i 0x0005, w "${LINK}", i 0)'
  ${endIf}
!macroend

!macro customInstall
  !insertmacro chisabotFindIcon
  !insertmacro chisabotRefreshLink "$newDesktopLink"
  !insertmacro chisabotRefreshLink "$newStartMenuLink"
  System::Call 'shell32::SHChangeNotify(i 0x2000, i 0x0005, w "$appExe", i 0)'
  ; SHCNE_ASSOCCHANGED = 0x08000000, SHCNF_FLUSH = 0x1000
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
  ${if} ${FileExists} "$SYSDIR\ie4uinit.exe"
    nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
    Pop $0
    ${if} $0 != 0
      nsExec::Exec '"$SYSDIR\ie4uinit.exe" -ClearIconCache'
      Pop $0
    ${endIf}
  ${endIf}
!macroend
