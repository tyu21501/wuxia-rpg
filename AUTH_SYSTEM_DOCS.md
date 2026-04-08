# 玄冥江湖 · 帳號系統 & 排行榜 API 文檔

## 概述
本次實作增加了兩個重要系統供商業上市使用：
1. **玩家帳號系統** — 用戶註冊、登錄、JWT 認證、雲端存檔
2. **全球排行榜系統** — 分數計算、排名、排行榜查詢

---

## 帳號系統

### 目錄結構
- `/data/users/` — 存儲用戶帳號檔案（`{uuid}.json`）
- `/data/leaderboard.json` — 全球排行榜資料

### 用戶資料結構
```json
{
  "id": "uuid-string",
  "username": "玩家名稱",
  "passwordHash": "bcrypt hash",
  "email": "user@example.com",
  "createdAt": "2026-04-08T12:34:56Z",
  "saves": [null, null, null]  // 3 個雲端存檔槽
}
```

### 雲端存檔結構
```json
{
  "data": { /* 完整遊戲狀態 */ },
  "name": "玩家名 · 第15天",
  "time": "2026-04-08 20:30:45",
  "day": 15
}
```

---

## 認證 API 端點

### 1. 用戶註冊
**請求：**
```
POST /api/auth/register
Content-Type: application/json

{
  "username": "玩家名稱",
  "password": "密碼（最少 6 字元）",
  "email": "user@example.com"
}
```

**驗證規則：**
- 用戶名：3-20 字元，不可重複
- 密碼：至少 6 字元，使用 bcrypt 加密（rounds: 10）
- 郵箱：必填項

**成功回應 (200)：**
```json
{
  "success": true,
  "token": "eyJhbGc...",
  "user": {
    "id": "uuid",
    "username": "玩家名",
    "email": "user@example.com"
  }
}
```

**錯誤：**
- 400：缺少欄位或格式不正確
- 409：用戶名已存在

---

### 2. 用戶登錄
**請求：**
```
POST /api/auth/login
Content-Type: application/json

{
  "username": "玩家名稱",
  "password": "密碼"
}
```

**成功回應 (200)：**
```json
{
  "success": true,
  "token": "eyJhbGc...",
  "user": {
    "id": "uuid",
    "username": "玩家名",
    "email": "user@example.com"
  }
}
```

**錯誤：**
- 401：用戶不存在或密碼錯誤

---

### 3. 獲取認證用戶信息
**請求：**
```
GET /api/auth/me
Authorization: Bearer {token}
```

**成功回應 (200)：**
```json
{
  "user": {
    "id": "uuid",
    "username": "玩家名",
    "email": "user@example.com",
    "createdAt": "2026-04-08T12:34:56Z"
  }
}
```

**錯誤：**
- 401：缺少或無效的令牌
- 403：令牌已過期
- 404：用戶不存在

---

### 4. 雲端存檔保存
**請求：**
```
POST /api/auth/save-cloud/:slot
Authorization: Bearer {token}
```

**參數：**
- `:slot` — 存檔槽（1、2 或 3）

**說明：** 將當前遊戲狀態保存到用戶的雲端存檔槽

**成功回應 (200)：**
```json
{ "success": true }
```

**錯誤：**
- 400：無效的槽位
- 401/403：認證失敗
- 404：用戶不存在

---

### 5. 雲端存檔讀取
**請求：**
```
POST /api/auth/load-cloud/:slot
Authorization: Bearer {token}
```

**參數：**
- `:slot` — 存檔槽（1、2 或 3）

**成功回應 (200)：**
```json
{
  "success": true,
  "state": { /* 遊戲狀態 */ }
}
```

**錯誤：**
- 400：無效的槽位
- 401/403：認證失敗
- 404：用戶不存在或存檔不存在

---

## 排行榜系統

### 排行榜資料結構
```json
{
  "entries": [
    {
      "username": "玩家名",
      "score": 1350,
      "ending_id": "hero_ending",
      "days": 25,
      "achievements": 8,
      "timestamp": "2026-04-08T15:30:00Z"
    }
  ]
}
```

### 分數公式
```
分數 = (成就數 × 100) + (任務完成數 × 50) + (存活天數 × 10) - (異常擴散 × 2)
```

**說明：**
- 成就數 × 100：每個成就獲 100 分
- 任務數 × 50：每個完成的任務獲 50 分
- 天數 × 10：每活著一天獲 10 分
- 異常擴散 × 2：每 1 點異常擴散扣 2 分（難度懲罰）

---

### 1. 提交遊戲分數
**請求：**
```
POST /api/leaderboard/submit
Authorization: Bearer {token}  // 可選，不提供則為訪客
Content-Type: application/json

{
  "ending_id": "hero_ending",
  "days_survived": 25,
  "achievements_count": 8,
  "quests_completed": 6,
  "anomaly_spread": 45
}
```

**參數說明：**
- `ending_id` — 遊戲結局 ID（如 `hero_ending`, `merged_ending` 等）
- `days_survived` — 存活天數
- `achievements_count` — 解鎖的成就數
- `quests_completed` — 完成的任務數
- `anomaly_spread` — 最終異常擴散值

**成功回應 (200)：**
```json
{
  "success": true,
  "score": 1350,
  "rank": 5
}
```

**說明：**
- 無帳號玩家顯示為 `(訪客)`
- 排行榜維持前 100 名
- 每次新提交自動計算排名

---

### 2. 查看排行榜
**請求：**
```
GET /api/leaderboard
```

**成功回應 (200)：**
```json
{
  "entries": [
    {
      "rank": 1,
      "username": "龍虎山高手",
      "score": 2100,
      "ending_id": "hero_ending",
      "days": 40,
      "achievements": 9,
      "timestamp": "2026-04-08T10:00:00Z"
    },
    ...
  ],
  "total": 47
}
```

**說明：**
- 回傳前 20 名排行
- `total` — 排行榜中的總條目數
- 自動按分數降序排列

---

## 技術細節

### JWT 令牌
- **算法：** HS256
- **有效期：** 7 天
- **密鑰：** `process.env.JWT_SECRET` 或預設 `wuxia-secret-key-change-in-prod`
  - 生產環境必須設定環境變數 `JWT_SECRET`

### 密碼安全
- **加密方式：** bcrypt (rounds: 10)
- **比對流程：** `bcrypt.compare()` 異步驗證

### 向下相容性
- 所有新端點與現有無帳號遊玩相容
- 舊版 `/api/save` 和 `/api/load` 仍可使用（本地存檔）
- 排行榜可接受訪客提交（無 JWT）

---

## 部署檢查清單

- [ ] 設定 `JWT_SECRET` 環境變數（生產環境）
- [ ] 驗證 `/data/users/` 目錄權限
- [ ] 驗證 `/data/leaderboard.json` 初始化
- [ ] 運行 `node --check server.js`
- [ ] 運行認證測試套件：`node test-auth.mjs`
- [ ] 確認 bcrypt、jsonwebtoken、uuid 依賴已安裝

---

## 使用示例（前端集成）

### 註冊流程
```javascript
const res = await fetch('/api/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password, email })
});
const { token } = await res.json();
localStorage.setItem('jwt_token', token);
```

### 已認證 API 呼叫
```javascript
const token = localStorage.getItem('jwt_token');
const res = await fetch('/api/auth/me', {
  headers: { 'Authorization': `Bearer ${token}` }
});
```

### 提交分數
```javascript
const res = await fetch('/api/leaderboard/submit', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    ending_id: state.ending_id,
    days_survived: state.world.day,
    achievements_count: state.achievements.length,
    quests_completed: state.quests.completed.length,
    anomaly_spread: state.world.anomaly_spread
  })
});
const { score, rank } = await res.json();
```

---

## 實裝概述

| 功能 | 行數 | 檔案 |
|------|------|------|
| 帳號系統（助函式+端點） | 165 | server.js |
| 排行榜系統（助函式+端點） | 58 | server.js |
| **總計新增** | **223** | **server.js** |
| 最終檔案 | **1584** | **server.js** |

