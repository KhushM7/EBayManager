# Copies the Shop Health Power BI Project out of the repository, puts the read-only key (RO_API_KEY from .dev.vars)
# into the copy, and opens it. The key is never shown, and the copy in the repository stays without it.
# Run from the repository:  powershell -ExecutionPolicy Bypass -File scripts\powerbi-open.ps1
# Optional: -Dest <folder> (default ..\EbayManagerPowerPlatform\ShopHealth, beside the repository).
param([string]$Dest)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Dest) { $Dest = Join-Path (Split-Path $repo -Parent) 'EbayManagerPowerPlatform\ShopHealth' }
$Dest = [IO.Path]::GetFullPath($Dest)
if ($Dest.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) { throw "The copy must be outside the repository: it will hold the key." }

$m = Select-String -Path (Join-Path $repo '.dev.vars') -Pattern '^RO_API_KEY=(.+)$'
if (-not $m) { throw 'RO_API_KEY is not in .dev.vars.' }
$key = $m.Matches[0].Groups[1].Value.Trim().Trim('"')
if (-not $key) { throw 'RO_API_KEY in .dev.vars is empty.' }

# Fresh definitions each time (old pages would otherwise linger); Power BI's own .pbi folders are kept.
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
foreach ($d in 'ShopHealth.Report\definition', 'ShopHealth.SemanticModel\definition') {
  $p = Join-Path $Dest $d
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
Copy-Item -Path (Join-Path $repo 'powerplatform\powerbi\pbip\*') -Destination $Dest -Recurse -Force

$expr = Join-Path $Dest 'ShopHealth.SemanticModel\definition\expressions.tmdl'
$text = [IO.File]::ReadAllText($expr)
$needle = 'expression ApiKey = "" meta'
if (-not $text.Contains($needle)) { throw "expressions.tmdl has no empty ApiKey parameter to fill." }
$text = $text.Replace($needle, 'expression ApiKey = "' + $key.Replace('"', '""') + '" meta')
[IO.File]::WriteAllText($expr, $text, (New-Object Text.UTF8Encoding $false))

Write-Host "Copied to $Dest with the read-only key set (not shown). Opening ShopHealth.pbip..."
Start-Process (Join-Path $Dest 'ShopHealth.pbip')
