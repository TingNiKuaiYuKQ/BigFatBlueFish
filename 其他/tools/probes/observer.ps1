# Foreground-window observer: one compact JSON line every 2 s.
# Used to validate the "auto low-interrupt" fullscreen detector design.
param([int]$IntervalMs = 2000)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FgWin {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[FgWin]::SetProcessDPIAware() | Out-Null

while ($true) {
  $h = [FgWin]::GetForegroundWindow()
  $rect = New-Object FgWin+RECT
  $ok = $false
  if ($h -ne [IntPtr]::Zero) { $ok = [FgWin]::GetWindowRect($h, [ref]$rect) }
  $targetPid = 0
  if ($h -ne [IntPtr]::Zero) { [void][FgWin]::GetWindowThreadProcessId($h, [ref]$targetPid) }
  $sb = New-Object System.Text.StringBuilder 256
  if ($h -ne [IntPtr]::Zero) { [void][FgWin]::GetClassName($h, $sb, $sb.Capacity) }
  $procName = ''
  try {
    $p = Get-Process -Id $targetPid -ErrorAction Stop
    $procName = $p.ProcessName
  } catch { $procName = '' }

  $screenRect = $null
  $workRect = $null
  $cover = $false
  $zoomed = $false
  $full = $false
  if ($h -ne [IntPtr]::Zero) {
    $zoomed = [FgWin]::IsZoomed($h)
    try {
      $scr = [System.Windows.Forms.Screen]::FromHandle($h)
      $screenRect = $scr.Bounds
      $workRect = $scr.WorkingArea
      $tol = 3
      $cover = ($rect.Left -le $screenRect.Left + $tol) -and
               ($rect.Top -le $screenRect.Top + $tol) -and
               ($rect.Right -ge $screenRect.Right - $tol) -and
               ($rect.Bottom -ge $screenRect.Bottom - $tol)
      $full = $cover -and (-not $zoomed)
    } catch { $full = $false }
  }

  $obj = [ordered]@{
    t = (Get-Date).ToString('o')
    hwnd = $h.ToInt64()
    pid = $targetPid
    proc = $procName
    cls = $sb.ToString()
    visible = if ($h -ne [IntPtr]::Zero) { [FgWin]::IsWindowVisible($h) } else { $false }
    rect = @($rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
    screen = if ($screenRect) { @($screenRect.Left, $screenRect.Top, $screenRect.Right, $screenRect.Bottom) } else { @() }
    work = if ($workRect) { @($workRect.Left, $workRect.Top, $workRect.Right, $workRect.Bottom) } else { @() }
    zoomed = $zoomed
    cover = $cover
    full = $full
  }
  $json = $obj | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $IntervalMs
}
