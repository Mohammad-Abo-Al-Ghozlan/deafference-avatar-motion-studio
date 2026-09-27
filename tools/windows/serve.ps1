<#
  Deafference Motion Studio - local launcher (Windows PowerShell 5.1+ / PowerShell 7).
  Serves the built app from .\app on http://localhost (this computer only),
  with correct MIME types and byte ranges (video seeking), then opens the
  default browser. Nothing is uploaded anywhere. Close this window to stop.
#>
param([int]$Port = 8765)
$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'app')).TrimEnd('\', '/')
if (-not (Test-Path (Join-Path $root 'index.html'))) {
  Write-Host "The 'app' folder is missing next to this script: $root" -ForegroundColor Red
  [void](Read-Host 'Press Enter to close')
  exit 1
}

# The avatar is shipped in parts when a transfer channel limits file size:
# join them once (byte-exact), then remove the parts.
$models = Join-Path $root 'models'
$glb = Join-Path $models 'deafference-avatar.glb'
$parts = @(Get-ChildItem -Path $models -Filter 'deafference-avatar.glb.part*' -ErrorAction SilentlyContinue | Sort-Object Name)
if (-not (Test-Path $glb) -and $parts.Count -gt 0) {
  Write-Host 'Preparing the avatar (first run only)...'
  $out = [System.IO.File]::Create($glb)
  try {
    foreach ($part in $parts) {
      $in = [System.IO.File]::OpenRead($part.FullName)
      try { $in.CopyTo($out) } finally { $in.Dispose() }
    }
  } finally { $out.Dispose() }
}
if ((Test-Path $glb) -and $parts.Count -gt 0) { $parts | Remove-Item -ErrorAction SilentlyContinue }

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'; '.wasm' = 'application/wasm'
  '.glb' = 'model/gltf-binary'; '.mp4' = 'video/mp4'; '.webm' = 'video/webm'
  '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.png' = 'image/png'; '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'
}

# Loopback-only listener on the first free port (no admin rights needed).
# 'localhost' first, then the explicit loopback address as a fallback.
$listener = $null
$hostName = 'localhost'
foreach ($candidate in $Port..($Port + 15)) {
  foreach ($name in @('localhost', '127.0.0.1')) {
    $attempt = New-Object System.Net.HttpListener
    $attempt.Prefixes.Add("http://$($name):$candidate/")
    try { $attempt.Start(); $listener = $attempt; $Port = $candidate; $hostName = $name; break } catch { $attempt.Close() }
  }
  if ($listener) { break }
}
if (-not $listener) {
  Write-Host "Could not open a local port ($Port-$($Port + 15))." -ForegroundColor Red
  Write-Host 'Alternative: install Node.js, then run "npx serve app" in this folder.'
  [void](Read-Host 'Press Enter to close')
  exit 1
}

# Several workers so a streaming video response never blocks other requests.
$worker = {
  param($listener, $root, $mime)
  $separator = [System.IO.Path]::DirectorySeparatorChar
  while ($listener.IsListening) {
    try { $context = $listener.GetContext() } catch { break }
    $response = $context.Response
    try {
      $request = $context.Request
      $path = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath)
      if ($path -eq '/') { $path = '/index.html' }
      $full = [System.IO.Path]::GetFullPath((Join-Path $root $path.TrimStart('/')))
      if (-not $full.StartsWith($root + $separator) -or -not [System.IO.File]::Exists($full)) {
        $response.StatusCode = 404
        $response.Close()
        continue
      }
      $type = $mime[[System.IO.Path]::GetExtension($full).ToLowerInvariant()]
      if (-not $type) { $type = 'application/octet-stream' }
      $response.ContentType = $type
      $response.AddHeader('Cache-Control', 'no-cache')
      $response.AddHeader('Accept-Ranges', 'bytes')
      $stream = [System.IO.File]::Open($full, 'Open', 'Read', 'ReadWrite')
      try {
        $length = $stream.Length
        $start = [int64]0
        $end = $length - 1
        $range = $request.Headers['Range']
        if ($range -and $range -match '^bytes=(\d*)-(\d*)$') {
          if ($Matches[1] -ne '') {
            $start = [int64]$Matches[1]
            if ($Matches[2] -ne '') { $end = [Math]::Min([int64]$Matches[2], $length - 1) }
          } elseif ($Matches[2] -ne '') {
            $start = [Math]::Max([int64]0, $length - [int64]$Matches[2])
          }
          if ($start -ge $length -or $start -gt $end) {
            $response.StatusCode = 416
            $response.AddHeader('Content-Range', "bytes */$length")
            $response.Close()
            continue
          }
          $response.StatusCode = 206
          $response.AddHeader('Content-Range', "bytes $start-$end/$length")
        }
        $count = $end - $start + 1
        $response.ContentLength64 = $count
        if ($request.HttpMethod -ne 'HEAD') {
          [void]$stream.Seek($start, 'Begin')
          $buffer = New-Object byte[] 262144
          $remaining = $count
          while ($remaining -gt 0) {
            $read = $stream.Read($buffer, 0, [int][Math]::Min([int64]$buffer.Length, $remaining))
            if ($read -le 0) { break }
            $response.OutputStream.Write($buffer, 0, $read)
            $remaining -= $read
          }
        }
      } finally { $stream.Dispose() }
      $response.Close()
    } catch {
      # The browser cancelled the request (e.g. video seek): drop it.
      try { $response.Abort() } catch { }
    }
  }
}

$pool = [runspacefactory]::CreateRunspacePool(1, 8)
$pool.Open()
$workers = @()
for ($i = 0; $i -lt 8; $i++) {
  $shell = [powershell]::Create()
  $shell.RunspacePool = $pool
  [void]$shell.AddScript($worker).AddArgument($listener).AddArgument($root).AddArgument($mime)
  $workers += [pscustomobject]@{ Shell = $shell; Handle = $shell.BeginInvoke() }
}

$url = "http://$($hostName):$Port/"
Write-Host ''
Write-Host "  Deafference Motion Studio is running at $url" -ForegroundColor Cyan
Write-Host '  (served from this computer only; nothing is uploaded)'
Write-Host ''
Write-Host '  Keep this window open while you use the app.'
Write-Host '  Press Enter here, or close the window, to stop.'
if (-not $env:DEAFFERENCE_NO_BROWSER) { Start-Process $url }
if ($env:DEAFFERENCE_RUN_SECONDS) { Start-Sleep -Seconds ([int]$env:DEAFFERENCE_RUN_SECONDS) } else { [void](Read-Host) }

$listener.Stop()
$listener.Close()
foreach ($w in $workers) { try { [void]$w.Shell.EndInvoke($w.Handle) } catch { }; $w.Shell.Dispose() }
$pool.Close()
