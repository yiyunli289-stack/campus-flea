param(
    [ValidateSet('Check', 'Bootstrap', 'Start')]
    [string]$Mode = 'Start',
    [string]$EnvironmentId = 'cloud1-d5gody0jj8418ae20',
    [string]$Username = 'admin'
)

$ErrorActionPreference = 'Stop'
if ($EnvironmentId -notmatch '^[a-z0-9][a-z0-9-]+$') { throw '云环境 ID 格式不正确。' }
Push-Location (Join-Path $PSScriptRoot '..')
$fields = @('TCB_ENV', 'TENCENTCLOUD_SECRETID', 'TENCENTCLOUD_SECRETKEY', 'TENCENTCLOUD_SESSIONTOKEN',
    'ADMIN_BOOTSTRAP_USERNAME', 'ADMIN_BOOTSTRAP_PASSWORD', 'AUDIT_SECRET')
$previous = @{}
foreach ($name in $fields) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:TCB_ENV = $EnvironmentId
    $cli = Get-Command tcb.cmd -ErrorAction SilentlyContinue
    if ($cli) {
        $json = & $cli.Source secrets get --json -e $EnvironmentId
    } else {
        $json = & npx.cmd --yes --cache .npm-cache --package=@cloudbase/cli -c "tcb secrets get --json -e $EnvironmentId"
    }
    if ($LASTEXITCODE -ne 0) { throw '未能读取 CloudBase CLI 登录。请使用 tcb login 完成授权。' }
    try {
        $session = $json | Out-String | ConvertFrom-Json -ErrorAction Stop
        if ($session.data) { $session = $session.data }
    } catch { throw 'CLI 凭证响应格式不正确。' }
    if (-not ($session.secretId -and $session.secretKey -and $session.token)) {
        throw '当前 CLI 授权未提供临时凭证。请使用 tcb login，或在 .env.cloud 配置运行时凭证。'
    }
    $env:TENCENTCLOUD_SECRETID = $session.secretId
    $env:TENCENTCLOUD_SECRETKEY = $session.secretKey
    $env:TENCENTCLOUD_SESSIONTOKEN = $session.token

    if ($Mode -eq 'Check') {
        if (-not $env:AUDIT_SECRET) { $env:AUDIT_SECRET = & node -p "require('node:crypto').randomBytes(32).toString('hex')" }
        & node scripts/cloud-admin.js --check
    } elseif ($Mode -eq 'Bootstrap') {
        if (-not $env:AUDIT_SECRET -and -not (Test-Path -LiteralPath '.env.cloud')) {
            $secret = & node -p "require('node:crypto').randomBytes(48).toString('hex')"
            if ($LASTEXITCODE -ne 0 -or $secret -notmatch '^[a-f0-9]{96}$') { throw '生成审计签名密钥失败。' }
            $env:AUDIT_SECRET = $secret
            $result = & node scripts/cloud-admin.js --check
            if ($LASTEXITCODE -ne 0) { throw '云库预检未通过，未保存审计密钥。' }
            if (($result | Out-String | ConvertFrom-Json).hasAudit) {
                throw '此环境已有审计日志。请提供原 AUDIT_SECRET，不能使用新密钥初始化。'
            }
            $config = [IO.File]::Open((Join-Path (Get-Location) '.env.cloud'), [IO.FileMode]::CreateNew)
            try {
                $bytes = [Text.Encoding]::ASCII.GetBytes("AUDIT_SECRET=$secret`n")
                $config.Write($bytes, 0, $bytes.Length)
            } finally { $config.Dispose() }
        }
        $secure = Read-Host '设置云后台管理员密码（至少 12 位）' -AsSecureString
        $env:ADMIN_BOOTSTRAP_USERNAME = $Username
        $env:ADMIN_BOOTSTRAP_PASSWORD = [System.Net.NetworkCredential]::new('', $secure).Password
        & node --env-file-if-exists=.env.cloud scripts/bootstrap.js --apply
    } else {
        & node --env-file-if-exists=.env.cloud scripts/cloud-admin.js
    }
    if ($LASTEXITCODE -ne 0) { throw "云后台命令失败，退出码 $LASTEXITCODE。" }
} finally {
    foreach ($name in $fields) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    Pop-Location
}
