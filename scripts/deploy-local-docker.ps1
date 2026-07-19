param(
    [string]$Port,
    [switch]$NoBuild,
    [switch]$Pull,
    [switch]$Recreate,
    [switch]$Logs,
    [switch]$Down
)

# 在本机通过 docker/docker-compose.yml 构建并启动开发容器。
$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message"
}

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
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

function New-SecretValue {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return [Convert]::ToBase64String($bytes)
}

function Get-EnvValue {
    param(
        [string]$Path,
        [string]$Key
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return ""
    }

    $pattern = "^\s*$([regex]::Escape($Key))=(.*)$"
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match $pattern) {
            return $Matches[1].Trim()
        }
    }
    return ""
}

function Upsert-EnvValue {
    param(
        [string]$Path,
        [string]$Key,
        [string]$Value
    )

    $lines = @()
    if (Test-Path -LiteralPath $Path) {
        $lines = @(Get-Content -LiteralPath $Path)
    }

    $pattern = "^\s*$([regex]::Escape($Key))="
    $found = $false
    $updated = foreach ($line in $lines) {
        if ($line -match $pattern) {
            $found = $true
            "$Key=$Value"
        } else {
            $line
        }
    }

    if (-not $found) {
        $updated += "$Key=$Value"
    }

    Set-Content -LiteralPath $Path -Value $updated -Encoding UTF8
}

function Wait-ContainerHealthy {
    param(
        [string]$Name,
        [int]$TimeoutSec = 90
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $status = (& docker inspect --format "{{.State.Health.Status}}" $Name 2>$null)
        if ($LASTEXITCODE -eq 0) {
            $status = "$status".Trim()
            if ($status -eq "healthy") {
                return
            }
            if ($status -eq "unhealthy") {
                throw "容器 $Name 健康检查失败，请执行 .\scripts\deploy-local-docker.ps1 -Logs 查看日志。"
            }
        }
        Start-Sleep -Seconds 2
    }

    throw "等待容器 $Name 变为 healthy 超时，请执行 docker compose -f docker/docker-compose.yml ps 查看状态。"
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
$dockerDir = Join-Path $repoRoot "docker"
$composeFile = Join-Path $dockerDir "docker-compose.yml"
$envFile = Join-Path $dockerDir ".env"
$envExample = Join-Path $dockerDir ".env.example"
$registerDir = Join-Path $repoRoot "register"

if (-not (Test-Path -LiteralPath $composeFile)) {
    throw "未找到 docker compose 文件：$composeFile"
}

Require-Command "docker"

if ($Logs) {
    Push-Location $dockerDir
    try {
        Write-Step "跟随查看本机 Docker 日志"
        Invoke-Checked "docker" @("compose", "-f", $composeFile, "logs", "-f", "--tail", "200")
    } finally {
        Pop-Location
    }
    return
}

Write-Step "检查 Docker daemon"
docker info *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Docker daemon 不可用，请先启动 Docker Desktop 或 Docker 服务。"
}

if (-not (Test-Path -LiteralPath $envFile)) {
    if (-not (Test-Path -LiteralPath $envExample)) {
        throw "未找到环境变量示例文件：$envExample"
    }
    Write-Step "根据 docker/.env.example 创建 docker/.env"
    Copy-Item -LiteralPath $envExample -Destination $envFile
}

$masterKey = Get-EnvValue -Path $envFile -Key "GRA_MASTER_KEY"
if (-not $masterKey) {
    Write-Step "生成 docker/.env 的 GRA_MASTER_KEY"
    Upsert-EnvValue -Path $envFile -Key "GRA_MASTER_KEY" -Value (New-SecretValue)
}

if ($Port) {
    Write-Step "设置 docker/.env 中的 WEB_PORT=$Port"
    Upsert-EnvValue -Path $envFile -Key "WEB_PORT" -Value $Port
}

if (-not (Test-Path -LiteralPath (Join-Path $registerDir "runner.py")) -and
    -not (Test-Path -LiteralPath (Join-Path $registerDir "DrissionPage_example.py"))) {
    throw "register 目录不完整，预期在 $registerDir 下找到 runner.py 或 DrissionPage_example.py。"
}

$singBoxDir = Join-Path $registerDir "bin\sing-box"
if (-not (Test-Path -LiteralPath (Join-Path $singBoxDir "linux-amd64")) -and
    -not (Test-Path -LiteralPath (Join-Path $singBoxDir "linux-arm64"))) {
    Write-Warning "register/bin/sing-box 下未找到 sing-box Linux 二进制文件。构建可以继续，但 Sing-Box 模式可能不可用。"
    Write-Warning "如需使用，请先在 Git Bash 或 WSL 中执行 scripts/fetch-sing-box.sh。"
}

Push-Location $dockerDir
try {
    if ($Down) {
        Write-Step "停止本机 Docker 部署"
        Invoke-Checked "docker" @("compose", "-f", $composeFile, "down")
        return
    }

    $composeArgs = @("compose", "-f", $composeFile, "up", "-d")
    if (-not $NoBuild) {
        $composeArgs += "--build"
    }
    if ($Pull) {
        $composeArgs += "--pull"
        $composeArgs += "always"
    }
    if ($Recreate) {
        $composeArgs += "--force-recreate"
    }

    Write-Step "使用 docker compose 部署本地源码"
    Invoke-Checked "docker" $composeArgs

    Write-Step "当前容器状态"
    Invoke-Checked "docker" @("compose", "-f", $composeFile, "ps")

    Write-Step "等待容器健康检查通过"
    Wait-ContainerHealthy -Name "grok-agent"

    $webPort = if ($Port) { $Port } else { Get-EnvValue -Path $envFile -Key "WEB_PORT" }
    if (-not $webPort) {
        $webPort = "6657"
    }
    Write-Host ""
    Write-Host "访问地址：http://localhost:$webPort"
    Write-Host "数据目录：$((Join-Path $dockerDir 'data'))"
    Write-Host "查看日志：.\scripts\deploy-local-docker.ps1 -Logs"
    Write-Host "停止服务：.\scripts\deploy-local-docker.ps1 -Down"
} finally {
    Pop-Location
}
