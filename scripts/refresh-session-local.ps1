# Renova a sessão do Codental (conta principal e antiga) neste PC e grava no MongoDB.
# O GitHub Actions não passa no Cloudflare Turnstile do login; aqui o navegador roda com o IP e o Chrome do Windows.
# Agendado pela tarefa "Codental Refresh Session" (a cada 6 h). Log: %LOCALAPPDATA%\codental-refresh\refresh.log
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA 'codental-refresh'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'refresh.log'
if ((Test-Path $log) -and (Get-Item $log).Length -gt 500KB) { Move-Item $log "$log.old" -Force }

Get-Content (Join-Path $root '.env.local') | ForEach-Object {
    if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') {
        $v = $Matches[2].Trim()
        if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) { $v = $v.Substring(1, $v.Length - 2) }
        Set-Item -Path "Env:$($Matches[1])" -Value $v
    }
}

Set-Location $root
"=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Add-Content $log
& node .github/scripts/refresh-session.js *>&1 | Add-Content $log
"exit=$LASTEXITCODE" | Add-Content $log
exit $LASTEXITCODE
