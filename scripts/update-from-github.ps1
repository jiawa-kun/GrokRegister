param(
    [switch]$Solver,
    [switch]$Login,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message"
}

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        if ($Name -eq "docker") {
            throw "docker not found. Install Docker Desktop or Docker Engine first."
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

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
$composeFile = Join-Path $repoRoot "docker-compose.yml"

Require-Command "docker"

if (-not (Test-Path -LiteralPath $composeFile)) {
    throw "docker-compose.yml not found: $composeFile"
}

if ($Login) {
    Write-Step "login to GitHub Container Registry"
    Write-Host "Use your GitHub username and a token with read:packages permission when prompted."
    Invoke-Checked "docker" @("login", "ghcr.io")
}

$composeArgs = @("compose", "-f", $composeFile)
if ($Solver) {
    $composeArgs += @("--profile", "solver")
}

Push-Location $repoRoot
try {
    Write-Step "pull latest images from GHCR"
    Invoke-Checked "docker" ($composeArgs + @("pull"))

    if (-not $NoStart) {
        Write-Step "recreate containers with pulled images"
        Invoke-Checked "docker" ($composeArgs + @("up", "-d", "--remove-orphans"))
        Write-Step "current containers"
        Invoke-Checked "docker" @(
            "ps",
            "--filter",
            "name=grok-register-agent",
            "--filter",
            "name=grok-turnstile-solver",
            "--format",
            "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"
        )
    }
} finally {
    Pop-Location
}

