"use strict";
/**
 * Windows 常驻 STA PowerShell Helper：
 * - 按需懒启动，仅预编译一次 C# CBInput / CBWin 类并加载 UIAutomationClient / System.Windows.Forms / System.Drawing；
 * - 严格通过 stdin/stdout 单行 JSON 白名单分派（严禁 Invoke-Expression 或任意脚本拼接）；
 * - 覆盖后台无感窗口枚举（win_list）、离屏抓图（win_capture）、结构化控件树快照（uia_snapshot）与无焦点语义操控（uia_act）；
 * - 空闲超时自动回收，崩溃或管道异常自动重启并单次重试；
 * - 暴露 dispose() 供 Electron app.on("before-quit") 与进程退出彻底终止，防僵尸残留。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const RESPONSE_PREFIX = "CBPS:";
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_ENCODED_CMD_CHARS = 28_000;
const ALLOWED_COMMANDS = new Set([
  "ping",
  "cursor_pos",
  "input",
  "uia_read",
  "uia_action",
  "win_list",
  "win_capture",
  "uia_snapshot",
  "uia_act",
]);

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function killPidTree(pid, { sync = false } = {}) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      if (sync) {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
          timeout: 3000,
        });
      } else {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", () => {});
        killer.unref();
      }
      return;
    }
    process.kill(pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

/**
 * 构造常驻 STA PowerShell 脚本。
 * 安全红线：仅按固定 switch 白名单分派受控结构化 JSON 命令，绝对不含 Invoke-Expression。
 */
function buildResidentHelperScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$utf8NoBom = New-Object System.Text.UTF8Encoding($false)",
    "[Console]::InputEncoding = $utf8NoBom",
    "[Console]::OutputEncoding = $utf8NoBom",
    "$OutputEncoding = $utf8NoBom",
    "Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes | Out-Null",
    "if (-not ('CBWin' -as [type])) {",
    'Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"',
    "using System;",
    "using System.Collections.Generic;",
    "using System.Drawing;",
    "using System.Drawing.Drawing2D;",
    "using System.Drawing.Imaging;",
    "using System.IO;",
    "using System.Runtime.InteropServices;",
    "using System.Text;",
    "[StructLayout(LayoutKind.Sequential)]",
    "public struct CBPoint { public int X; public int Y; }",
    "[StructLayout(LayoutKind.Sequential)]",
    "public struct CBRect { public int Left; public int Top; public int Right; public int Bottom; }",
    "public sealed class CBWinEntry {",
    "  public long Hwnd;",
    "  public int Pid;",
    "  public string Title;",
    "  public bool IsActive;",
    "  public bool IsMinimized;",
    "  public int Left;",
    "  public int Top;",
    "  public int Width;",
    "  public int Height;",
    "}",
    "public sealed class CBCaptureResult {",
    "  public bool Ok;",
    "  public int WindowWidth;",
    "  public int WindowHeight;",
    "  public int Width;",
    "  public int Height;",
    "  public string Base64;",
    "  public string Error;",
    "}",
    '[ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
    "public interface ICbUia3 {",
    "  [PreserveSig] int CompareElements(IntPtr el1, IntPtr el2, out int areSame);",
    "  [PreserveSig] int CompareRuntimeIds(IntPtr r1, IntPtr r2, out int areSame);",
    "  [PreserveSig] int GetRootElement(out ICbUia3Element root);",
    "  [PreserveSig] int ElementFromHandle(IntPtr hwnd, out ICbUia3Element el);",
    "  [PreserveSig] int ElementFromPoint(long pt, out ICbUia3Element el);",
    "  [PreserveSig] int GetFocusedElement(out ICbUia3Element el);",
    "  [PreserveSig] int GetRootElementBuildCache(IntPtr cache, out ICbUia3Element root);",
    "  [PreserveSig] int ElementFromHandleBuildCache(IntPtr hwnd, IntPtr cache, out ICbUia3Element el);",
    "  [PreserveSig] int ElementFromPointBuildCache(long pt, IntPtr cache, out ICbUia3Element el);",
    "  [PreserveSig] int GetFocusedElementBuildCache(IntPtr cache, out ICbUia3Element el);",
    "  [PreserveSig] int CreateTreeWalker(IntPtr cond, out ICbUia3Walker walker);",
    "  [PreserveSig] int get_ControlViewWalker(out ICbUia3Walker walker);",
    "}",
    '[ComImport, Guid("4042c624-389c-4afc-a630-9df854a541fc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
    "public interface ICbUia3Walker {",
    "  [PreserveSig] int GetParentElement(ICbUia3Element el, out ICbUia3Element parent);",
    "  [PreserveSig] int GetFirstChildElement(ICbUia3Element el, out ICbUia3Element first);",
    "  [PreserveSig] int GetLastChildElement(ICbUia3Element el, out ICbUia3Element last);",
    "  [PreserveSig] int GetNextSiblingElement(ICbUia3Element el, out ICbUia3Element next);",
    "  [PreserveSig] int GetPreviousSiblingElement(ICbUia3Element el, out ICbUia3Element prev);",
    "  [PreserveSig] int NormalizeElement(ICbUia3Element el, out ICbUia3Element norm);",
    "}",
    '[ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
    "public interface ICbUia3Element {",
    "  [PreserveSig] int SetFocus();",
    "  [PreserveSig] int GetRuntimeId([MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_I4)] out int[] runtimeId);",
    "  [PreserveSig] int FindFirst(int scope, IntPtr cond, out ICbUia3Element found);",
    "  [PreserveSig] int FindAll(int scope, IntPtr cond, out IntPtr found);",
    "  [PreserveSig] int FindFirstBuildCache(int scope, IntPtr cond, IntPtr cache, out ICbUia3Element found);",
    "  [PreserveSig] int FindAllBuildCache(int scope, IntPtr cond, IntPtr cache, out IntPtr found);",
    "  [PreserveSig] int BuildUpdatedCache(IntPtr cache, out ICbUia3Element updated);",
    "  [PreserveSig] int GetCurrentPropertyValue(int propId, out object retVal);",
    "  [PreserveSig] int GetCurrentPropertyValueEx(int propId, int ignoreDefault, out object retVal);",
    "  [PreserveSig] int GetCachedPropertyValue(int propId, out object retVal);",
    "  [PreserveSig] int GetCachedPropertyValueEx(int propId, int ignoreDefault, out object retVal);",
    "  [PreserveSig] int GetCurrentPatternAs(int patternId, ref Guid riid, out IntPtr patternObj);",
    "  [PreserveSig] int GetCachedPatternAs(int patternId, ref Guid riid, out IntPtr patternObj);",
    "  [PreserveSig] int GetCurrentPattern(int patternId, [MarshalAs(UnmanagedType.IUnknown)] out object patternObj);",
    "}",
    '[ComImport, Guid("828055ad-355b-4435-86d5-3b51c14a9b1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
    "public interface ICbLegacyIAccessiblePattern {",
    "  [PreserveSig] int Select(int flagsSelect);",
    "  [PreserveSig] int DoDefaultAction();",
    "  [PreserveSig] int SetValue([MarshalAs(UnmanagedType.LPWStr)] string val);",
    "  [PreserveSig] int get_CurrentChildId(out int retVal);",
    "  [PreserveSig] int get_CurrentName([MarshalAs(UnmanagedType.BStr)] out string retVal);",
    "  [PreserveSig] int get_CurrentValue([MarshalAs(UnmanagedType.BStr)] out string retVal);",
    "  [PreserveSig] int get_CurrentDescription([MarshalAs(UnmanagedType.BStr)] out string retVal);",
    "  [PreserveSig] int get_CurrentRole(out uint retVal);",
    "  [PreserveSig] int get_CurrentState(out uint retVal);",
    "  [PreserveSig] int get_CurrentHelp([MarshalAs(UnmanagedType.BStr)] out string retVal);",
    "  [PreserveSig] int get_CurrentKeyboardShortcut([MarshalAs(UnmanagedType.BStr)] out string retVal);",
    "  [PreserveSig] int GetCurrentSelection(out IntPtr retVal);",
    "  [PreserveSig] int get_CurrentDefaultAction([MarshalAs(UnmanagedType.BStr)] out string retVal);",
    "}",
    "public static class CBInput {",
    '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
    '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out CBPoint pt);',
    '  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);',
    '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    "  public static int[] CursorXY() { CBPoint pt; bool ok = GetCursorPos(out pt); return new int[] { ok ? 1 : 0, pt.X, pt.Y }; }",
    "}",
    "public static class CBWin {",
    "  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);",
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);',
    '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out CBRect lpRect);',
    '  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);',
    '  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);',
    '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    "  private const uint SMTO_ABORTIFHUNG = 0x0002;",
    "  private const uint PW_RENDERFULLCONTENT = 0x00000002;",
    "  private static ICbUia3 _uia3;",
    "  private static ICbUia3 GetUia3() {",
    "    if (_uia3 == null) {",
    '      var t = Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e"));',
    "      if (t != null) { _uia3 = Activator.CreateInstance(t) as ICbUia3; }",
    "    }",
    "    return _uia3;",
    "  }",
    "  public static string ReadWindowTitle(IntPtr hWnd) {",
    "    int len = GetWindowTextLength(hWnd);",
    "    if (len <= 0) return string.Empty;",
    "    var sb = new StringBuilder(len + 2);",
    "    GetWindowText(hWnd, sb, sb.Capacity);",
    "    return sb.ToString();",
    "  }",
    "  public static int GetPid(long hwnd) {",
    "    uint pid = 0;",
    "    GetWindowThreadProcessId(new IntPtr(hwnd), out pid);",
    "    return (int)pid;",
    "  }",
    "  public static bool ProbeResponsive(long hwnd, uint timeoutMs) {",
    "    IntPtr res;",
    "    IntPtr ret = SendMessageTimeout(new IntPtr(hwnd), 0u, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, timeoutMs, out res);",
    "    return ret != IntPtr.Zero;",
    "  }",
    "  public static CBWinEntry[] ListTopWindows() {",
    "    var list = new List<CBWinEntry>();",
    "    IntPtr fg = GetForegroundWindow();",
    "    EnumWindows((hWnd, lParam) => {",
    "      if (!IsWindowVisible(hWnd)) return true;",
    "      string title = ReadWindowTitle(hWnd);",
    "      if (string.IsNullOrWhiteSpace(title)) return true;",
    "      uint pid = 0;",
    "      GetWindowThreadProcessId(hWnd, out pid);",
    "      if (pid == 0) return true;",
    "      CBRect rc;",
    "      if (!GetWindowRect(hWnd, out rc)) return true;",
    "      list.Add(new CBWinEntry {",
    "        Hwnd = hWnd.ToInt64(),",
    "        Pid = (int)pid,",
    "        Title = title,",
    "        IsActive = (hWnd == fg),",
    "        IsMinimized = IsIconic(hWnd),",
    "        Left = rc.Left,",
    "        Top = rc.Top,",
    "        Width = Math.Max(0, rc.Right - rc.Left),",
    "        Height = Math.Max(0, rc.Bottom - rc.Top)",
    "      });",
    "      return true;",
    "    }, IntPtr.Zero);",
    "    return list.ToArray();",
    "  }",
    "  public static CBCaptureResult CaptureWindowPng(long hwnd, int maxWidth) {",
    "    var h = new IntPtr(hwnd);",
    "    CBRect rc;",
    '    if (!GetWindowRect(h, out rc)) return new CBCaptureResult { Ok = false, Error = "GetWindowRect failed" };',
    "    int winW = rc.Right - rc.Left;",
    "    int winH = rc.Bottom - rc.Top;",
    '    if (winW <= 0 || winH <= 0) return new CBCaptureResult { Ok = false, Error = "Invalid window dimensions" };',
    "    Bitmap rawBmp = null;",
    "    Bitmap scaledBmp = null;",
    "    try {",
    "      rawBmp = new Bitmap(winW, winH, PixelFormat.Format32bppArgb);",
    "      bool printed = false;",
    "      using (var g = Graphics.FromImage(rawBmp)) {",
    "        IntPtr hdc = g.GetHdc();",
    "        try {",
    "          printed = PrintWindow(h, hdc, PW_RENDERFULLCONTENT);",
    "          if (!printed) { printed = PrintWindow(h, hdc, 0u); }",
    "        } finally {",
    "          g.ReleaseHdc(hdc);",
    "        }",
    "      }",
    '      if (!printed) return new CBCaptureResult { Ok = false, Error = "PrintWindow failed" };',
    "      int targetW = winW;",
    "      int targetH = winH;",
    "      Bitmap outBmp = rawBmp;",
    "      if (maxWidth > 0 && winW > maxWidth) {",
    "        targetW = maxWidth;",
    "        targetH = Math.Max(1, (int)Math.Round((double)winH * ((double)maxWidth / (double)winW)));",
    "        scaledBmp = new Bitmap(targetW, targetH, PixelFormat.Format32bppArgb);",
    "        using (var sg = Graphics.FromImage(scaledBmp)) {",
    "          sg.InterpolationMode = InterpolationMode.HighQualityBicubic;",
    "          sg.SmoothingMode = SmoothingMode.HighQuality;",
    "          sg.PixelOffsetMode = PixelOffsetMode.HighQuality;",
    "          sg.DrawImage(rawBmp, 0, 0, targetW, targetH);",
    "        }",
    "        outBmp = scaledBmp;",
    "      }",
    "      using (var ms = new MemoryStream()) {",
    "        outBmp.Save(ms, ImageFormat.Png);",
    "        return new CBCaptureResult {",
    "          Ok = true,",
    "          WindowWidth = winW,",
    "          WindowHeight = winH,",
    "          Width = targetW,",
    "          Height = targetH,",
    "          Base64 = Convert.ToBase64String(ms.ToArray())",
    "        };",
    "      }",
    "    } finally {",
    "      if (scaledBmp != null) scaledBmp.Dispose();",
    "      if (rawBmp != null) rawBmp.Dispose();",
    "    }",
    "  }",
    "  private static bool RuntimeIdEquals(int[] a, int[] b) {",
    "    if (a == null || b == null || a.Length != b.Length) return false;",
    "    for (int i = 0; i < a.Length; i++) { if (a[i] != b[i]) return false; }",
    "    return true;",
    "  }",
    "  private static ICbUia3Element FindUia3ByRuntimeId(long winHwnd, int[] targetRid, int maxVisited) {",
    "    if (winHwnd == 0 || targetRid == null || targetRid.Length == 0) return null;",
    "    var uia = GetUia3();",
    "    if (uia == null) return null;",
    "    ICbUia3Element root;",
    "    if (uia.ElementFromHandle(new IntPtr(winHwnd), out root) != 0 || root == null) return null;",
    "    ICbUia3Walker walker;",
    "    if (uia.get_ControlViewWalker(out walker) != 0 || walker == null) return null;",
    "    var q = new Queue<ICbUia3Element>();",
    "    q.Enqueue(root);",
    "    int visited = 0;",
    "    while (q.Count > 0 && visited < maxVisited) {",
    "      var cur = q.Dequeue();",
    "      visited++;",
    "      int[] rid = null;",
    "      if (cur.GetRuntimeId(out rid) == 0 && RuntimeIdEquals(rid, targetRid)) return cur;",
    "      ICbUia3Element child = null;",
    "      if (walker.GetFirstChildElement(cur, out child) == 0 && child != null) {",
    "        while (child != null && (visited + q.Count) < maxVisited) {",
    "          q.Enqueue(child);",
    "          ICbUia3Element next = null;",
    "          if (walker.GetNextSiblingElement(child, out next) != 0) break;",
    "          child = next;",
    "        }",
    "      }",
    "    }",
    "    return null;",
    "  }",
    "  public static HashSet<string> CollectLegacyDefaultActionRuntimeIds(long winHwnd, int maxVisited) {",
    "    var result = new HashSet<string>(StringComparer.Ordinal);",
    "    if (winHwnd == 0 || maxVisited <= 0) return result;",
    "    try {",
    "      var uia = GetUia3();",
    "      if (uia == null) return result;",
    "      ICbUia3Element root;",
    "      if (uia.ElementFromHandle(new IntPtr(winHwnd), out root) != 0 || root == null) return result;",
    "      ICbUia3Walker walker;",
    "      if (uia.get_ControlViewWalker(out walker) != 0 || walker == null) return result;",
    "      var q = new Queue<ICbUia3Element>();",
    "      q.Enqueue(root);",
    "      int visited = 0;",
    "      while (q.Count > 0 && visited < maxVisited) {",
    "        var cur = q.Dequeue();",
    "        visited++;",
    "        try {",
    "          object patObj;",
    "          if (cur.GetCurrentPattern(10018, out patObj) == 0 && patObj != null) {",
    "            var leg = patObj as ICbLegacyIAccessiblePattern;",
    "            if (leg != null) {",
    "              string defAct = null;",
    "              if (leg.get_CurrentDefaultAction(out defAct) == 0 && !string.IsNullOrEmpty(defAct)) {",
    "                int[] rid = null;",
    "                if (cur.GetRuntimeId(out rid) == 0 && rid != null && rid.Length > 0) {",
    "                  result.Add(string.Join(\".\", rid));",
    "                }",
    "              }",
    "            }",
    "          }",
    "        } catch {}",
    "        ICbUia3Element child = null;",
    "        if (walker.GetFirstChildElement(cur, out child) == 0 && child != null) {",
    "          while (child != null && (visited + q.Count) < maxVisited) {",
    "            q.Enqueue(child);",
    "            ICbUia3Element next = null;",
    "            if (walker.GetNextSiblingElement(child, out next) != 0) break;",
    "            child = next;",
    "          }",
    "        }",
    "      }",
    "    } catch {}",
    "    return result;",
    "  }",
    "  public static bool HasLegacyDefaultAction(long winHwnd, int[] targetRid, long elemHwnd) {",
    "    try {",
    "      var uia = GetUia3();",
    "      if (uia == null) return false;",
    "      ICbUia3Element el = null;",
    "      if (elemHwnd != 0) { uia.ElementFromHandle(new IntPtr(elemHwnd), out el); }",
    "      if (el == null && winHwnd != 0 && targetRid != null && targetRid.Length > 0) { el = FindUia3ByRuntimeId(winHwnd, targetRid, 800); }",
    "      if (el == null) return false;",
    "      object patObj;",
    "      if (el.GetCurrentPattern(10018, out patObj) != 0 || patObj == null) return false;",
    "      var leg = patObj as ICbLegacyIAccessiblePattern;",
    "      if (leg == null) return false;",
    "      string defAct = null;",
    "      if (leg.get_CurrentDefaultAction(out defAct) == 0 && !string.IsNullOrEmpty(defAct)) return true;",
    "      return false;",
    "    } catch { return false; }",
    "  }",
    "  public static bool TryLegacyDefaultAction(long winHwnd, int[] targetRid, long elemHwnd) {",
    "    try {",
    "      var uia = GetUia3();",
    "      if (uia == null) return false;",
    "      ICbUia3Element el = null;",
    "      if (elemHwnd != 0) { uia.ElementFromHandle(new IntPtr(elemHwnd), out el); }",
    "      if (el == null) { el = FindUia3ByRuntimeId(winHwnd, targetRid, 2500); }",
    "      if (el == null) return false;",
    "      object patObj;",
    "      if (el.GetCurrentPattern(10018, out patObj) != 0 || patObj == null) return false;",
    "      var leg = patObj as ICbLegacyIAccessiblePattern;",
    "      if (leg == null) return false;",
    "      string defAct = null;",
    "      if (leg.get_CurrentDefaultAction(out defAct) != 0 || string.IsNullOrEmpty(defAct)) return false;",
    "      return leg.DoDefaultAction() == 0;",
    "    } catch { return false; }",
    "  }",
    "}",
    '"@ | Out-Null',
    "}",
    "[CBInput]::SetProcessDPIAware() | Out-Null",
    "$cbWsh = $null",
    "$cbSelfProcBlacklist = @('chisabot', 'chisabot-pc', 'cn.ayase.chisabot.pc')",
    "$cbGhostTitles = @('program manager', 'windows input experience')",
    "$cbInteractiveRoles = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)",
    "foreach ($rName in @('button','checkbox','combobox','edit','hyperlink','link','listitem','menu','menubar','menuitem','radiobutton','scrollbar','slider','spinner','splitbutton','tab','tabitem','thumb','treeitem','datagrid','dataitem','table','document','textfield','switch','option','listbox')) { [void]$cbInteractiveRoles.Add($rName) }",
    "$cbExecPatterns = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)",
    "foreach ($pName in @('invoke','legacy_default','value','range_value','toggle','selection_item','expand_collapse','scroll','scroll_item')) { [void]$cbExecPatterns.Add($pName) }",
    "$cbShellRoles = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)",
    "foreach ($sName in @('pane','group','custom','image','separator','toolbar','header','window')) { [void]$cbShellRoles.Add($sName) }",
    "function Write-CbJson([hashtable]$obj) {",
    "  $json = ConvertTo-Json -InputObject $obj -Depth 10 -Compress",
    `  [Console]::Out.WriteLine('${RESPONSE_PREFIX}' + $json)`,
    "  [Console]::Out.Flush()",
    "}",
    "function Normalize-CbProcName([string]$name) {",
    "  if (-not $name) { return '' }",
    "  $n = $name.Trim()",
    "  $sep = [Math]::Max($n.LastIndexOf('\\'), $n.LastIndexOf('/'))",
    "  if ($sep -ge 0) { $n = $n.Substring($sep + 1) }",
    "  $n = $n.Trim().ToLowerInvariant()",
    "  if ($n.EndsWith('.exe')) { $n = $n.Substring(0, $n.Length - 4) }",
    "  return $n",
    "}",
    "function Test-CbSelfTarget([int]$procId, [string]$procName, [string]$title, [int]$excludePid, $excludeNames) {",
    "  if ($excludePid -gt 0 -and $procId -eq $excludePid) { return $true }",
    "  $norm = Normalize-CbProcName $procName",
    "  if ($norm) {",
    "    if ($script:cbSelfProcBlacklist -contains $norm) { return $true }",
    "    if ($null -ne $excludeNames) {",
    "      foreach ($ex in @($excludeNames)) {",
    "        if ((Normalize-CbProcName ([string]$ex)) -eq $norm) { return $true }",
    "      }",
    "    }",
    "  }",
    "  if ($title) {",
    "    if ($title.IndexOf('ChisaBot 审批', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or $title.IndexOf('ChisaBot 确认', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }",
    "  }",
    "  return $false",
    "}",
    "function Get-CbProcMeta([int]$procId) {",
    "  $pname = ''",
    "  $ticks = ''",
    "  if ($procId -gt 0) {",
    "    try {",
    "      $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue",
    "      if ($null -ne $proc) {",
    "        $pname = [string]$proc.ProcessName",
    "        try { $ticks = [string]$proc.StartTime.ToFileTimeUtc() } catch { $ticks = '' }",
    "      }",
    "    } catch {}",
    "  }",
    "  return @{ processName = $pname; processStartTicks = $ticks }",
    "}",
    "function Get-CbRoleName($el) {",
    "  try {",
    "    $raw = [string]$el.Current.ControlType.ProgrammaticName",
    "    if ($raw.StartsWith('ControlType.', [System.StringComparison]::OrdinalIgnoreCase)) { $raw = $raw.Substring(12) }",
    "    return $raw.ToLowerInvariant()",
    "  } catch { return '' }",
    "}",
    "function Get-CbRuntimeIdStr($el) {",
    "  try {",
    "    $rid = $el.GetRuntimeId()",
    "    if ($null -ne $rid -and $rid.Length -gt 0) { return ($rid -join '.') }",
    "  } catch {}",
    "  return ''",
    "}",
    "function Invoke-CbLegacyDefaultAction($winEl, $el) {",
    "  try {",
    "    $legacyType = 'System.Windows.Automation.LegacyIAccessiblePattern' -as [type]",
    "    if ($null -ne $legacyType) {",
    "      $lp = $null",
    "      if ($el.TryGetCurrentPattern($legacyType::Pattern, [ref]$lp) -and $null -ne $lp) {",
    "        $lp.DoDefaultAction()",
    "        return $true",
    "      }",
    "    }",
    "  } catch {}",
    "  try {",
    "    $winHwnd = 0L",
    "    try { $winHwnd = [long]$winEl.Current.NativeWindowHandle } catch {}",
    "    $elemHwnd = 0L",
    "    try { $elemHwnd = [long]$el.Current.NativeWindowHandle } catch {}",
    "    $rid = $null",
    "    try { $rid = [int[]]$el.GetRuntimeId() } catch {}",
    "    if ([CBWin]::TryLegacyDefaultAction($winHwnd, $rid, $elemHwnd)) { return $true }",
    "  } catch {}",
    "  return $false",
    "}",
    "function Resolve-CbWindowHandle($p) {",
    "  $reqHwnd = if ($null -ne $p.hwnd) { [long]$p.hwnd } else { 0L }",
    "  if ($reqHwnd -gt 0) {",
    "    if ([CBWin]::IsWindow([IntPtr]$reqHwnd)) { return $reqHwnd }",
    "    return 0L",
    "  }",
    "  $reqPid = if ($null -ne $p.pid) { [int]$p.pid } else { 0 }",
    "  $reqProc = Normalize-CbProcName ([string]$(if ($null -ne $p.bundleId) { $p.bundleId } elseif ($null -ne $p.processName) { $p.processName } else { '' }))",
    "  $reqTitle = if ($null -ne $p.title) { [string]$p.title } else { '' }",
    "  $excludePid = if ($null -ne $p.excludePid) { [int]$p.excludePid } else { 0 }",
    "  $wins = [CBWin]::ListTopWindows()",
    "  foreach ($w in $wins) {",
    "    $meta = Get-CbProcMeta $w.Pid",
    "    $wProc = Normalize-CbProcName $meta.processName",
    "    if ($reqPid -gt 0 -and $w.Pid -ne $reqPid) { continue }",
    "    if ($reqProc -and $wProc -ne $reqProc) { continue }",
    "    if ($reqTitle -and $w.Title.IndexOf($reqTitle, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }",
    "    if ($excludePid -gt 0 -and $w.Pid -eq $excludePid -and $reqPid -le 0 -and (-not $reqProc) -and (-not $reqTitle)) { continue }",
    "    return [long]$w.Hwnd",
    "  }",
    "  return 0L",
    "}",
    "function Find-TargetWindow([string]$targetName) {",
    "  $procs = @(Get-Process -Name $targetName -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName.Equals($targetName, [System.StringComparison]::OrdinalIgnoreCase) })",
    "  if ($procs.Count -eq 0) { return $null }",
    "  $pids = New-Object 'System.Collections.Generic.HashSet[int]'",
    "  foreach ($p in $procs) { [void]$pids.Add([int]$p.Id) }",
    "  $root = [System.Windows.Automation.AutomationElement]::RootElement",
    "  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker",
    "  $w = $walker.GetFirstChild($root)",
    "  while ($null -ne $w) {",
    "    try {",
    "      if ($pids.Contains([int]$w.Current.ProcessId)) { return $w }",
    "    } catch {}",
    "    $w = $walker.GetNextSibling($w)",
    "  }",
    "  return $null",
    "}",
    "function Invoke-CbInput($p) {",
    "  $act = [string]$p.action",
    "  $hasPoint = ($null -ne $p.x) -and ($null -ne $p.y)",
    "  if ($hasPoint) {",
    "    [CBInput]::SetCursorPos([int]$p.x, [int]$p.y) | Out-Null",
    "    Start-Sleep -Milliseconds 30",
    "  }",
    "  switch ($act) {",
    "    'move' {",
    "      if (-not $hasPoint) { throw 'move 需要 x 和 y。' }",
    "      return @{ done = $true; action = 'move' }",
    "    }",
    "    'click' {",
    "      [CBInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)",
    "      [CBInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)",
    "      return @{ done = $true; action = 'click' }",
    "    }",
    "    'double_click' {",
    "      [CBInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)",
    "      [CBInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)",
    "      Start-Sleep -Milliseconds 60",
    "      [CBInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)",
    "      [CBInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)",
    "      return @{ done = $true; action = 'double_click' }",
    "    }",
    "    'right_click' {",
    "      [CBInput]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)",
    "      [CBInput]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)",
    "      return @{ done = $true; action = 'right_click' }",
    "    }",
    "    'scroll' {",
    "      $amt = if ($null -ne $p.amount) { [int]$p.amount } else { -3 }",
    "      [CBInput]::mouse_event(0x0800, 0, 0, ($amt * 120), [UIntPtr]::Zero)",
    "      return @{ done = $true; action = 'scroll' }",
    "    }",
    "    'type' {",
    "      $txt = [string]$p.sendKeysText",
    "      if ($txt.Length -gt 0) { [System.Windows.Forms.SendKeys]::SendWait($txt) }",
    "      return @{ done = $true; action = 'type' }",
    "    }",
    "    'key' {",
    "      $keys = [string]$p.keys",
    "      if (-not $keys) { throw 'key 需要 keys。' }",
    "      [System.Windows.Forms.SendKeys]::SendWait($keys)",
    "      return @{ done = $true; action = 'key' }",
    "    }",
    "    'focus' {",
    "      $target = [string]$p.target",
    "      if (-not $target) { throw 'focus 需要目标窗口。' }",
    "      if ($null -eq $script:cbWsh) { $script:cbWsh = New-Object -ComObject WScript.Shell }",
    "      if (-not $script:cbWsh.AppActivate($target)) {",
    "        $proc = Get-Process | Where-Object { $_.ProcessName.Equals($target, [System.StringComparison]::OrdinalIgnoreCase) -or ($_.MainWindowTitle -and $_.MainWindowTitle.IndexOf($target, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) } | Select-Object -First 1",
    "        if (-not $proc) { throw '未找到目标窗口' }",
    "        $script:cbWsh.AppActivate($proc.Id) | Out-Null",
    "      }",
    "      return @{ done = $true; action = 'focus' }",
    "    }",
    "    default { throw ('不支持的输入动作：' + $act) }",
    "  }",
    "}",
    "function Invoke-CbUiaRead($p) {",
    "  $target = [string]$p.bundleId",
    "  $limit = if ($null -ne $p.maxNodes) { [Math]::Min(200, [Math]::Max(10, [int]$p.maxNodes)) } else { 80 }",
    "  $maxDepth = if ($null -ne $p.maxDepth) { [Math]::Min(30, [Math]::Max(2, [int]$p.maxDepth)) } else { 12 }",
    "  $maxVisited = [Math]::Min(2000, [Math]::Max($limit * 8, 600))",
    "  $picked = Find-TargetWindow $target",
    "  if (-not $picked) { return @{ found = $false; nodes = @() } }",
    "  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker",
    "  $queue = New-Object 'System.Collections.Generic.Queue[object]'",
    "  $nodes = New-Object 'System.Collections.Generic.List[object]'",
    "  $queue.Enqueue(@{ el = $picked; depth = 0 })",
    "  $visited = 0",
    "  while ($queue.Count -gt 0 -and $nodes.Count -lt $limit -and $visited -lt $maxVisited) {",
    "    $item = $queue.Dequeue()",
    "    $el = $item.el",
    "    $depth = [int]$item.depth",
    "    $visited++",
    "    if ($depth -gt 0) {",
    "      try {",
    "        $cur = $el.Current",
    "        $nm = $cur.Name",
    "        $aid = $cur.AutomationId",
    "        if ($nm -or $aid) {",
    "          $r = $cur.BoundingRectangle",
    "          $rx = if ([double]::IsInfinity($r.X) -or [double]::IsNaN($r.X)) { 0 } else { [int]$r.X }",
    "          $ry = if ([double]::IsInfinity($r.Y) -or [double]::IsNaN($r.Y)) { 0 } else { [int]$r.Y }",
    "          $rw = if ([double]::IsInfinity($r.Width) -or [double]::IsNaN($r.Width)) { 0 } else { [int]$r.Width }",
    "          $rh = if ([double]::IsInfinity($r.Height) -or [double]::IsNaN($r.Height)) { 0 } else { [int]$r.Height }",
    "          $nodes.Add(@{ name = $nm; role = $cur.ControlType.ProgrammaticName; automationId = $aid; enabled = [bool]$cur.IsEnabled; focused = [bool]$cur.HasKeyboardFocus; bounds = @{ x = $rx; y = $ry; width = $rw; height = $rh } })",
    "          if ($nodes.Count -ge $limit) { break }",
    "        }",
    "      } catch {}",
    "    }",
    "    if ($depth -lt $maxDepth) {",
    "      try {",
    "        $child = $walker.GetFirstChild($el)",
    "        while ($null -ne $child -and ($visited + $queue.Count) -lt $maxVisited) {",
    "          $queue.Enqueue(@{ el = $child; depth = ($depth + 1) })",
    "          $child = $walker.GetNextSibling($child)",
    "        }",
    "      } catch {}",
    "    }",
    "  }",
    "  $winTitle = ''",
    "  try { $winTitle = [string]$picked.Current.Name } catch {}",
    "  return @{ found = $true; windowTitle = $winTitle; nodes = $nodes.ToArray(); visited = $visited }",
    "}",
    "function Invoke-CbUiaAction($p) {",
    "  $target = [string]$p.bundleId",
    "  $act = [string]$p.action",
    "  if ($act -ne 'click' -and $act -ne 'focus' -and $act -ne 'set_value') { throw ('不支持的语义操作：' + $act) }",
    "  $matchId = if ($null -ne $p.automationId) { [string]$p.automationId } else { '' }",
    "  $matchName = if ($null -ne $p.name) { [string]$p.name } else { '' }",
    "  $val = if ($null -ne $p.value) { [string]$p.value } else { '' }",
    "  $picked = Find-TargetWindow $target",
    "  if (-not $picked) { throw '未找到目标应用窗口' }",
    "  $el = $null",
    "  if ($matchId) {",
    "    $condId = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $matchId)",
    "    $el = $picked.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condId)",
    "  }",
    "  if (-not $el -and $matchName) {",
    "    $condName = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $matchName)",
    "    $el = $picked.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condName)",
    "  }",
    "  if (-not $el) { throw '未找到匹配的语义控件' }",
    "  if ($act -eq 'focus') { $el.SetFocus() }",
    "  elseif ($act -eq 'set_value') {",
    "    $vp = $null",
    "    if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { throw 'ACTION_NOT_SUPPORTED: 该控件不支持 ValuePattern' }",
    "    $vp.SetValue($val)",
    "  }",
    "  else {",
    "    $ip = $null",
    "    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { $ip.Invoke() }",
    "    elseif (Invoke-CbLegacyDefaultAction $picked $el) { }",
    "    else { throw 'ACTION_NOT_SUPPORTED: 该控件不支持无焦点 click（缺少 InvokePattern 与 LegacyIAccessiblePattern.DoDefaultAction）' }",
    "  }",
    "  $matchedName = ''",
    "  try { $matchedName = [string]$el.Current.Name } catch {}",
    "  return @{ ok = $true; action = $act; matched = $matchedName }",
    "}",
    "function Invoke-CbWinList($p) {",
    "  $query = if ($null -ne $p.query) { [string]$p.query } else { '' }",
    "  $excludePid = if ($null -ne $p.excludePid) { [int]$p.excludePid } else { 0 }",
    "  $excludeNames = $p.excludeProcessNames",
    "  $rawWins = [CBWin]::ListTopWindows()",
    "  $procCache = @{}",
    "  $out = New-Object 'System.Collections.Generic.List[object]'",
    "  foreach ($w in $rawWins) {",
    "    if (-not $w.Title -or -not $w.Title.Trim()) { continue }",
    "    $titleLower = $w.Title.Trim().ToLowerInvariant()",
    "    if ($script:cbGhostTitles -contains $titleLower) { continue }",
    "    if (-not $w.IsMinimized -and ($w.Width -le 10 -or $w.Height -le 10)) { continue }",
    "    $pidKey = [int]$w.Pid",
    "    if (-not $procCache.ContainsKey($pidKey)) { $procCache[$pidKey] = Get-CbProcMeta $pidKey }",
    "    $meta = $procCache[$pidKey]",
    "    $procName = [string]$meta.processName",
    "    if (Test-CbSelfTarget $pidKey $procName $w.Title $excludePid $excludeNames) { continue }",
    "    if ($query) {",
    "      $matchTitle = $w.Title.IndexOf($query, [System.StringComparison]::OrdinalIgnoreCase) -ge 0",
    "      $matchProc = $procName -and ($procName.IndexOf($query, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)",
    "      if (-not $matchTitle -and -not $matchProc) { continue }",
    "    }",
    "    $out.Add(@{",
    "      hwnd = [long]$w.Hwnd;",
    "      pid = $pidKey;",
    "      processStartTicks = [string]$meta.processStartTicks;",
    "      processName = $procName;",
    "      title = [string]$w.Title;",
    "      isActive = [bool]$w.IsActive;",
    "      isMinimized = [bool]$w.IsMinimized;",
    "      bounds = @{ left = [int]$w.Left; top = [int]$w.Top; width = [int]$w.Width; height = [int]$w.Height }",
    "    })",
    "  }",
    "  return @{ windows = $out.ToArray() }",
    "}",
    "function Invoke-CbWinCapture($p) {",
    "  $excludePid = if ($null -ne $p.excludePid) { [int]$p.excludePid } else { 0 }",
    "  $hwnd = Resolve-CbWindowHandle $p",
    "  if ($hwnd -le 0 -or -not [CBWin]::IsWindow([IntPtr]$hwnd)) {",
    "    return @{ ok = $false; code = 'WINDOW_NOT_FOUND'; error = '未找到目标窗口。' }",
    "  }",
    "  $prePid = [CBWin]::GetPid($hwnd)",
    "  $preTitle = [CBWin]::ReadWindowTitle([IntPtr]$hwnd)",
    "  $preMeta = Get-CbProcMeta $prePid",
    "  if (Test-CbSelfTarget $prePid $preMeta.processName $preTitle $excludePid $p.excludeProcessNames) {",
    "    return @{ ok = $false; code = 'SELF_TARGET_FORBIDDEN'; error = '禁止截取 ChisaBot 自身窗口。' }",
    "  }",
    "  $expectedPid = if ($null -ne $p.pid) { [int]$p.pid } else { 0 }",
    "  $expectedTicks = if ($null -ne $p.processStartTicks) { [string]$p.processStartTicks } else { '' }",
    "  if ($expectedPid -gt 0 -and $prePid -ne $expectedPid) {",
    "    return @{ ok = $false; code = 'STALE_REF'; error = '目标窗口 PID 已变更。' }",
    "  }",
    "  if ($expectedTicks -and $preMeta.processStartTicks -ne $expectedTicks) {",
    "    return @{ ok = $false; code = 'STALE_REF'; error = '目标窗口进程启动令牌已变更。' }",
    "  }",
    "  if ([CBWin]::IsIconic([IntPtr]$hwnd)) {",
    "    return @{ ok = $false; code = 'WINDOW_MINIMIZED'; error = '目标窗口已最小化，无法后台截取画面。' }",
    "  }",
    "  if (-not [CBWin]::ProbeResponsive($hwnd, 500)) {",
    "    return @{ ok = $false; code = 'TIMEOUT'; error = '目标窗口无响应，已中止截图防死锁。' }",
    "  }",
    "  $maxWidth = if ($null -ne $p.maxWidth) { [Math]::Min(3840, [Math]::Max(320, [int]$p.maxWidth)) } else { 1600 }",
    "  $cap = [CBWin]::CaptureWindowPng($hwnd, $maxWidth)",
    "  if (-not $cap -or -not $cap.Ok) {",
    "    $errMsg = if ($cap -and $cap.Error) { '后台窗口截屏失败：' + $cap.Error } else { '后台窗口截屏失败。' }",
    "    return @{ ok = $false; code = 'ACTION_NOT_SUPPORTED'; error = $errMsg }",
    "  }",
    "  if (-not [CBWin]::IsWindow([IntPtr]$hwnd)) {",
    "    return @{ ok = $false; code = 'STALE_REF'; error = '截屏期间目标窗口已关闭。' }",
    "  }",
    "  $postPid = [CBWin]::GetPid($hwnd)",
    "  $postMeta = Get-CbProcMeta $postPid",
    "  if ($postPid -ne $prePid -or ($preMeta.processStartTicks -and $postMeta.processStartTicks -ne $preMeta.processStartTicks)) {",
    "    return @{ ok = $false; code = 'STALE_REF'; error = '截屏期间目标窗口句柄已归属其他进程。' }",
    "  }",
    "  if ($expectedPid -gt 0 -and $postPid -ne $expectedPid) {",
    "    return @{ ok = $false; code = 'STALE_REF'; error = '截屏后目标窗口 PID 校验不一致。' }",
    "  }",
    "  if ($expectedTicks -and $postMeta.processStartTicks -ne $expectedTicks) {",
    "    return @{ ok = $false; code = 'STALE_REF'; error = '截屏后目标窗口进程代际校验不一致。' }",
    "  }",
    "  return @{",
    "    ok = $true;",
    "    format = 'png';",
    "    hwnd = [long]$hwnd;",
    "    pid = [int]$prePid;",
    "    processStartTicks = [string]$preMeta.processStartTicks;",
    "    processName = [string]$preMeta.processName;",
    "    title = [string]$preTitle;",
    "    windowWidth = [int]$cap.WindowWidth;",
    "    windowHeight = [int]$cap.WindowHeight;",
    "    width = [int]$cap.Width;",
    "    height = [int]$cap.Height;",
    "    base64 = [string]$cap.Base64",
    "  }",
    "}",
    "function Invoke-CbUiaSnapshot($p) {",
    "  $excludePid = if ($null -ne $p.excludePid) { [int]$p.excludePid } else { 0 }",
    "  $hwnd = Resolve-CbWindowHandle $p",
    "  if ($hwnd -le 0 -or -not [CBWin]::IsWindow([IntPtr]$hwnd)) {",
    "    return @{ ok = $false; found = $false; code = 'WINDOW_NOT_FOUND'; error = '未找到目标窗口。' }",
    "  }",
    "  $winPid = [CBWin]::GetPid($hwnd)",
    "  $winTitle = [CBWin]::ReadWindowTitle([IntPtr]$hwnd)",
    "  $winMeta = Get-CbProcMeta $winPid",
    "  if (Test-CbSelfTarget $winPid $winMeta.processName $winTitle $excludePid $p.excludeProcessNames) {",
    "    return @{ ok = $false; found = $false; code = 'SELF_TARGET_FORBIDDEN'; error = '禁止读取 ChisaBot 自身窗口控件树。' }",
    "  }",
    "  if ([CBWin]::IsIconic([IntPtr]$hwnd)) {",
    "    return @{ ok = $false; found = $false; code = 'WINDOW_MINIMIZED'; error = '目标窗口已最小化，无法后台读取控件树。' }",
    "  }",
    "  $picked = $null",
    "  try { $picked = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd) } catch {}",
    "  if ($null -eq $picked) {",
    "    return @{ ok = $false; found = $false; code = 'WINDOW_NOT_FOUND'; error = '无法获取目标窗口的 UIA 根元素。' }",
    "  }",
    "  $maxNodes = if ($null -ne $p.maxNodes) { [Math]::Min(300, [Math]::Max(10, [int]$p.maxNodes)) } else { 150 }",
    "  $maxDepth = if ($null -ne $p.maxDepth) { [Math]::Min(30, [Math]::Max(2, [int]$p.maxDepth)) } else { 14 }",
    "  $interactiveOnly = [bool]$p.interactiveOnly",
    "  $compact = [bool]$p.compact",
    "  $maxVisited = [Math]::Min(4000, [Math]::Max($maxNodes * 16, 1200))",
    "  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker",
    "  $queue = New-Object 'System.Collections.Generic.Queue[object]'",
    "  $collected = New-Object 'System.Collections.Generic.List[object]'",
    "  $idCounts = @{}",
    "  $queue.Enqueue(@{ el = $picked; depth = 0 })",
    "  $visited = 0",
    "  $hitNodeLimit = $false",
    "  $legacyRidSet = $null",
    "  $legacyHwndBudget = 64",
    "  while ($queue.Count -gt 0 -and $visited -lt $maxVisited) {",
    "    $item = $queue.Dequeue()",
    "    $el = $item.el",
    "    $depth = [int]$item.depth",
    "    $visited++",
    "    $childCount = 0",
    "    if ($depth -lt $maxDepth) {",
    "      try {",
    "        $child = $walker.GetFirstChild($el)",
    "        while ($null -ne $child) {",
    "          $childCount++",
    "          if (($visited + $queue.Count) -lt $maxVisited) {",
    "            $queue.Enqueue(@{ el = $child; depth = ($depth + 1) })",
    "          }",
    "          $child = $walker.GetNextSibling($child)",
    "        }",
    "      } catch {}",
    "    } else {",
    "      try {",
    "        $child = $walker.GetFirstChild($el)",
    "        while ($null -ne $child -and $childCount -lt 64) {",
    "          $childCount++",
    "          $child = $walker.GetNextSibling($child)",
    "        }",
    "      } catch {}",
    "    }",
    "    if ($depth -gt 0) {",
    "      try {",
    "        $cur = $el.Current",
    "        $role = Get-CbRoleName $el",
    "        $nm = if ($null -ne $cur.Name) { [string]$cur.Name } else { '' }",
    "        $aid = if ($null -ne $cur.AutomationId) { [string]$cur.AutomationId } else { '' }",
    "        $desc = if ($null -ne $cur.HelpText) { [string]$cur.HelpText } else { '' }",
    "        $isPwd = [bool]$cur.IsPassword",
    "        $idKey = $role + [char]31 + $aid + [char]31 + $nm + [char]31 + $desc",
    "        if ($idCounts.ContainsKey($idKey)) { $idCounts[$idKey] = [int]$idCounts[$idKey] + 1 } else { $idCounts[$idKey] = 1 }",
    "        if ($collected.Count -ge $maxNodes) { $hitNodeLimit = $true; continue }",
    "        $pats = New-Object 'System.Collections.Generic.List[string]'",
    "        $val = $null",
    "        $checked = $null",
    "        $expanded = $null",
    "        $selected = $null",
    "        $tmpPat = $null",
    "        if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$tmpPat)) { [void]$pats.Add('invoke') }",
    "        $tmpPat = $null",
    "        if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$tmpPat)) {",
    "          [void]$pats.Add('value')",
    "          if (-not $isPwd) { try { $val = [string]$tmpPat.Current.Value } catch {} }",
    "        }",
    "        $tmpPat = $null",
    "        if ($el.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$tmpPat)) {",
    "          [void]$pats.Add('range_value')",
    "          if (-not $isPwd -and $null -eq $val) { try { $val = [double]$tmpPat.Current.Value } catch {} }",
    "        }",
    "        $tmpPat = $null",
    "        if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tmpPat)) {",
    "          [void]$pats.Add('toggle')",
    "          try {",
    "            $ts = $tmpPat.Current.ToggleState.ToString()",
    "            if ($ts -eq 'On') { $checked = $true } elseif ($ts -eq 'Off') { $checked = $false } else { $checked = 'mixed' }",
    "          } catch {}",
    "        }",
    "        $tmpPat = $null",
    "        if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$tmpPat)) {",
    "          [void]$pats.Add('selection_item')",
    "          try { $selected = [bool]$tmpPat.Current.IsSelected } catch {}",
    "        }",
    "        $tmpPat = $null",
    "        if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$tmpPat)) {",
    "          [void]$pats.Add('expand_collapse')",
    "          try {",
    "            $ecs = $tmpPat.Current.ExpandCollapseState.ToString()",
    "            if ($ecs -eq 'Expanded' -or $ecs -eq 'PartiallyExpanded') { $expanded = $true } elseif ($ecs -eq 'Collapsed') { $expanded = $false }",
    "          } catch {}",
    "        }",
    "        $tmpPat = $null",
    "        if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$tmpPat)) { [void]$pats.Add('scroll') }",
    "        $tmpPat = $null",
    "        if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$tmpPat)) { [void]$pats.Add('scroll_item') }",
    "        $tmpPat = $null",
    "        if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tmpPat)) { [void]$pats.Add('text') }",
    "        $elHwnd = 0L",
    "        try { $elHwnd = [long]$cur.NativeWindowHandle } catch {}",
    "        $elRidArr = $null",
    "        $ridStr = ''",
    "        try { $elRidArr = [int[]]$el.GetRuntimeId(); if ($null -ne $elRidArr -and $elRidArr.Length -gt 0) { $ridStr = ($elRidArr -join '.') } } catch {}",
    "        if (-not $pats.Contains('invoke') -and ($elHwnd -ne 0 -or $script:cbInteractiveRoles.Contains($role))) {",
    "          if ($elHwnd -ne 0) {",
    "            if ($legacyHwndBudget -gt 0) {",
    "              $legacyHwndBudget--",
    "              if ([CBWin]::HasLegacyDefaultAction(0, $null, $elHwnd)) { [void]$pats.Add('legacy_default') }",
    "            }",
    "          } elseif ($ridStr) {",
    "            if ($null -eq $legacyRidSet) {",
    "              $legacyRidSet = [CBWin]::CollectLegacyDefaultActionRuntimeIds($hwnd, [Math]::Min(800, $maxVisited))",
    "            }",
    "            if ($null -ne $legacyRidSet -and $legacyRidSet.Contains($ridStr)) { [void]$pats.Add('legacy_default') }",
    "          }",
    "        }",
    "        $hasExecPat = $false",
    "        foreach ($pn in $pats) { if ($script:cbExecPatterns.Contains($pn)) { $hasExecPat = $true; break } }",
    "        $isInteractive = $script:cbInteractiveRoles.Contains($role) -or $hasExecPat",
    "        $isAnonLayout = $script:cbShellRoles.Contains($role) -and (-not $nm) -and (-not $aid) -and (-not $desc) -and (-not $hasExecPat)",
    "        if ($interactiveOnly -and ((-not $isInteractive) -or $isAnonLayout)) { continue }",
    "        if ($compact -and $isAnonLayout -and ($null -eq $val)) { continue }",
    "        if ($isPwd) { $val = $null }",
    "        $r = $cur.BoundingRectangle",
    "        $rx = if ([double]::IsInfinity($r.X) -or [double]::IsNaN($r.X)) { 0 } else { [int]$r.X }",
    "        $ry = if ([double]::IsInfinity($r.Y) -or [double]::IsNaN($r.Y)) { 0 } else { [int]$r.Y }",
    "        $rw = if ([double]::IsInfinity($r.Width) -or [double]::IsNaN($r.Width)) { 0 } else { [int]$r.Width }",
    "        $rh = if ([double]::IsInfinity($r.Height) -or [double]::IsNaN($r.Height)) { 0 } else { [int]$r.Height }",
    "        $collected.Add(@{",
    "          _idKey = $idKey;",
    "          role = $role;",
    "          name = $nm;",
    "          automationId = $aid;",
    "          description = $desc;",
    "          isPassword = $isPwd;",
    "          value = $val;",
    "          enabled = [bool]$cur.IsEnabled;",
    "          focused = [bool]$cur.HasKeyboardFocus;",
    "          isOffscreen = [bool]$cur.IsOffscreen;",
    "          checked = $checked;",
    "          expanded = $expanded;",
    "          selected = $selected;",
    "          patterns = $pats.ToArray();",
    "          runtimeId = $ridStr;",
    "          depth = $depth;",
    "          childrenCount = $childCount;",
    "          bounds = @{ x = $rx; y = $ry; width = $rw; height = $rh }",
    "        })",
    "      } catch {}",
    "    }",
    "  }",
    "  $finalNodes = New-Object 'System.Collections.Generic.List[object]'",
    "  foreach ($n in $collected) {",
    "    $k = [string]$n._idKey",
    "    $uniq = ($idCounts.ContainsKey($k) -and ([int]$idCounts[$k] -eq 1))",
    "    $n.Remove('_idKey')",
    "    $n['uniqueAtCapture'] = $uniq",
    "    $finalNodes.Add($n)",
    "  }",
    "  $truncated = ($queue.Count -gt 0) -or $hitNodeLimit",
    "  return @{",
    "    ok = $true;",
    "    found = $true;",
    "    window = @{",
    "      hwnd = [long]$hwnd;",
    "      pid = [int]$winPid;",
    "      processStartTicks = [string]$winMeta.processStartTicks;",
    "      processName = [string]$winMeta.processName;",
    "      title = [string]$winTitle",
    "    };",
    "    nodes = $finalNodes.ToArray();",
    "    totalVisited = [int]$visited;",
    "    truncated = [bool]$truncated",
    "  }",
    "}",
    "function Invoke-CbUiaAct($p) {",
    "  $act = if ($null -ne $p.action) { ([string]$p.action).Trim().ToLowerInvariant() } else { '' }",
    "  $excludePid = if ($null -ne $p.excludePid) { [int]$p.excludePid } else { 0 }",
    "  $reqPid = if ($null -ne $p.pid) { [int]$p.pid } else { 0 }",
    "  if ($excludePid -gt 0 -and $reqPid -gt 0 -and $reqPid -eq $excludePid) {",
    "    return @{ ok = $false; code = 'SELF_TARGET_FORBIDDEN'; error = '禁止后台操控 ChisaBot 自身进程。' }",
    "  }",
    "  if ($act -eq 'type') {",
    "    return @{ ok = $false; code = 'POLICY_DENIED'; error = 'Windows 后台无障碍模式不支持光标处 type，请改用 set_value，或显式请求前台 device_input。' }",
    "  }",
    "  if ($act -eq 'focus') {",
    "    return @{ ok = $false; code = 'POLICY_DENIED'; error = '后台操控禁止抢占前景焦点。' }",
    "  }",
    "  $supportedActs = @('click','set_value','clear','toggle','check','uncheck','select','expand','collapse','scroll','scroll_to')",
    "  if ($supportedActs -notcontains $act) {",
    "    return @{ ok = $false; code = 'ACTION_NOT_SUPPORTED'; error = ('不支持的后台语义操作：' + $act) }",
    "  }",
    "  $hwnd = if ($null -ne $p.hwnd) { [long]$p.hwnd } else { 0L }",
    "  if ($hwnd -le 0 -or -not [CBWin]::IsWindow([IntPtr]$hwnd)) {",
    "    return @{ ok = $false; code = 'WINDOW_NOT_FOUND'; error = '目标窗口不存在。' }",
    "  }",
    "  $prePid = [CBWin]::GetPid($hwnd)",
    "  $preTitle = [CBWin]::ReadWindowTitle([IntPtr]$hwnd)",
    "  $preMeta = Get-CbProcMeta $prePid",
    "  if (Test-CbSelfTarget $prePid $preMeta.processName $preTitle $excludePid $p.excludeProcessNames) {",
    "    return @{ ok = $false; code = 'SELF_TARGET_FORBIDDEN'; error = '禁止后台操控 ChisaBot 自身窗口。' }",
    "  }",
    "  $expectedTicks = if ($null -ne $p.processStartTicks) { [string]$p.processStartTicks } else { '' }",
    "  if ($reqPid -gt 0 -and $prePid -ne $reqPid) {",
    "    return @{ ok = $false; code = 'STALE_REF'; error = '目标窗口 PID 已变更，请重新快照。' }",
    "  }",
    "  if ($expectedTicks -and $preMeta.processStartTicks -ne $expectedTicks) {",
    "    return @{ ok = $false; code = 'STALE_REF'; error = '目标窗口进程代际已变更，请重新快照。' }",
    "  }",
    "  if ([CBWin]::IsIconic([IntPtr]$hwnd)) {",
    "    return @{ ok = $false; code = 'WINDOW_MINIMIZED'; error = '目标窗口已最小化，无法后台操控。' }",
    "  }",
    "  $winEl = $null",
    "  try { $winEl = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd) } catch {}",
    "  if ($null -eq $winEl) {",
    "    return @{ ok = $false; code = 'WINDOW_NOT_FOUND'; error = '无法获取目标窗口 UIA 元素。' }",
    "  }",
    "  $tgt = $p.target",
    "  if ($null -eq $tgt) { return @{ ok = $false; code = 'STALE_REF'; error = '缺少目标控件描述 target。' } }",
    "  $wantRid = if ($null -ne $tgt.runtimeId) { [string]$tgt.runtimeId } else { '' }",
    "  $hasRole = ($null -ne $tgt.role) -and ([string]$tgt.role -ne '')",
    "  $wantRole = if ($hasRole) { ([string]$tgt.role).Trim().ToLowerInvariant() } else { '' }",
    "  $hasAid = ($null -ne $tgt.automationId)",
    "  $wantAid = if ($hasAid) { [string]$tgt.automationId } else { '' }",
    "  $hasName = ($null -ne $tgt.name)",
    "  $wantName = if ($hasName) { [string]$tgt.name } else { '' }",
    "  $hasDesc = ($null -ne $tgt.description)",
    "  $wantDesc = if ($hasDesc) { [string]$tgt.description } else { '' }",
    "  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker",
    "  $queue = New-Object 'System.Collections.Generic.Queue[object]'",
    "  $queue.Enqueue(@{ el = $winEl; depth = 0 })",
    "  $ridMatch = $null",
    "  $identityMatches = New-Object 'System.Collections.Generic.List[object]'",
    "  $visited = 0",
    "  $maxVisited = 5000",
    "  $maxDepth = 30",
    "  $hasAnyIdentity = $hasRole -or ($hasAid -and $wantAid -ne '') -or ($hasName -and $wantName -ne '') -or ($hasDesc -and $wantDesc -ne '')",
    "  while ($queue.Count -gt 0 -and $visited -lt $maxVisited) {",
    "    $item = $queue.Dequeue()",
    "    $curEl = $item.el",
    "    $depth = [int]$item.depth",
    "    $visited++",
    "    if ($depth -gt 0) {",
    "      try {",
    "        if ($wantRid -and $null -eq $ridMatch) {",
    "          $rid = Get-CbRuntimeIdStr $curEl",
    "          if ($rid -eq $wantRid) {",
    "            $roleOk = (-not $hasRole) -or ((Get-CbRoleName $curEl) -eq $wantRole)",
    "            if ($roleOk) { $ridMatch = $curEl; break }",
    "          }",
    "        }",
    "        if ($hasAnyIdentity) {",
    "          $c = $curEl.Current",
    "          $okMatch = $true",
    "          if ($hasRole -and (Get-CbRoleName $curEl) -ne $wantRole) { $okMatch = $false }",
    "          if ($okMatch -and $hasAid -and ([string]$c.AutomationId) -ne $wantAid) { $okMatch = $false }",
    "          if ($okMatch -and $hasName -and ([string]$c.Name) -ne $wantName) { $okMatch = $false }",
    "          if ($okMatch -and $hasDesc -and ([string]$c.HelpText) -ne $wantDesc) { $okMatch = $false }",
    "          if ($okMatch) { $identityMatches.Add($curEl) }",
    "        }",
    "      } catch {}",
    "    }",
    "    if ($depth -lt $maxDepth) {",
    "      try {",
    "        $child = $walker.GetFirstChild($curEl)",
    "        while ($null -ne $child -and ($visited + $queue.Count) -lt $maxVisited) {",
    "          $queue.Enqueue(@{ el = $child; depth = ($depth + 1) })",
    "          $child = $walker.GetNextSibling($child)",
    "        }",
    "      } catch {}",
    "    }",
    "  }",
    "  $el = $ridMatch",
    "  if ($null -eq $el) {",
    "    if ($identityMatches.Count -eq 0) {",
    "      return @{ ok = $false; code = 'STALE_REF'; error = '未在目标窗口中找到匹配控件，请重新快照。' }",
    "    }",
    "    if ($identityMatches.Count -ge 2) {",
    "      return @{ ok = $false; code = 'AMBIGUOUS_TARGET'; error = ('目标窗口中匹配到 ' + $identityMatches.Count + ' 个相同身份控件，拒绝模糊操作。') }",
    "    }",
    "    $el = $identityMatches[0]",
    "  }",
    "  $isPwd = $false",
    "  $matchedName = ''",
    "  try { $isPwd = [bool]$el.Current.IsPassword; $matchedName = [string]$el.Current.Name } catch {}",
    "  $patternUsed = ''",
    "  $delivery = 'delivered_unverified'",
    "  switch ($act) {",
    "    'click' {",
    "      $ip = $null",
    "      if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) {",
    "        $ip.Invoke()",
    "        $patternUsed = 'invoke'",
    "      } elseif (Invoke-CbLegacyDefaultAction $winEl $el) {",
    "        $patternUsed = 'legacy_default'",
    "      } else {",
    "        return @{ ok = $false; code = 'ACTION_NOT_SUPPORTED'; error = '目标控件不支持无焦点 click（缺少 InvokePattern 与 LegacyIAccessiblePattern）。' }",
    "      }",
    "    }",
    "    { $_ -eq 'set_value' -or $_ -eq 'clear' } {",
    "      $newVal = if ($act -eq 'clear') { '' } elseif ($null -ne $p.value) { [string]$p.value } else { '' }",
    "      $vp = $null",
    "      $rvp = $null",
    "      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {",
    "        if ($vp.Current.IsReadOnly) { return @{ ok = $false; code = 'ACTION_NOT_SUPPORTED'; error = '目标控件为只读，无法写入值。' } }",
    "        $vp.SetValue($newVal)",
    "        $patternUsed = 'value'",
    "        if (-not $isPwd) {",
    "          try { if ([string]$vp.Current.Value -eq $newVal) { $delivery = 'delivered_verified' } } catch {}",
    "        }",
    "      } elseif ($el.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$rvp)) {",
    "        if ($rvp.Current.IsReadOnly) { return @{ ok = $false; code = 'ACTION_NOT_SUPPORTED'; error = '目标数值控件为只读。' } }",
    "        $num = 0.0",
    "        if (-not [double]::TryParse($newVal, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$num)) {",
    "          return @{ ok = $false; code = 'ACTION_NOT_SUPPORTED'; error = 'RangeValuePattern 需要合法数值。' }",
    "        }",
    "        $rvp.SetValue($num)",
    "        $patternUsed = 'range_value'",
    "        if (-not $isPwd) {",
    "          try { if ([Math]::Abs([double]$rvp.Current.Value - $num) -lt 0.0001) { $delivery = 'delivered_verified' } } catch {}",
    "        }",
    "      } else {",
    "        return @{ ok = $false; code = 'ACTION_NOT_SUPPORTED'; error = '目标控件不支持 ValuePattern 或 RangeValuePattern。' }",
    "      }",
    "    }",
    "    { $_ -eq 'toggle' -or $_ -eq 'check' -or $_ -eq 'uncheck' } {",
    "      $tp = $null",
    "      $ip = $null",
    "      if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp)) {",
    "        $patternUsed = 'toggle'",
    "        $before = $tp.Current.ToggleState.ToString()",
    "        if ($act -eq 'check') {",
    "          if ($before -eq 'On') {",
    "            $delivery = 'delivered_verified'",
    "          } else {",
    "            for ($i = 0; $i -lt 2; $i++) {",
    "              $tp.Toggle()",
    "              if ($tp.Current.ToggleState.ToString() -eq 'On') { $delivery = 'delivered_verified'; break }",
    "            }",
    "          }",
    "        } elseif ($act -eq 'uncheck') {",
    "          if ($before -eq 'Off') {",
    "            $delivery = 'delivered_verified'",
    "          } else {",
    "            for ($i = 0; $i -lt 2; $i++) {",
    "              $tp.Toggle()",
    "              if ($tp.Current.ToggleState.ToString() -eq 'Off') { $delivery = 'delivered_verified'; break }",
    "            }",
    "          }",
    "        } else {",
    "          $tp.Toggle()",
    "          try { if ($tp.Current.ToggleState.ToString() -ne $before) { $delivery = 'delivered_verified' } } catch {}",
    "        }",
    "      } elseif ($act -eq 'toggle' -and $el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) {",
    "        $ip.Invoke()",
    "        $patternUsed = 'invoke'",
    "      } else {",
    "        return @{ ok = $false; code = 'ACTION_NOT_SUPPORTED'; error = '目标控件不支持 TogglePattern。' }",
    "      }",
    "    }",
    "    'select' {",
    "      $sip = $null",
    "      if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sip)) {",
    "        $sip.Select()",
    "        $patternUsed = 'selection_item'",
    "        try { if ([bool]$sip.Current.IsSelected) { $delivery = 'delivered_verified' } } catch {}",
    "      } elseif ($null -ne $p.option -and ([string]$p.option) -ne '') {",
    "        $optName = [string]$p.option",
    "        $condOpt = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $optName)",
    "        $optEl = $el.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condOpt)",
    "        if ($null -ne $optEl -and $optEl.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sip)) {",
    "          $sip.Select()",
    "          $patternUsed = 'selection_item'",
    "          $matchedName = $optName",
    "          try { if ([bool]$sip.Current.IsSelected) { $delivery = 'delivered_verified' } } catch {}",
    "        } else {",
    "          return @{ ok = $false; code = 'ACTION_NOT_SUPPORTED'; error = '目标控件及其选项不支持 SelectionItemPattern。' }",
    "        }",
    "      } else {",
    "        return @{ ok = $false; code = 'ACTION_NOT_SUPPORTED'; error = '目标控件不支持 SelectionItemPattern。' }",
    "      }",
    "    }",
    "    { $_ -eq 'expand' -or $_ -eq 'collapse' } {",
    "      $ecp = $null",
    "      if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ecp)) {",
    "        $patternUsed = 'expand_collapse'",
    "        $ecState = $ecp.Current.ExpandCollapseState.ToString()",
    "        if ($act -eq 'expand') {",
    "          if ($ecState -ne 'Expanded') { $ecp.Expand() }",
    "          try { $afterEc = $ecp.Current.ExpandCollapseState.ToString(); if ($afterEc -eq 'Expanded' -or $afterEc -eq 'PartiallyExpanded') { $delivery = 'delivered_verified' } } catch {}",
    "        } else {",
    "          if ($ecState -ne 'Collapsed') { $ecp.Collapse() }",
    "          try { if ($ecp.Current.ExpandCollapseState.ToString() -eq 'Collapsed') { $delivery = 'delivered_verified' } } catch {}",
    "        }",
    "      } else {",
    "        return @{ ok = $false; code = 'ACTION_NOT_SUPPORTED'; error = '目标控件不支持 ExpandCollapsePattern。' }",
    "      }",
    "    }",
    "    'scroll' {",
    "      $sp = $null",
    "      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$sp)) {",
    "        return @{ ok = $false; code = 'ACTION_NOT_SUPPORTED'; error = '目标控件不支持 ScrollPattern。' }",
    "      }",
    "      $dir = if ($null -ne $p.direction) { ([string]$p.direction).Trim().ToLowerInvariant() } else { 'down' }",
    "      $hAmt = [System.Windows.Automation.ScrollAmount]::NoAmount",
    "      $vAmt = [System.Windows.Automation.ScrollAmount]::NoAmount",
    "      switch ($dir) {",
    "        'up'    { $vAmt = [System.Windows.Automation.ScrollAmount]::SmallDecrement }",
    "        'down'  { $vAmt = [System.Windows.Automation.ScrollAmount]::SmallIncrement }",
    "        'left'  { $hAmt = [System.Windows.Automation.ScrollAmount]::SmallDecrement }",
    "        'right' { $hAmt = [System.Windows.Automation.ScrollAmount]::SmallIncrement }",
    "        default { return @{ ok = $false; code = 'ACTION_NOT_SUPPORTED'; error = ('不支持的滚动方向：' + $dir) } }",
    "      }",
    "      $steps = if ($null -ne $p.amount) { [Math]::Min(20, [Math]::Max(1, [int]$p.amount)) } else { 1 }",
    "      $beforeH = -1.0; $beforeV = -1.0",
    "      try { $beforeH = [double]$sp.Current.HorizontalScrollPercent; $beforeV = [double]$sp.Current.VerticalScrollPercent } catch {}",
    "      for ($i = 0; $i -lt $steps; $i++) { $sp.Scroll($hAmt, $vAmt) }",
    "      $patternUsed = 'scroll'",
    "      try {",
    "        $afterH = [double]$sp.Current.HorizontalScrollPercent",
    "        $afterV = [double]$sp.Current.VerticalScrollPercent",
    "        if ($afterH -ne $beforeH -or $afterV -ne $beforeV) { $delivery = 'delivered_verified' }",
    "      } catch {}",
    "    }",
    "    'scroll_to' {",
    "      $scip = $null",
    "      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scip)) {",
    "        return @{ ok = $false; code = 'ACTION_NOT_SUPPORTED'; error = '目标控件不支持 ScrollItemPattern。' }",
    "      }",
    "      $scip.ScrollIntoView()",
    "      $patternUsed = 'scroll_item'",
    "    }",
    "  }",
    "  if ([CBWin]::IsWindow([IntPtr]$hwnd)) {",
    "    $postPid = [CBWin]::GetPid($hwnd)",
    "    $postMeta = Get-CbProcMeta $postPid",
    "    if ($postPid -ne $prePid -or ($preMeta.processStartTicks -and $postMeta.processStartTicks -ne $preMeta.processStartTicks)) {",
    "      return @{ ok = $false; code = 'STALE_REF'; error = '操作后窗口句柄已归属其他进程。' }",
    "    }",
    "  } elseif ($act -ne 'click') {",
    "    return @{ ok = $false; code = 'STALE_REF'; error = '操作后目标窗口已关闭。' }",
    "  }",
    "  return @{ ok = $true; action = $act; matchedName = $matchedName; patternUsed = $patternUsed; delivery = $delivery }",
    "}",
    "Write-CbJson @{ ready = $true; pid = $PID; apartment = [System.Threading.Thread]::CurrentThread.GetApartmentState().ToString() }",
    "while ($true) {",
    "  $line = [Console]::In.ReadLine()",
    "  if ($null -eq $line) { break }",
    "  $trimmed = $line.Trim()",
    "  if (-not $trimmed) { continue }",
    "  $reqId = ''",
    "  try {",
    "    $req = ConvertFrom-Json -InputObject $trimmed",
    "    $reqId = if ($null -ne $req.id) { [string]$req.id } else { '' }",
    "    $cmd = if ($null -ne $req.cmd) { [string]$req.cmd } else { '' }",
    "    if ($cmd -eq 'quit') {",
    "      Write-CbJson @{ id = $reqId; ok = $true; data = @{ bye = $true } }",
    "      break",
    "    }",
    "    switch ($cmd) {",
    "      'ping' {",
    "        Write-CbJson @{ id = $reqId; ok = $true; data = @{ pong = $true; pid = $PID; apartment = [System.Threading.Thread]::CurrentThread.GetApartmentState().ToString() } }",
    "      }",
    "      'cursor_pos' {",
    "        $xy = [CBInput]::CursorXY()",
    "        Write-CbJson @{ id = $reqId; ok = $true; data = @{ ok = ($xy[0] -eq 1); x = [int]$xy[1]; y = [int]$xy[2] } }",
    "      }",
    "      'input' {",
    "        $res = Invoke-CbInput $req.payload",
    "        Write-CbJson @{ id = $reqId; ok = $true; data = $res }",
    "      }",
    "      'uia_read' {",
    "        $res = Invoke-CbUiaRead $req.payload",
    "        Write-CbJson @{ id = $reqId; ok = $true; data = $res }",
    "      }",
    "      'uia_action' {",
    "        $res = Invoke-CbUiaAction $req.payload",
    "        Write-CbJson @{ id = $reqId; ok = $true; data = $res }",
    "      }",
    "      'win_list' {",
    "        $res = Invoke-CbWinList $req.payload",
    "        Write-CbJson @{ id = $reqId; ok = $true; data = $res }",
    "      }",
    "      'win_capture' {",
    "        $res = Invoke-CbWinCapture $req.payload",
    "        Write-CbJson @{ id = $reqId; ok = $true; data = $res }",
    "      }",
    "      'uia_snapshot' {",
    "        $res = Invoke-CbUiaSnapshot $req.payload",
    "        Write-CbJson @{ id = $reqId; ok = $true; data = $res }",
    "      }",
    "      'uia_act' {",
    "        $res = Invoke-CbUiaAct $req.payload",
    "        Write-CbJson @{ id = $reqId; ok = $true; data = $res }",
    "      }",
    "      default {",
    "        Write-CbJson @{ id = $reqId; ok = $false; error = ('unknown_command:' + $cmd) }",
    "      }",
    "    }",
    "  } catch {",
    "    $msg = if ($_.Exception -and $_.Exception.Message) { $_.Exception.Message } else { [string]$_ }",
    "    Write-CbJson @{ id = $reqId; ok = $false; error = $msg }",
    "  }",
    "}",
  ].join("\n");
}

const RESIDENT_SCRIPT_TEXT = buildResidentHelperScript();
const RESIDENT_SCRIPT_ENCODED = encodePowerShell(RESIDENT_SCRIPT_TEXT);

function unlinkQuietly(filePath) {
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {}
}

function writeResidentScriptTempFile() {
  const token = crypto.randomBytes(8).toString("hex");
  const filePath = path.join(
    os.tmpdir(),
    `cb-win-helper-${process.pid}-${token}.ps1`,
  );
  // UTF-8 with BOM ensures Windows PowerShell 5.1 parses UTF-8 Chinese strings accurately
  fs.writeFileSync(filePath, `\uFEFF${RESIDENT_SCRIPT_TEXT}`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return filePath;
}

class HelperTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = "HelperTransportError";
    this.isTransportError = true;
  }
}

class HelperCommandError extends Error {
  constructor(message) {
    super(message);
    this.name = "HelperCommandError";
    this.isCommandError = true;
  }
}

function createWinPsHelper(options = {}) {
  const spawnImpl = options.spawn || spawn;
  const idleTimeoutMs = Math.max(
    50,
    Number(options.idleTimeoutMs) || DEFAULT_IDLE_TIMEOUT_MS,
  );
  const defaultTimeoutMs = Math.max(
    200,
    Number(options.defaultTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const maxStdoutBytes = Math.max(
    1024,
    Number(options.maxStdoutBytes) || DEFAULT_MAX_STDOUT_BYTES,
  );

  let child = null;
  let childScriptFile = null;
  let stdoutBuf = "";
  let stderrTail = "";
  let seq = 0;
  let idleTimer = null;
  let activeRequest = null;
  let spawnCount = 0;
  let disposed = false;
  const queue = [];

  function cleanupScriptFile() {
    if (childScriptFile) {
      const target = childScriptFile;
      childScriptFile = null;
      unlinkQuietly(target);
    }
  }

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleIdleShutdown() {
    clearIdleTimer();
    if (!child || activeRequest || queue.length > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!activeRequest && queue.length === 0) {
        terminateChild({ graceful: true });
      }
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  function terminateChild({ graceful = false, sync = false } = {}) {
    clearIdleTimer();
    cleanupScriptFile();
    const proc = child;
    child = null;
    stdoutBuf = "";
    stderrTail = "";
    if (!proc) return;
    const pid = proc.pid;
    if (graceful && !sync) {
      try {
        proc.stdin?.end(`${JSON.stringify({ id: "quit", cmd: "quit" })}\n`);
      } catch {}
      const killer = setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) {
          killPidTree(pid, { sync: false });
        }
      }, 600);
      killer.unref?.();
      return;
    }
    try {
      proc.stdin?.destroy();
    } catch {}
    if (proc.exitCode === null) {
      killPidTree(pid, { sync });
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
  }

  function failActiveTransport(reason, { retryable = true } = {}) {
    const req = activeRequest;
    activeRequest = null;
    if (req) {
      clearTimeout(req.timer);
      req.signal?.removeEventListener("abort", req.onAbort);
      req.reject(
        retryable
          ? new HelperTransportError(reason)
          : new HelperCommandError(reason),
      );
    }
    terminateChild({ graceful: false });
    pump();
  }

  function handleLine(rawLine) {
    const line = rawLine.trim();
    if (!line.startsWith(RESPONSE_PREFIX)) return;
    let parsed;
    try {
      parsed = JSON.parse(line.slice(RESPONSE_PREFIX.length));
    } catch {
      return;
    }
    if (parsed.ready === true) {
      cleanupScriptFile();
      return;
    }
    const req = activeRequest;
    if (!req || String(parsed.id || "") !== req.id) return;
    activeRequest = null;
    clearTimeout(req.timer);
    req.signal?.removeEventListener("abort", req.onAbort);
    if (parsed.ok) {
      req.resolve(parsed.data);
    } else {
      req.reject(
        new HelperCommandError(String(parsed.error || "命令执行失败")),
      );
    }
    pump();
  }

  function ensureProcess() {
    if (child && child.exitCode === null && !child.killed) return child;
    cleanupScriptFile();
    const psArgs = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
    ];
    let tempScript = null;
    if (RESIDENT_SCRIPT_ENCODED.length <= MAX_ENCODED_CMD_CHARS) {
      psArgs.push("-EncodedCommand", RESIDENT_SCRIPT_ENCODED);
    } else {
      tempScript = writeResidentScriptTempFile();
      psArgs.push("-File", tempScript);
    }
    let proc;
    try {
      proc = spawnImpl("powershell.exe", psArgs, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
    } catch (error) {
      unlinkQuietly(tempScript);
      throw error;
    }
    child = proc;
    childScriptFile = tempScript;
    spawnCount += 1;
    stdoutBuf = "";
    stderrTail = "";
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk) => {
      if (child !== proc) return;
      const text = String(chunk);
      if (
        Buffer.byteLength(stdoutBuf, "utf8") + Buffer.byteLength(text, "utf8") >
        maxStdoutBytes
      ) {
        stdoutBuf = "";
        failActiveTransport("Windows helper 输出超过安全上限", {
          retryable: false,
        });
        return;
      }
      stdoutBuf += text;
      let idx = stdoutBuf.indexOf("\n");
      while (idx >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        handleLine(line);
        idx = stdoutBuf.indexOf("\n");
      }
    });
    proc.stderr?.on("data", (chunk) => {
      if (child !== proc) return;
      stderrTail = (stderrTail + String(chunk)).slice(-1024);
    });
    proc.on("error", (error) => {
      if (child !== proc) return;
      failActiveTransport(`Windows helper 启动失败：${error.message}`);
    });
    proc.on("close", (code, signalName) => {
      if (child !== proc) return;
      const detail = stderrTail.trim()
        ? `（${stderrTail.trim().slice(0, 160)}）`
        : "";
      failActiveTransport(
        `Windows helper 意外退出（code=${code ?? "null"}, signal=${signalName ?? "none"}）${detail}`,
      );
    });
    proc.stdin?.on("error", (error) => {
      if (child !== proc) return;
      failActiveTransport(`Windows helper 管道写入失败：${error.message}`);
    });
    return proc;
  }

  function pump() {
    if (activeRequest) return;
    if (queue.length === 0) {
      scheduleIdleShutdown();
      return;
    }
    if (disposed) {
      while (queue.length > 0) {
        queue.shift().reject(new HelperTransportError("Windows helper 已关闭"));
      }
      return;
    }
    clearIdleTimer();
    const next = queue.shift();
    if (next.signal?.aborted) {
      next.reject(new HelperCommandError("操作已取消"));
      pump();
      return;
    }
    let proc;
    try {
      proc = ensureProcess();
    } catch (error) {
      next.reject(
        new HelperTransportError(`无法启动 Windows helper：${error.message}`),
      );
      pump();
      return;
    }

    const id = `r${++seq}`;
    const onAbort = () => {
      if (activeRequest !== next) return;
      activeRequest = null;
      clearTimeout(next.timer);
      terminateChild({ graceful: false });
      next.reject(new HelperCommandError("操作已取消"));
      pump();
    };
    next.id = id;
    next.onAbort = onAbort;
    next.signal?.addEventListener("abort", onAbort, { once: true });
    next.timer = setTimeout(() => {
      if (activeRequest !== next) return;
      activeRequest = null;
      next.signal?.removeEventListener("abort", onAbort);
      terminateChild({ graceful: false });
      next.reject(
        new HelperCommandError(
          `Windows helper 执行超时（${next.timeoutMs}ms）`,
        ),
      );
      pump();
    }, next.timeoutMs);
    next.timer.unref?.();
    activeRequest = next;

    try {
      proc.stdin.write(
        `${JSON.stringify({ id, cmd: next.cmd, payload: next.payload })}\n`,
        "utf8",
      );
    } catch (error) {
      failActiveTransport(`Windows helper 写入失败：${error.message}`);
    }
  }

  function sendOnce(
    cmd,
    payload,
    { timeoutMs = defaultTimeoutMs, signal } = {},
  ) {
    return new Promise((resolve, reject) => {
      queue.push({
        cmd,
        payload,
        timeoutMs: Math.max(200, Number(timeoutMs) || defaultTimeoutMs),
        signal,
        resolve,
        reject,
      });
      pump();
    });
  }

  /**
   * 发送白名单结构化 JSON 命令；遇管道异常自动重启并单次重试。
   * 显式 dispose() 后的实例永久不可复活（空闲超时回收仍可按需重建子进程）。
   */
  async function request(cmd, payload = {}, opts = {}) {
    if (!ALLOWED_COMMANDS.has(cmd)) {
      throw new HelperCommandError(`拒绝未授权的 Windows helper 命令：${cmd}`);
    }
    if (disposed) {
      throw new HelperTransportError("Windows helper 已关闭");
    }
    try {
      return await sendOnce(cmd, payload, opts);
    } catch (error) {
      if (error?.isTransportError && !disposed && !opts.signal?.aborted) {
        return sendOnce(cmd, payload, opts);
      }
      throw error;
    }
  }

  function dispose({ sync = false } = {}) {
    disposed = true;
    const active = activeRequest;
    activeRequest = null;
    if (active) {
      clearTimeout(active.timer);
      active.signal?.removeEventListener("abort", active.onAbort);
      active.reject(new HelperTransportError("Windows helper 已关闭"));
    }
    while (queue.length > 0) {
      queue.shift().reject(new HelperTransportError("Windows helper 已关闭"));
    }
    terminateChild({ graceful: false, sync });
  }

  return {
    request,
    dispose,
    stats: () => ({
      running: Boolean(child && child.exitCode === null && !child.killed),
      pid: child?.pid ?? null,
      spawnCount,
      pending: queue.length + (activeRequest ? 1 : 0),
    }),
  };
}

let sharedHelper = null;
let sharedPermanentlyDisposed = false;
let exitHookRegistered = false;

function getSharedWinPsHelper() {
  if (!sharedHelper) {
    sharedHelper = createWinPsHelper();
    if (sharedPermanentlyDisposed) {
      sharedHelper.dispose({ sync: false });
    }
    if (!exitHookRegistered) {
      exitHookRegistered = true;
      process.once("exit", () => {
        try {
          disposeSharedWinPsHelper({ sync: true, permanent: true });
        } catch {}
      });
    }
  }
  return sharedHelper;
}

function disposeSharedWinPsHelper(opts = {}) {
  const permanent = Boolean(opts.permanent);
  if (permanent) {
    sharedPermanentlyDisposed = true;
  }
  if (sharedHelper) {
    sharedHelper.dispose(opts);
    if (!permanent) {
      sharedHelper = null;
    }
  }
}

module.exports = {
  RESPONSE_PREFIX,
  ALLOWED_COMMANDS,
  DEFAULT_MAX_STDOUT_BYTES,
  HelperTransportError,
  HelperCommandError,
  buildResidentHelperScript,
  createWinPsHelper,
  getSharedWinPsHelper,
  disposeSharedWinPsHelper,
};
