Write-Output '--- USER PATH ---'
[Environment]::GetEnvironmentVariable('Path','User') -split ';' | Where-Object { $_ -match 'node' }
Write-Output '--- MACHINE PATH ---'
[Environment]::GetEnvironmentVariable('Path','Machine') -split ';' | Where-Object { $_ -match 'node' }
Write-Output '--- PROCESS PATH ---'
$env:Path -split ';' | Where-Object { $_ -match 'node' }
Write-Output '--- PROBES ---'
Write-Output ('node: ' + (Get-Command node -ErrorAction SilentlyContinue).Source)
Write-Output ('nodejs exe: ' + (Test-Path 'C:\Program Files\nodejs\node.exe'))
