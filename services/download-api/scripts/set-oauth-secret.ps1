# Stores a Google or GitHub OAuth client secret on Cloudflare. Run it yourself:
#   powershell -ExecutionPolicy Bypass -File services\download-api\scripts\set-oauth-secret.ps1 github
#   powershell -ExecutionPolicy Bypass -File services\download-api\scripts\set-oauth-secret.ps1 google
# The secret is typed/pasted hidden, sent straight to Cloudflare, and never saved on this PC.
param([Parameter(Mandatory = $true)][ValidateSet('github', 'google')][string]$Provider)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$env:WRANGLER_SEND_METRICS = 'false'
$env:NODE_OPTIONS = '--dns-result-order=ipv4first'
$name = if ($Provider -eq 'github') { 'GITHUB_CLIENT_SECRET' } else { 'GOOGLE_CLIENT_SECRET' }

$secure = Read-Host -Prompt "Paste the $Provider client secret (input hidden)" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $value = "$([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))".Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
if (-not $value) { throw 'Nothing was pasted. Right-click in the terminal (or Ctrl+Shift+V) to paste, then press Enter. Nothing was changed.' }
if ($Provider -eq 'github' -and $value -notmatch '^[0-9a-f]{40}$') { throw "That doesn't look like a GitHub client secret (40 hex characters; got $($value.Length)). Nothing was changed." }
if ($Provider -eq 'google' -and -not $value.StartsWith('GOCSPX-')) { throw "That doesn't look like a Google client secret (starts with GOCSPX-; got $($value.Length) characters). Nothing was changed." }

for ($i = 1; $i -le 5; $i++) {
  Resolve-DnsName api.cloudflare.com -ErrorAction SilentlyContinue | Out-Null
  $out = $value | npx wrangler secret put $name --env="" 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0 -and $out -match 'Success') { $value = $null; Write-Host "$name set." -ForegroundColor Green; exit 0 }
  Write-Host "Attempt $i failed (network). Retrying..." -ForegroundColor Yellow
  Start-Sleep -Seconds (3 * $i)
}
$value = $null
throw "Could not set $name after 5 attempts. Check your connection and run this again."
