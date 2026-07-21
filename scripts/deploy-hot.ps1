param(
    [string]$HostName = "jiawa-vps",
    [int]$SshPort = 22,
    [string]$ContainerName = "grok-register-agent",
    [string]$IdentityFile,
    [switch]$RegisterOnly,
    [switch]$WithRegister,
    [switch]$NoRestart
)

# Fast deploy: rsync/scp code into running container (no 500MB image upload).
# - Default (slim): server dist + web UI only
# -WithRegister: also pack full register/ (Python engine)
# -RegisterOnly: only register/ (no npm build)
# Use full deploy-server.ps1 when Dockerfile/deps/entrypoint change.

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message"
}

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "command not found: $Name"
    }
}

function Invoke-Checked {
    param(
        [string]$FilePath,
        [string[]]$Arguments
    )
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "command failed ($LASTEXITCODE): $FilePath $($Arguments -join ' ')"
    }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
$stamp = Get-Date -Format "yyyyMMddHHmmss"

Require-Command "ssh"
Require-Command "scp"
Require-Command "tar"

if ($IdentityFile -and -not (Test-Path -LiteralPath $IdentityFile)) {
    throw "SSH identity file not found: $IdentityFile"
}

$sshBaseArgs = @("-p", "$SshPort", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30")
$scpBaseArgs = @("-P", "$SshPort", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30")
if ($IdentityFile) {
    $sshBaseArgs += @("-i", $IdentityFile)
    $scpBaseArgs += @("-i", $IdentityFile)
}

Write-Step "check remote container $ContainerName"
Invoke-Checked "ssh" ($sshBaseArgs + @($HostName, "docker inspect -f '{{.State.Running}}' $( $ContainerName ) | grep -q true"))

$work = Join-Path ([System.IO.Path]::GetTempPath()) "gra-hot-$stamp"
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
    if (-not $RegisterOnly) {
        Write-Step "build server + web UI"
        Push-Location $repoRoot
        try {
            npm run server:build
            if ($LASTEXITCODE -ne 0) { throw "npm run server:build failed" }
        } finally {
            Pop-Location
        }
    }

    Write-Step "pack payload"
    $payloadDir = Join-Path $work "payload"
    New-Item -ItemType Directory -Force -Path $payloadDir | Out-Null
    Set-Content -LiteralPath (Join-Path $payloadDir "BUILD_ID") -Value $stamp -NoNewline
    $includeRegister = $RegisterOnly -or $WithRegister
    if ($includeRegister) {
        New-Item -ItemType Directory -Force -Path (Join-Path $payloadDir "register") | Out-Null
        Copy-Item -Path (Join-Path $repoRoot "register\*") -Destination (Join-Path $payloadDir "register") -Recurse -Force
        Set-Content -LiteralPath (Join-Path $payloadDir "register\BUILD_ID") -Value $stamp -NoNewline
        Write-Host "    include: register/ (Python engine)"
    } else {
        Write-Host "    slim: skip register/ (use -WithRegister to include)"
    }
    if (-not $RegisterOnly) {
        New-Item -ItemType Directory -Force -Path (Join-Path $payloadDir "server\dist") | Out-Null
        New-Item -ItemType Directory -Force -Path (Join-Path $payloadDir "out") | Out-Null
        if (-not (Test-Path (Join-Path $repoRoot "server\dist"))) {
            throw "server/dist missing after build"
        }
        if (-not (Test-Path (Join-Path $repoRoot "out"))) {
            throw "out missing after build"
        }
        Copy-Item -Path (Join-Path $repoRoot "server\dist\*") -Destination (Join-Path $payloadDir "server\dist") -Recurse -Force
        Copy-Item -Path (Join-Path $repoRoot "out\*") -Destination (Join-Path $payloadDir "out") -Recurse -Force
        Write-Host "    include: server/dist + out/"
    }

    $tarPath = Join-Path $work "gra-hot-$stamp.tar.gz"
    # tar from payload root so members are register/... server/... out/...
    Push-Location $payloadDir
    try {
        tar -czf $tarPath *
        if ($LASTEXITCODE -ne 0) { throw "tar failed" }
    } finally {
        Pop-Location
    }
    $bytes = (Get-Item -LiteralPath $tarPath).Length
    Write-Host "    package size: $bytes bytes"

    $remoteTar = "/tmp/gra-hot-$stamp.tar.gz"
    Write-Step "upload package to $HostName"
    Invoke-Checked "scp" ($scpBaseArgs + @($tarPath, "${HostName}:${remoteTar}"))

    Write-Step "inject into container and restart node"
    $restartBlock = if ($NoRestart) {
        "echo 'skip container restart (-NoRestart); call restart manually if needed'"
    } else {
        @"
echo 'restart container to load new server/UI'
docker restart $( $ContainerName )
sleep 6
"@
    }
    $remote = @"
set -euo pipefail
docker cp $( $remoteTar ) $( $ContainerName ):/tmp/gra-hot.tar.gz
docker exec $( $ContainerName ) sh -c 'set -e
  cd /tmp
  rm -rf gra-hot-extract
  mkdir gra-hot-extract
  tar -xzf /tmp/gra-hot.tar.gz -C gra-hot-extract
  # Python register engine (always)
  if [ -d gra-hot-extract/register ]; then
    rsync -a --delete \
      --exclude "sso/" --exclude "logs/" --exclude "data/" --exclude "__pycache__/" \
      gra-hot-extract/register/ /app/register/
    # seed copy for entrypoint
    if [ -d /opt/register-seed ]; then
      rsync -a --delete \
        --exclude "sso/" --exclude "logs/" --exclude "data/" --exclude "__pycache__/" \
        gra-hot-extract/register/ /opt/register-seed/ || true
    fi
  fi
  if [ -d gra-hot-extract/server/dist ]; then
    rsync -a --delete gra-hot-extract/server/dist/ /app/server/dist/
  fi
  if [ -d gra-hot-extract/out ]; then
    rsync -a --delete gra-hot-extract/out/ /app/out/
  fi
  if [ -f gra-hot-extract/BUILD_ID ]; then
    mkdir -p /app/register
    cp gra-hot-extract/BUILD_ID /app/register/BUILD_ID
  elif [ -f gra-hot-extract/register/BUILD_ID ]; then
    mkdir -p /app/register
    cp gra-hot-extract/register/BUILD_ID /app/register/BUILD_ID
  fi
  rm -rf /tmp/gra-hot.tar.gz /tmp/gra-hot-extract
  echo BUILD_ID=`$(cat /app/register/BUILD_ID 2>/dev/null || echo missing)
'
rm -f $( $remoteTar )
$restartBlock
# Health: node classic function() (container may lack curl; avoid => for bash/ssh)
code=`$(docker exec $( $ContainerName ) node -e "require('http').get('http://127.0.0.1:6657/',function(r){process.stdout.write(String(r.statusCode));process.exit(0)}).on('error',function(){process.stdout.write('0');process.exit(0)})" 2>/dev/null || echo 0)
echo "health_http=`$code"
docker ps --filter name=$( $ContainerName ) --format '{{.Names}} {{.Status}}'
echo "HOT_DEPLOY_OK build=$stamp"
"@
    Invoke-Checked "ssh" ($sshBaseArgs + @($HostName, $remote))

    Write-Host ""
    Write-Host "Hot deployed build=$stamp"
    Write-Host "Full image deploy still: .\scripts\deploy-server.ps1"
    Write-Host "Slim default (server+UI). With Python: .\scripts\deploy-hot.ps1 -WithRegister"
    Write-Host "Register only: .\scripts\deploy-hot.ps1 -RegisterOnly"
}
finally {
    if (Test-Path -LiteralPath $work) {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}
