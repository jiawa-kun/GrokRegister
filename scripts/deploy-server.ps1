param(
    [string]$HostName = "jiawa-vps",
    [int]$SshPort = 22,
    [string]$RemoteDir = "/home/jiawa/GrokRegisterAgent",
    [string]$ContainerName = "grok-register-agent",
    [string]$ImageName = "grok-register-agent:local",
    [string]$IdentityFile,
    [string]$WebPort = "6657",
    [switch]$NoCache,
    [switch]$Logs,
    [switch]$Down
)

# 将本地代码构建为 Docker 镜像，上传到服务器后通过 docker load 发布。
$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message"
}

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        if ($Name -eq "docker") {
            throw "未找到 'docker' 命令。当前发布流程需要在本机构建镜像，请先安装 Docker Desktop：winget install -e --id Docker.DockerDesktop"
        }
        throw "未找到 '$Name' 命令，请先安装或加入 PATH。"
    }
}

function Invoke-Checked {
    param(
        [string]$FilePath,
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "命令执行失败，退出码 ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
    }
}

function Assert-LocalDockerReady {
    docker info
    if ($LASTEXITCODE -ne 0) {
        throw @"
已找到 Docker CLI，但本机 Docker daemon 不可用。

当前发布流程需要在本机构建 Linux 镜像，所以必须启动 Docker Desktop，并使用 Linux engine。
Scoop 的 'docker' 包主要提供 CLI/Windows engine 工具，不足以构建本项目镜像。

处理方式：
  1. 安装 Docker Desktop：winget install -e --id Docker.DockerDesktop
  2. 启动 Docker Desktop，并等待状态变为 Running
  3. 重新打开 PowerShell
  4. 执行 docker info 验证
"@
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
    throw "未找到 SSH 私钥文件：$IdentityFile"
}

if (-not (Test-Path -LiteralPath $dockerfile)) {
    throw "未找到 Dockerfile：$dockerfile"
}

if (-not (Test-Path -LiteralPath $rootCompose)) {
    throw "未找到 docker-compose.yml：$rootCompose"
}

$sshBaseArgs = @("-p", "$SshPort")
$scpBaseArgs = @("-P", "$SshPort")
if ($IdentityFile) {
    $sshBaseArgs += @("-i", $IdentityFile)
    $scpBaseArgs += @("-i", $IdentityFile)
}

if ($Down) {
    Write-Step "正在停止 $HostName 上的 $ContainerName"
    Invoke-Checked "ssh" ($sshBaseArgs + @($HostName, "docker stop $(ShellQuote $ContainerName)"))
    return
}

if ($Logs) {
    Write-Step "正在跟随查看 $HostName 上 $ContainerName 的日志"
    Invoke-Checked "ssh" ($sshBaseArgs + @($HostName, "docker logs -f --tail 200 $(ShellQuote $ContainerName)"))
    return
}

$stamp = Get-Date -Format "yyyyMMddHHmmss"
$imageTar = Join-Path ([System.IO.Path]::GetTempPath()) "grok-register-agent-image-$stamp.tar"
$remoteImageTar = "/home/jiawa/grok-register-agent-image-$stamp.tar"
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
    Write-Step "检查本机 Docker"
    Assert-LocalDockerReady

    Write-Step "检查服务器 SSH 和 Docker"
    $remoteCheck = "command -v docker >/dev/null && docker compose version >/dev/null"
    Invoke-Checked "ssh" ($sshBaseArgs + @($HostName, $remoteCheck))

    Write-Step "本地构建镜像 $ImageName"
    Invoke-Checked "docker" $buildArgs

    Write-Step "导出镜像为 tar 文件"
    Invoke-Checked "docker" @("save", "-o", $imageTar, $ImageName)

    Write-Step "上传镜像到服务器"
    Invoke-Checked "scp" ($scpBaseArgs + @($imageTar, "${HostName}:${remoteImageTar}"))

    Write-Step "服务器加载镜像并重建容器"
    $overrideContent = @"
services:
  grok-register-agent:
    image: $ImageName
    environment:
      REGISTER_HOST_SRC: /opt/register-host-disabled
"@

    $healthSnippet = @'
sleep 5
code=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:6657/ || echo 000)
echo "health_http=$code"
if [ "$code" != "200" ] && [ "$code" != "401" ] && [ "$code" != "302" ] && [ "$code" != "301" ]; then
  echo "健康检查失败: HTTP $code" >&2
  docker logs --tail 80 CONTAINER_NAME_PLACEHOLDER 2>&1 || true
  exit 1
fi
'@
    $healthSnippet = $healthSnippet.Replace('CONTAINER_NAME_PLACEHOLDER', $ContainerName)
    $remoteDeploy = @"
set -e
mkdir -p $(ShellQuote $RemoteDir)
cd $(ShellQuote $RemoteDir)
if [ ! -f docker-compose.yml ]; then
  echo '在 $(ShellQuote $RemoteDir) 中未找到 docker-compose.yml' >&2
  exit 1
fi
cat > docker-compose.local-image.yml <<'EOF'
$overrideContent
EOF
docker load -i $(ShellQuote $remoteImageTar)
WEB_PORT=$(ShellQuote $WebPort) docker compose -f docker-compose.yml -f docker-compose.local-image.yml up -d --force-recreate --no-deps grok-register-agent
rm -f $(ShellQuote $remoteImageTar)
$healthSnippet
docker ps --filter name=$(ShellQuote $ContainerName) --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
"@
    Invoke-Checked "ssh" ($sshBaseArgs + @($HostName, $remoteDeploy))

    Write-Host ""
    Write-Host "已发布镜像：$ImageName"
    Write-Host "目标位置：${HostName}:$RemoteDir"
    Write-Host "访问地址：http://23.106.46.133:$WebPort"
    Write-Host "查看日志：.\scripts\deploy-server.ps1 -Logs"

} finally {
    if (Test-Path -LiteralPath $imageTar) {
        Remove-Item -LiteralPath $imageTar -Force
    }
}
