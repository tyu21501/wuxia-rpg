# 🚀 玄冥江湖 · 立即部署指南

> **平台**: GitHub + Vercel + Upstash Redis  
> **預計時間**: 20-30 分鐘  
> **版本**: v1.0.0-beta

---

## 總覽步驟

```
① Upstash → 建立 Redis Database → 取得 URL + Token
② GitHub  → 建立 Repo → 推送程式碼
③ Vercel  → 匯入 GitHub Repo → 設定環境變數 → 部署
```

---

## STEP 1：Upstash Redis 設定（5 分鐘）

### 1.1 建立 Redis Database

1. 前往 **https://console.upstash.com/**
2. 點擊 **「Create Database」**
3. 填寫設定：
   - **Name**: `wuxia-rpg`
   - **Type**: `Regional`（選 `ap-northeast-1` 東京，距台灣最近）
   - **TLS**: 開啟 ✅
4. 點擊 **「Create」**

### 1.2 取得連線資訊

建立完成後，在 Database 頁面找到：

```
REST API 區塊：
  UPSTASH_REDIS_REST_URL  = https://xxxxxx.upstash.io
  UPSTASH_REDIS_REST_TOKEN = AXxx...（很長的 token）
```

⚠️ **記下這兩個值，下面 Vercel 設定會用到**

---

## STEP 2：GitHub 建立 Repo（5 分鐘）

### 2.1 建立 GitHub Repository

1. 前往 **https://github.com/new**
2. 填寫：
   - **Repository name**: `wuxia-rpg`
   - **Visibility**: `Public`（Vercel 免費方案需要，或選 Private 需升級）
   - 不要勾選 Initialize with README
3. 點擊 **「Create repository」**

### 2.2 在本機初始化並推送（在 PowerShell/終端機執行）

**開啟 Windows PowerShell 或命令提示字元**，切換到專案資料夾：

```powershell
# 切換到 wuxia-rpg 資料夾
cd D:\wuxia\wuxia-rpg

# 如果 .git 資料夾已存在但損壞，先刪除
Remove-Item -Recurse -Force .git -ErrorAction SilentlyContinue

# 初始化 Git
git init
git branch -M main

# 設定 Git 使用者（如果還沒設定）
git config user.email "你的email@gmail.com"
git config user.name "你的名字"

# 加入所有檔案（.gitignore 會自動排除 node_modules、data/ 等）
git add .
git status

# 確認暫存清單正確後，建立第一個 Commit
git commit -m "feat: 玄冥江湖 v1.0.0-beta 首次部署

- 完整後端 API (31 端點)
- 玩家帳號系統、排行榜、成就
- 12 任務、9 NPC、11 結局、15 異常事件
- Upstash KV 儲存抽象層
- i18n 多語言支援"

# 連結到 GitHub（把 YOUR_USERNAME 換成你的 GitHub 帳號）
git remote add origin https://github.com/YOUR_USERNAME/wuxia-rpg.git

# 推送
git push -u origin main
```

---

## STEP 3：Vercel 部署（10 分鐘）

### 3.1 匯入 GitHub Repository

1. 前往 **https://vercel.com/new**
2. 點擊 **「Import Git Repository」**
3. 找到 `wuxia-rpg`，點擊 **「Import」**

### 3.2 設定 Framework

- **Framework Preset**: 選 `Other`（不是 Next.js）
- **Root Directory**: 保持 `./`（不用改）
- **Build Command**: `npm install`（或留空）
- **Output Directory**: 留空

點擊 **「Environment Variables」** 展開設定環境變數 ↓

### 3.3 設定環境變數（重要！）

在 **Environment Variables** 區塊，逐一新增以下變數：

| 變數名稱 | 值 | 說明 |
|---------|---|------|
| `KV_REST_API_URL` | `https://xxxxxx.upstash.io` | Upstash REST URL |
| `KV_REST_API_TOKEN` | `AXxx...` | Upstash Token |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Claude API（可選，沒有會用內建敘事） |
| `JWT_SECRET` | 隨機32字元 | 玩家帳號加密 |
| `NODE_ENV` | `production` | 生產模式 |

**生成 JWT_SECRET（在 PowerShell 執行）：**
```powershell
# 產生隨機 64 字元
-join ((1..64) | ForEach-Object { [char](Get-Random -Minimum 33 -Maximum 127) })
```

或直接用這個範例（**請自行修改**）：
```
JWT_SECRET=wuxia-rpg-2026-secret-change-this-to-something-random-!!
```

### 3.4 部署

設定完成後點擊 **「Deploy」**

等待 1-2 分鐘，部署完成後你會看到：
```
✅ Production Deployment Successful!
https://wuxia-rpg-xxxx.vercel.app
```

---

## STEP 4：驗證部署（5 分鐘）

### 4.1 測試 API

在瀏覽器開啟（把網址換成你的 Vercel URL）：

```
https://wuxia-rpg-xxxx.vercel.app/api/version
```

應該看到：
```json
{
  "version": "1.0.0-beta",
  "quest_count": 12,
  "ending_count": 11,
  ...
}
```

### 4.2 測試遊戲

```
https://wuxia-rpg-xxxx.vercel.app/
```

試玩遊戲，確認：
- ✅ 可以創建角色
- ✅ 可以執行行動（AI 敘事或備用敘事）
- ✅ 可以登入/註冊（Upstash KV 儲存）
- ✅ 可以提交排行榜

---

## 後續自動部署

GitHub 連接 Vercel 後，之後每次：

```powershell
cd D:\wuxia\wuxia-rpg
git add .
git commit -m "fix: 更新描述"
git push
```

Vercel 會**自動偵測並重新部署**，通常 30-60 秒完成。

---

## 常見問題

### ❓ 部署後遊戲資料不見了？
Vercel 是無狀態環境，資料存在 Upstash Redis。確認：
- `KV_REST_API_URL` 環境變數已設定
- `KV_REST_API_TOKEN` 環境變數已設定
- Upstash 控制台確認 Database 有收到請求

### ❓ 函數 Timeout？
在 `vercel.json` 中 `maxDuration` 已設為 30 秒。Upstash 亞洲區節點延遲約 50-100ms，應足夠。

### ❓ ANTHROPIC_API_KEY 沒有怎麼辦？
沒有 API Key 時，遊戲會自動切換到 `narrative-engine.mjs` 內建敘事庫，仍可正常遊玩，只是故事不會每次不同。

### ❓ 如何查看錯誤日誌？
- Vercel Dashboard → 你的專案 → Functions → 點擊失敗的請求
- 或安裝 Vercel CLI：`npm i -g vercel` → `vercel logs`

---

## 你的部署清單

- [ ] Upstash 建立 Redis Database
- [ ] 記下 `KV_REST_API_URL` 和 `KV_REST_API_TOKEN`
- [ ] GitHub 建立 `wuxia-rpg` Repo
- [ ] 本機執行 `git init` + `git push`
- [ ] Vercel 匯入 GitHub Repo
- [ ] 設定 5 個環境變數
- [ ] 點擊 Deploy
- [ ] 測試 `/api/version` 回應正常
- [ ] 試玩一局確認功能正常

---

**完成後你的遊戲將在全球可存取！🎉**

> 部署完成後把 Vercel URL 告訴我，我可以幫你更新遊戲內的連結和 CLAUDE.md。
