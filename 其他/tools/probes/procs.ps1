Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ForEach-Object {
  Write-Output ("{0}`t{1}" -f $_.ProcessId, $_.CommandLine)
}
