# Sets the download service's two secrets on Cloudflare. Run it yourself:
#   powershell -ExecutionPolicy Bypass -File services\download-api\scripts\set-secrets.ps1
#
# 1. STATS_KEY  - generated here with a cryptographic RNG, stored in Cloudflare, and saved to
#                 %USERPROFILE%\panurgos-stats-key.txt so you can read your user count later.
# 2. RESEND_API_KEY - you paste it once when asked (create it at resend.com/api-keys,
#                 permission "Sending access", domain panurgos.com). It is never shown or saved.
# Each upload is retried a few times, because some networks time out talking to Cloudflare.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$env:WRANGLER_SEND_METRICS = 'false'
$env:NODE_OPTIONS = '--dns-result-order=ipv4first'

function Put-Secret([string]$name, [string]$value) {
  for ($i = 1; $i -le 5; $i++) {
    Resolve-DnsName api.cloudflare.com -ErrorAction SilentlyContinue | Out-Null
    $out = $value | npx wrangler secret put $name --env="" 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0 -and $out -match 'Success') { Write-Host "  $name set." -ForegroundColor Green; return }
    Write-Host "  Attempt $i failed (network). Retrying..." -ForegroundColor Yellow
    Start-Sleep -Seconds (3 * $i)
  }
  throw "Could not set $name after 5 attempts. Check your connection and run this script again."
}

# Ask for the Resend key first, so retries never need you to paste it again.
$secure = Read-Host -Prompt 'Paste your Resend API key (input hidden)' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $resend = "$([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))".Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
if (-not $resend) { throw "Nothing was pasted. Right-click in the terminal (or Ctrl+Shift+V) to paste, then press Enter. Nothing was changed." }
if (-not $resend.StartsWith('re_')) { throw "That doesn't look like a Resend API key: they start with re_ (got $($resend.Length) characters). Nothing was changed." }

$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose()  # works on PowerShell 5.1 and 7
$stats = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$keyFile = Join-Path $env:USERPROFILE 'panurgos-stats-key.txt'

Write-Host "Setting STATS_KEY..." -ForegroundColor Cyan
Put-Secret 'STATS_KEY' $stats
Set-Content -Path $keyFile -Value $stats -NoNewline
Write-Host "  Saved your stats key to $keyFile (keep it private)." -ForegroundColor Green

Write-Host "Setting RESEND_API_KEY..." -ForegroundColor Cyan
Put-Secret 'RESEND_API_KEY' $resend
$resend = $null
Write-Host "Both secrets are set." -ForegroundColor Green
