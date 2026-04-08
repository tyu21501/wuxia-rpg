# ═══════════════════════════════════════════════════════════════
# 玄冥江湖 · Windows 一鍵部署腳本 (PowerShell)
# ═══════════════════════════════════════════════════════════════
# 使用方式：在 D:\wuxia\wuxia-rpg 資料夾開啟 PowerShell 執行
#   .\deploy.ps1
# ═══════════════════════════════════════════════════════════════

param(
    [string]$GitHubUser = "",
    [string]$RepoName = "wuxia-rpg",
    [string]$CommitMsg = ""
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor DarkYellow
Write-Host "║   玄冥江湖 · GitHub 推送腳本            ║" -ForegroundColor DarkYellow
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor DarkYellow
Write-Host ""

# ── 確認在正確目錄 ──────────────────────────────────────────────
if (-not (Test-Path "server.js")) {
    Write-Host "❌ 請在 wuxia-rpg 資料夾內執行此腳本" -ForegroundColor Red
    Write-Host "   cd D:\wuxia\wuxia-rpg" -ForegroundColor Gray
    exit 1
}

# ── 確認 Node.js 語法 ──────────────────────────────────────────
Write-Host "🔍 驗證 server.js 語法..." -ForegroundColor Cyan
node --check server.js
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ server.js 語法錯誤，中止部署" -ForegroundColor Red
    exit 1
}
Write-Host "✅ server.js 語法正確" -ForegroundColor Green

# ── Git 初始化（如果還沒有）──────────────────────────────────
if (-not (Test-Path ".git")) {
    Write-Host ""
    Write-Host "📁 初始化 Git 倉庫..." -ForegroundColor Cyan
    git init
    git branch -M main
    Write-Host "✅ Git 初始化完成" -ForegroundColor Green
}

# ── 設定 GitHub Remote ─────────────────────────────────────────
if ($GitHubUser -eq "") {
    $GitHubUser = Read-Host "請輸入你的 GitHub 帳號名稱"
}

$remoteUrl = "https://github.com/$GitHubUser/$RepoName.git"

# 檢查是否已有 remote
$existingRemote = git remote get-url origin 2>$null
if ($existingRemote) {
    Write-Host "ℹ️  現有 remote: $existingRemote" -ForegroundColor Gray
    $update = Read-Host "是否更新為 $remoteUrl？(y/n)"
    if ($update -eq "y") {
        git remote set-url origin $remoteUrl
    }
} else {
    git remote add origin $remoteUrl
    Write-Host "✅ Remote 設定為: $remoteUrl" -ForegroundColor Green
}

# ── 加入檔案 ──────────────────────────────────────────────────
Write-Host ""
Write-Host "📦 加入檔案至 Git..." -ForegroundColor Cyan
git add .

# 顯示要提交的檔案
Write-Host ""
Write-Host "📋 將要提交的變更：" -ForegroundColor Yellow
git status --short
Write-Host ""

# ── Commit ────────────────────────────────────────────────────
if ($CommitMsg -eq "") {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
    $CommitMsg = "deploy: v1.0.0-beta 更新 [$timestamp]"
}

git commit -m $CommitMsg
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️  沒有新的變更需要提交（或提交失敗）" -ForegroundColor Yellow
}

# ── Push ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "🚀 推送到 GitHub..." -ForegroundColor Cyan
git push -u origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "❌ 推送失敗。可能原因：" -ForegroundColor Red
    Write-Host "   1. GitHub Repo 不存在 → 先在 https://github.com/new 建立" -ForegroundColor Gray
    Write-Host "   2. 需要登入 → 瀏覽器會跳出登入視窗" -ForegroundColor Gray
    Write-Host "   3. 網路問題" -ForegroundColor Gray
    exit 1
}

Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║   ✅ 推送成功！Vercel 正在自動部署...    ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "🌐 GitHub: https://github.com/$GitHubUser/$RepoName" -ForegroundColor Cyan
Write-Host "⏳ Vercel 部署通常需要 30-90 秒" -ForegroundColor Gray
Write-Host ""
Write-Host "若尚未連接 Vercel，請前往：" -ForegroundColor Yellow
Write-Host "   https://vercel.com/new → Import $remoteUrl" -ForegroundColor Cyan
Write-Host ""
