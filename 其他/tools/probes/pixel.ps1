# Samples one screen pixel (physical coordinates) after making this process DPI aware.
param([int]$X, [int]$Y)

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public class DpiAware {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[DpiAware]::SetProcessDPIAware() | Out-Null

$bmp = New-Object System.Drawing.Bitmap 1, 1
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($X, $Y, 0, 0, $bmp.Size)
$c = $bmp.GetPixel(0, 0)
Write-Output ("{0},{1},{2}" -f $c.R, $c.G, $c.B)
$g.Dispose()
$bmp.Dispose()
