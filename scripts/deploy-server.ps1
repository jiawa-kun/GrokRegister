param(
    [string]$HostName = "jiawa-vps",
    [int]$SshPort = 22,
    [string]$RemoteDir = "/home/jiawa/GrokRegisterAgent",
    [string]$ContainerName = "grok-register-agent",
    [string]$ImageName = "grok-register-agent:local",
    [string]$IdentityFile,
    [string]$WebPort = "6657",
    [switch]$NoCache,
    [switch]$SkipPrune,
    [switch]$Logs,
    [switch]$Down
)

# Local build image -> scp tar -> remote docker load + compose recreate.
# After success: prune dangling images + build cache (keeps running containers).
$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message"
}

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        if ($Name -eq "docker") {
            throw "docker not found. Install Docker Desktop: winget install -e --id Docker.DockerDesktop"
        }
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

function Assert-LocalDockerReady {
    docker info 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker daemon unavailable. Start Docker Desktop (Linux engine) and retry."
    }
}

function ShellQuote {
    param([string]$Value)
    return "'" + ($Value -replace "'", "'\''") + "'"
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
$dockerfile = Join-Path $repoRoot "docker\Dockerfile"
$rootCompose = Join-Path $repoRoot "docker-compose.yml"

Require-Command "docker"
Require-Command "ssh"
Require-Command "scp"

if ($IdentityFile -and -not (Test-Path -LiteralPath $IdentityFile)) {
    throw "SSH identity file not found: $IdentityFile"
}
if (-not (Test-Path -LiteralPath $dockerfile)) {
    throw "Dockerfile not found: $dockerfile"
}
if (-not (Test-Path -LiteralPath $rootCompose)) {
    throw "docker-compose.yml not found: $rootCompose"
}

$sshBaseArgs = @("-p", "$SshPort", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30")
$scpBaseArgs = @("-P", "$SshPort", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30")
if ($IdentityFile) {
    $sshBaseArgs += @("-i", $IdentityFile)
    $scpBaseArgs += @("-i", $IdentityFile)
}

if ($Down) {
    Write-Step "stop container on $HostName"
    Invoke-Checked "ssh" ($sshBaseArgs + @($HostName, "docker stop $(ShellQuote $ContainerName)"))
    return
}

if ($Logs) {
    Write-Step "follow logs on $HostName"
    Invoke-Checked "ssh" ($sshBaseArgs + @($HostName, "docker logs -f --tail 200 $(ShellQuote $ContainerName)"))
    return
}

$stamp = Get-Date -Format "yyyyMMddHHmmss"
$imageTar = Join-Path ([System.IO.Path]::GetTempPath()) "grok-register-agent-image-$stamp.tar"
$remoteImageTar = "/tmp/grok-register-agent-image-$stamp.tar"
$buildId = $stamp

$buildArgs = @(
    "build",
    "-f", "$dockerfile",
    "-t", $ImageName,
    "--build-arg", "REGISTER_BUILD=$buildId"
)
if ($NoCache) {
    $buildArgs += "--no-cache"
}
$buildArgs += "$repoRoot"

try {
    Write-Step "check local Docker"
    Assert-LocalDockerReady

    Write-Step "check remote SSH and Docker"
    Invoke-Checked "ssh" ($sshBaseArgs + @($HostName, "command -v docker >/dev/null && docker compose version >/dev/null"))

    $singboxAmd64 = Join-Path $repoRoot "register\bin\sing-box\linux-amd64"
    if (-not (Test-Path -LiteralPath $singboxAmd64)) {
        Write-Step "sing-box binary missing; download linux-amd64/arm64"
        $ver = "1.13.14"
        $sbDir = Join-Path $repoRoot "register\bin\sing-box"
        New-Item -ItemType Directory -Force -Path $sbDir | Out-Null
        foreach ($arch in @("amd64", "arm64")) {
            $url = "https://github.com/SagerNet/sing-box/releases/download/v$ver/sing-box-$ver-linux-$arch.tar.gz"
            $tmp = Join-Path $env:TEMP "sing-box-$arch-$stamp.tgz"
            Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
            $extract = Join-Path $env:TEMP "sing-box-extract-$arch-$stamp"
            New-Item -ItemType Directory -Force -Path $extract | Out-Null
            tar -xzf $tmp -C $extract
            $bin = Get-ChildItem -Path $extract -Recurse -Filter "sing-box" | Select-Object -First 1
            if (-not $bin) { throw "sing-box binary not found for $arch" }
            Copy-Item $bin.FullName (Join-Path $sbDir "linux-$arch") -Force
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    Write-Step "local build image $ImageName (REGISTER_BUILD=$buildId)"
    Invoke-Checked "docker" $buildArgs

    Write-Step "export image to tar"
    Invoke-Checked "docker" @("save", "-o", $imageTar, $ImageName)
    $tarSize = (Get-Item -LiteralPath $imageTar).Length
    Write-Host "    image tar size: $tarSize bytes"

    Write-Step "upload image to server"
    Invoke-Checked "scp" ($scpBaseArgs + @($imageTar, "${HostName}:${remoteImageTar}"))

    Write-Step "remote load image and recreate container"
    $overrideContent = @"
services:
  grok-register-agent:
    image: $ImageName
    environment:
      REGISTER_HOST_SRC: /opt/register-host-disabled
      GRA_MASTER_KEY: `${GRA_MASTER_KEY:-}
      GRA_REQUIRE_MASTER_KEY: `${GRA_REQUIRE_MASTER_KEY:-1}
"@

    $pruneBlock = if ($SkipPrune) {
        "echo 'skip docker prune (-SkipPrune)'"
    } else {
        @"
echo '==> prune dangling images + build cache (keep running containers)'
docker image prune -f || true
docker builder prune -af || true
docker system df || true
"@
    }

    $remoteDeploy = @"
set -euo pipefail
mkdir -p $(ShellQuote $RemoteDir)
cd $(ShellQuote $RemoteDir)
if [ ! -f docker-compose.yml ]; then
  echo "docker-compose.yml not found in $(ShellQuote $RemoteDir)" >&2
  exit 1
fi
if [ -f .env ]; then
  if ! grep -qE '^GRA_MASTER_KEY=.+' .env; then
    KEY=`$(openssl rand -hex 32)
    if grep -qE '^GRA_MASTER_KEY=' .env; then
      sed -i "s/^GRA_MASTER_KEY=.*/GRA_MASTER_KEY=`$KEY/" .env
    else
      printf '\nGRA_MASTER_KEY=%s\n' "`$KEY" >> .env
    fi
    echo "generated GRA_MASTER_KEY on server"
  fi
  grep -qE '^GRA_REQUIRE_MASTER_KEY=.' .env || echo 'GRA_REQUIRE_MASTER_KEY=1' >> .env
fi
cat > docker-compose.local-image.yml <<'EOF'
$overrideContent
EOF
docker load -i $(ShellQuote $remoteImageTar)
rm -f $(ShellQuote $remoteImageTar)
WEB_PORT=$(ShellQuote $WebPort) docker compose -f docker-compose.yml -f docker-compose.local-image.yml up -d --force-recreate --no-deps grok-register-agent
sleep 8
code=`$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:6657/ || echo 000)
echo "health_http=`$code"
if [ "`$code" != "200" ] && [ "`$code" != "401" ] && [ "`$code" != "302" ] && [ "`$code" != "301" ]; then
  echo "health check failed: HTTP `$code" >&2
  docker logs --tail 100 $(ShellQuote $ContainerName) 2>&1 || true
  exit 1
fi
docker ps --filter name=$(ShellQuote $ContainerName) --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker logs --tail 20 $(ShellQuote $ContainerName) 2>&1 || true
$pruneBlock
echo "DEPLOY_OK build=$buildId"
"@
    Invoke-Checked "ssh" ($sshBaseArgs + @($HostName, $remoteDeploy))

    if (-not $SkipPrune) {
        Write-Step "local prune dangling images + build cache"
        docker image prune -f 1>$null 2>$null
        docker builder prune -af 1>$null 2>$null
    }

    Write-Host ""
    Write-Host "Deployed image: $ImageName"
    Write-Host "Remote dir: ${HostName}:$RemoteDir"
    Write-Host "URL: http://23.106.46.133:$WebPort"
    Write-Host "Logs: .\scripts\deploy-server.ps1 -Logs"
    Write-Host "Skip prune next time: .\scripts\deploy-server.ps1 -SkipPrune"
}
finally {
    if (Test-Path -LiteralPath $imageTar) {
        Remove-Item -LiteralPath $imageTar -Force -ErrorAction SilentlyContinue
    }
}
