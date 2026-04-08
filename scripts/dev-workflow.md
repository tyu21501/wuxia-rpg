# 玄冥江湖 v2.0 — 開發工作流程

## 快速啟動

```bash
cd wuxia-rpg
npm install          # 安裝依賴（首次）
npm start            # 啟動遊戲伺服器 → http://localhost:3000
npm run dev          # 開發模式（自動重啟）
```

## 開發工具指令

| 指令 | 用途 |
|------|------|
| `npm test`        | 執行全部 API 自動化測試（需伺服器在線）|
| `npm run health`  | 快速健康檢查（5秒內完成）|
| `npm run debug`   | 完整除錯報告（狀態 + 診斷）|
| `npm run clean 1` | 清除存檔槽位 1（1/2/3/all）|

## 自動化排程（本次 Session 有效，7天後自動到期）

| 排程 ID   | 觸發頻率  | 功能 |
|-----------|-----------|------|
| 2765b119  | 每 30 分鐘 | 健康檢查，異常狀態警示 |
| 9fa74991  | 每天早上 9 點 | 每日開發報告 |
| bec577d5  | 每小時 :17 | API 自動測試巡迴 |

## 專案結構

```
wuxia-rpg/
├── server.js           # 後端核心（AI、API、遊戲邏輯）
├── public/
│   ├── index.html      # 前端主頁（角色創建、6個面板）
│   ├── game.js         # 前端邏輯（UI、戰鬥、任務、NPC）
│   └── style.css       # 主題樣式（深色武俠風、響應式）
├── data/
│   ├── world-state.json # 當前遊戲狀態
│   └── saves/          # 3個存檔槽
├── tests/
│   └── api.test.mjs    # 自動化 API 測試（50+ 斷言）
└── scripts/
    ├── health-check.mjs # 健康檢查
    ├── debug-report.mjs # 除錯報告
    └── clean-saves.mjs  # 清理存檔
```

## 遊戲系統一覽（v2.0）

### 核心機制
- **AI 敘事引擎**：Claude / Ollama (deepseek-r1:32b)
- **10 個地點**：青石鎮→星淵深洞，3層地圖深度
- **8 位 NPC**：各有信任/恐懼度、存活狀態、對話記憶
- **9 種結局**：6正局 + 3壞結局
- **12 個異常事件**：10%～97% 擴散觸發

### 新增系統（v2.0）
- **角色創建**：4種出身 × 4種武學 × 4種性格（64種組合）
- **戰鬥系統**：6種敵人、攻擊/防禦/物品/逃跑、XP升級
- **任務系統**：8個任務、接取/完成、聲望/物品獎勵
- **成就系統**：8個成就、通知提示、成就面板
- **快速行動**：上下文感知的行動建議按鈕
- **自動存檔**：每5分鐘自動存至槽位3

## AI 模型切換

編輯 `.env`：
```
# 使用本地 Ollama（免費）
USE_OLLAMA=true
OLLAMA_MODEL=deepseek-r1:32b

# 使用 Anthropic Claude（需 API Key）
USE_OLLAMA=false
ANTHROPIC_API_KEY=sk-ant-...
```

## 免費資源整合（已使用）

- **Noto Serif TC** (Google Fonts) — 中文宋體字型
- **Animate.css** (CDN) — UI 動畫效果
- **Ollama + DeepSeek R1** — 本地免費 AI 推理
- **Express.js** — 輕量 Web 框架
- **Node.js --watch** — 零依賴熱重啟

## 擴充建議

1. **Ink.js (inkjs)** — 加入結構化分支劇情腳本
2. **Howler.js** — 音效系統（BGM/SFX）
3. **Socket.io** — 實時推送（異常事件即時通知）
4. **Supabase** — 雲端存檔同步
5. **Phaser.js** — 升級為視覺小說引擎
