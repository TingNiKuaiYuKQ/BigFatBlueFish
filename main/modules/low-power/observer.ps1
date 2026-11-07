# 全屏观察器（0.5.4）——每 2 秒输出一行 JSON，主进程逐行读。
#
# 判定必须用 visible && cover && !IsZoomed：
#   · 本机任务栏自动隐藏，workArea == bounds，最大化窗口的矩形也「覆盖全屏」；
#   · 实测最大化窗口 cover=true, zoomed=true, full=false；全屏游戏 zoomed=false, full=true。
# 另外排除桌面/任务栏类名与桌宠自身 pid（否则点桌面也会被当成全屏）。
#
# 输出示例：
#   {"cover":true,"zoomed":false,"full":true,"process":"GenshinImpact","class":"UnityWndClass","pid":1234}
#
# 只读、不弹窗、无控制台（主进程用 windowsHide 拉起）。

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class PetFullscreenProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
}
'@

while ($true) {
  $h = [PetFullscreenProbe]::GetForegroundWindow()
  $out = @{ cover = $false; zoomed = $false; full = $false; process = ''; class = ''; pid = 0 }
  if ($h -ne [IntPtr]::Zero) {
    $r = New-Object PetFullscreenProbe+RECT
    [void][PetFullscreenProbe]::GetWindowRect($h, [ref]$r)
    $mon = [PetFullscreenProbe]::MonitorFromWindow($h, 2)
    $mi = New-Object PetFullscreenProbe+MONITORINFO
    $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
    [void][PetFullscreenProbe]::GetMonitorInfo($mon, [ref]$mi)
    $sb = New-Object System.Text.StringBuilder 256
    [void][PetFullscreenProbe]::GetClassName($h, $sb, 256)
    $cls = $sb.ToString()
    $procId = 0
    [void][PetFullscreenProbe]::GetWindowThreadProcessId($h, [ref]$procId)
    $visible = [PetFullscreenProbe]::IsWindowVisible($h)
    $zoomed = [PetFullscreenProbe]::IsZoomed($h)
    $w = $r.Right - $r.Left
    $hh = $r.Bottom - $r.Top
    $mw = $mi.rcMonitor.Right - $mi.rcMonitor.Left
    $mh = $mi.rcMonitor.Bottom - $mi.rcMonitor.Top
    $cover = ($w -ge $mw -and $hh -ge $mh)
    $bad = @('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd')
    $isShell = $bad -contains $cls
    $procName = ''
    try { $procName = (Get-Process -Id $procId).ProcessName } catch { }
    $out.cover = $cover
    $out.zoomed = $zoomed
    $out.visible = $visible
    $out.class = $cls
    $out.process = $procName
    $out.pid = $procId
    $out.full = ($visible -and $cover -and (-not $zoomed) -and (-not $isShell))
  }
  $out | ConvertTo-Json -Compress
  Start-Sleep -Seconds 2
}
