# 玄冥江湖 · 部署指南

> **版本**: v2.0  
> **最後更新**: 2026-04-08

本文件說明如何在本地開發和 Vercel 生產環境部署玄冥江湖遊戲伺服器。

---

## 目錄

1. [本地開發](#本地開發)
2. [Vercel 部署](#vercel-部署)
3. [Upstash Redis KV 設定](#upstash-redis-kv-設定)
4. [環境變數參考](#環境變數參考)
5. [儲存系統（本地 vs KV）](#儲存系統本地-vs-kv)
6. [故障排除](#故障排除)

---

## 本地開發

### 前置要求

- Node.js ≥ 18.x
- npm ≥ 9.x

### 快速啟動

```bash
# 1. 複製 .env.example 為 .env
cp .env.example .env

# 2. 填入 AI API 設定（選擇一個）
#    a) Anthropic Claude（推薦）
#       ANTHROPIC_API_KEY=sk-ant-your-key
#    b) Ollama 本地（需 GPU）
#       USE_OLLAMA=true
#       OLLAMA_BASE_URL=http://localhost:11434/v1
#    c) 不設定（使用內建敘事庫，無需 API）

# 3. 安裝依賴
npm install

# 4. 啟動開發伺服器
npm start

# 伺服器運行於 http://localhost:3000
```

### 本地開發的儲存方式

本地開發 **自動使用 JSON 檔案存儲**，不需要設定 KV 環境變數：

```
data/
├── world-state.json      # 遊戲世界狀態
├── leaderboard.json      # 排行榜
├── saves/
│   ├── save_1.json       # 玩家存檔 1
│   └── save_2.json
└── users/
    └── {uuid}.json       # 玩家帳號資料
```

所有檔案會自動在啟動時初始化。

### 執行測試

```bash
# 執行 API 測試套件
npm test

# 單語法檢查
node --check server.js
node --check storage.mjs
```

### 健康檢查

```bash
# 檢查伺服器 + 儲存層 + CSS 合規性
node scripts/team/team-run.js health
```

---

## Vercel 部署

### 前置要求

1. [Vercel 帳號](https://vercel.com/signup)（免費）
2. GitHub/GitLab/Bitbucket 帳號（用於連接 Git 倉庫）
3. [Upstash Redis KV 帳號](https://upstash.com/register)（免費）— **建議**

### 部署步驟

#### 步驟 1：準備 Git 倉庫

```bash
# 確保專案已 git 初始化
cd wuxia-rpg
git init
git add .
git commit -m "Initial commit: wuxia-rpg v2.0"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

#### 步驟 2：安裝 Vercel CLI 並部署

```bash
# 全域安裝 Vercel CLI
npm install -g vercel

# 登入 Vercel
vercel login

# 部署到 Vercel（第一次會自動建立專案）
vercel

# 出現提示時選擇：
# - Link to existing project? → No
# - What's your project's name? → wuxia-rpg
# - In which directory is your code? → .
# - Want to override the settings? → No
```

部署完成後，你會得到一個 URL，例如：`https://wuxia-rpg-abc123.vercel.app`

#### 步驟 3：設定環境變數

在 Vercel 儀表板設定環境變數：

1. 前往 [https://vercel.com/dashboard](https://vercel.com/dashboard)
2. 選擇 `wuxia-rpg` 專案
3. 進入 **Settings** → **Environment Variables**
4. 添加以下環境變數：

```
# 必要
NODE_ENV=production
FRONTEND_URL=https://wuxia-rpg-abc123.vercel.app
API_URL=https://wuxia-rpg-abc123.vercel.app/api

# 選擇一個 AI 引擎
# 選項 A：Anthropic Claude（推薦）
ANTHROPIC_API_KEY=sk-ant-your-key
# ANTHROPIC_MODEL=claude-sonnet-4-6

# 選項 B：Ollama（本地 GPU，不適合 Vercel）
# USE_OLLAMA=false

# 選項 C：內建敘事庫（無需 API，推薦）
# ANTHROPIC_API_KEY=（留空）

# JWT 安全金鑰（Vercel 部署必要）
JWT_SECRET=your_very_long_random_secret_here_min_32_chars
SESSION_SECRET=another_random_secret_for_sessions_min_32_chars

# Upstash Redis KV（建議，見下節）
KV_REST_API_URL=https://your-kv-url.upstash.io
KV_REST_API_TOKEN=your-kv-token
```

#### 步驟 4：重新部署

在 Vercel 儀表板點擊 **Redeploy** 以使用新環境變數。

---

## Upstash Redis KV 設定

### 為什麼需要 KV？

Vercel Serverless Functions 沒有持久化檔案系統。`/tmp` 目錄會被重置。Upstash Redis KV 提供：

- **無伺服器儲存**：自動擴展，無需管理基礎設施
- **免費方案**：每月 10,000 個指令、10,000 個連接
- **REST API**：支援 HTTP，不需要 Redis 用戶端
- **自動備份**：支援快照和持久化

### 步驟 1：建立 Upstash 帳號

1. 前往 [https://upstash.com/register](https://upstash.com/register)
2. 用 Google / GitHub 登入
3. 同意服務條款並建立帳號

### 步驟 2：建立 Redis 資料庫

1. 登入 [Upstash 主頁](https://console.upstash.com/)
2. 點擊 **Create Database**
3. 設定：
   - **Name**: `wuxia-rpg-kv`
   - **Region**: 選擇離你最近的地區（推薦 `ap-northeast-1` 如果在日本，`us-east-1` 如果在美國）
   - **Type**: Redis
   - **Database Type**: Free（免費方案足夠）
4. 點擊 **Create**

### 步驟 3：取得 REST API 認證

1. 資料庫建立後，點擊進入
2. 選擇 **REST API** 分頁
3. 複製：
   - **Endpoint**: `https://your-url.upstash.io`
   - **Token**: `your-token` 

這些就是 `KV_REST_API_URL` 和 `KV_REST_API_TOKEN`。

### 步驟 4：在 Vercel 添加環境變數

```
KV_REST_API_URL=https://your-url.upstash.io
KV_REST_API_TOKEN=your-token
```

### 驗證 KV 連接

部署後，伺服器日誌會顯示：

```
[Storage] 模式：Upstash Redis KV
[Storage] API 端點: https://your-url.upstash.io
```

### KV 儲存鍵設計

玄冥江湖使用以下鍵命名約定：

```
world-state           # 遊戲世界狀態
saves:1              # 玩家存檔（槽 1-3）
saves:2
saves:3
users:{uuid}         # 玩家帳號
leaderboard          # 全球排行榜
```

---

## 環境變數參考

### 本地開發（.env）

```env
# 【必要】
PORT=3000
NODE_ENV=development

# 【AI 引擎】選擇一個

# 選項 A：Anthropic Claude（推薦品質最佳）
ANTHROPIC_API_KEY=sk-ant-your-key
ANTHROPIC_MODEL=claude-sonnet-4-6

# 選項 B：Ollama 本地
# USE_OLLAMA=true
# OLLAMA_BASE_URL=http://localhost:11434/v1
# OLLAMA_MODEL=deepseek-r1:8b

# 選項 C：內建敘事庫（無 API，推薦快速測試）
# ANTHROPIC_API_KEY=(留空)

# 【安全】
JWT_SECRET=dev-secret-key
SESSION_SECRET=dev-session-secret

# 【URL】
FRONTEND_URL=http://localhost:3000
API_URL=http://localhost:3000/api

# 【儲存】（本地開發自動使用 JSON，不需設定）
# KV_REST_API_URL=
# KV_REST_API_TOKEN=
```

### Vercel 部署（環境變數）

```
NODE_ENV=production
FRONTEND_URL=https://wuxia-rpg-abc123.vercel.app
API_URL=https://wuxia-rpg-abc123.vercel.app/api
ANTHROPIC_API_KEY=sk-ant-your-key
ANTHROPIC_MODEL=claude-sonnet-4-6
JWT_SECRET=(強隨機金鑰，≥32 字元)
SESSION_SECRET=(強隨機金鑰，≥32 字元)
KV_REST_API_URL=https://your-url.upstash.io
KV_REST_API_TOKEN=your-token
```

---

## 儲存系統（本地 vs KV）

### 儲存層自動選擇邏輯

```javascript
// storage.mjs 自動決定使用哪種模式

if (KV_REST_API_URL && KV_REST_API_TOKEN) {
  // Vercel 生產環境 → 使用 Upstash Redis KV
  console.log('[Storage] 模式：Upstash Redis KV');
} else {
  // 本地開發 → 使用 JSON 檔案
  console.log('[Storage] 模式：本地 JSON 檔案');
}
```

### 本地模式（dev）

- **位置**: `data/` 目錄
- **檔案類型**: JSON
- **優勢**:
  - 無需額外服務
  - 易於檢視和調試
  - 無網路延遲
- **缺點**:
  - 不支援無伺服器架構
  - 單一伺服器執行個體

### KV 模式（production）

- **位置**: Upstash Redis KV
- **通訊方式**: REST API over HTTPS
- **優勢**:
  - 無伺服器友善
  - 自動擴展
  - 免費方案足夠
  - 支援多個並發執行個體
- **缺點**:
  - 需要網路連接
  - 輕微 API 延遲（通常 <100ms）

### 遷移本地資料到 KV

如需將本地開發的資料遷移到 Vercel：

```bash
# 1. 在本地讀取 JSON
cat data/world-state.json

# 2. 透過 REST API 寫入 KV
curl -X POST https://your-url.upstash.io/set/world-state \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"data": "..."}'
```

或撰寫遷移腳本（見 `scripts/` 目錄）。

---

## 故障排除

### 1. 本地啟動失敗

```
Error: Cannot find module 'express'
```

**解決方案**:
```bash
npm install
```

### 2. Vercel 部署失敗（Build Error）

```
npm ERR! Could not resolve dependency
```

**解決方案**:
```bash
# 確保 package.json 完整
npm install
npm test          # 驗證
git add package-lock.json
git commit -m "Update dependencies"
git push origin main
```

### 3. KV 連接失敗

```
[Storage] KV GET 失敗 (401): Unauthorized
```

**原因**: 環境變數設定錯誤或 Token 過期

**解決方案**:
1. 檢查 `KV_REST_API_URL` 和 `KV_REST_API_TOKEN` 是否正確
2. 在 Upstash 主頁重新產生 Token
3. 在 Vercel 更新環境變數
4. 重新部署：`vercel --prod`

### 4. 儲存在 Vercel 上不持久化

```
存檔讀不到之前儲存的資料
```

**原因**: 忘記設定 KV 環境變數，回到本地檔案模式（但檔案不會持久）

**解決方案**:
1. 設定 `KV_REST_API_URL` 和 `KV_REST_API_TOKEN`
2. 重新部署
3. 驗證日誌：`vercel logs wuxia-rpg`

### 5. 檢查部署狀態

```bash
# 查看 Vercel 日誌
vercel logs wuxia-rpg --tail

# 檢查儲存狀態
curl https://wuxia-rpg-abc123.vercel.app/api/state | jq .

# 查看環境變數
vercel env list
```

---

## 最佳實踐

1. **本地開發**：使用內建敘事庫（無需 API），快速迭代
2. **生產部署**：使用 Upstash Redis KV 保證資料持久化
3. **安全金鑰**：使用強隨機金鑰（≥32 字元），避免重複使用
4. **定期備份**：在 Upstash 主頁啟用資料庫快照
5. **監控成本**：Upstash 免費方案每月 10,000 個指令足夠輕中度使用

---

## 相關文件

- [server.js](./server.js) — REST API 實作
- [storage.mjs](./storage.mjs) — 儲存抽象層
- [vercel.json](./vercel.json) — Vercel 部署設定
- [.env.example](./.env.example) — 環境變數範本

---

**問題回報**: 如遇到部署問題，請檢查 `vercel logs` 和儲存系統狀態。
