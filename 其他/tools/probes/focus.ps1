# Force a window to the foreground (probe helper).
param([long]$Hwnd)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Fg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[Fg]::SetProcessDPIAware() | Out-Null
$h = [IntPtr]$Hwnd
[void][Fg]::ShowWindow($h, 9)
[void][Fg]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 200
