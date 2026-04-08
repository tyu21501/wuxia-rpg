# 玄冥江湖 · 儲存系統架構

> **版本**: v2.0  
> **最後更新**: 2026-04-08

本文件說明玄冥江湖的儲存抽象層（storage.mjs）如何自動在本地開發和 Vercel 生產環境之間切換。

---

## 快速概覽

| 環境 | 模式 | 儲存後端 | 檔案位置 |
|------|------|---------|--------|
| **本地開發** | JSON 檔案 | 本機檔案系統 | `data/` 目錄 |
| **Vercel 部署** | Redis KV | Upstash REST API | KV_REST_API_URL |

---

## 儲存層架構

```
server.js (API 層)
    ↓
storage.mjs (抽象層) ← 自動選擇模式
    ├─→ 本地模式 (localGet/Set/Del/Keys)
    │   └─→ fs 模組 (readFileSync/writeFileSync)
    │       └─→ data/*.json
    │
    └─→ KV 模式 (kvGet/Set/Del/Keys)
        └─→ Upstash REST API
            └─→ Redis 資料庫
```

### 自動模式選擇邏輯

```javascript
// storage.mjs 檔案頂部

const USE_KV = !!(
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
);

if (USE_KV) {
  // Vercel 生產 → 使用 Upstash Redis KV
} else {
  // 本地開發 → 使用 JSON 檔案
}
```

---

## 公開 API

### `storageGet(key)`

讀取資料

```javascript
import { storageGet } from './storage.mjs';

// 讀取遊戲世界狀態
const state = await storageGet('world-state');

// 讀取特定玩家存檔
const save = await storageGet('saves:1');

// 讀取玩家帳號
const user = await storageGet('users:ce4934d2-28d0-4109-a4c5-283a627c8540');
```

**返回值**: `Object | null` — 返回資料或 null（不存在時）

### `storageSet(key, value)`

寫入資料

```javascript
import { storageSet } from './storage.mjs';

// 保存遊戲狀態
await storageSet('world-state', gameState);

// 保存玩家存檔
await storageSet('saves:1', playerState);

// 更新排行榜
await storageSet('leaderboard', leaderboardData);
```

**注意**: 自動原子性（先寫臨時檔案，再重命名）

### `storageExists(key)`

檢查資料是否存在

```javascript
import { storageExists } from './storage.mjs';

if (await storageExists('world-state')) {
  console.log('世界狀態已存在');
}
```

**返回值**: `boolean`

### `storageDel(key)`

刪除資料

```javascript
import { storageDel } from './storage.mjs';

// 刪除舊存檔
await storageDel('saves:3');
```

### `storageKeys(pattern)`

列舉符合模式的所有鍵

```javascript
import { storageKeys } from './storage.mjs';

// 列舉所有存檔（saves:1, saves:2, saves:3）
const saves = await storageKeys('saves:*');

// 列舉所有玩家帳號
const users = await storageKeys('users:*');
```

**返回值**: `string[]` — 鍵列表

### `initializeStorage()`

初始化儲存系統（確保必要目錄存在）

```javascript
import { initializeStorage } from './storage.mjs';

initializeStorage();
// 本地模式：建立 data/ 目錄
// KV 模式：列印 KV 端點
```

### `getStorageStatus()`

取得儲存系統狀態

```javascript
import { getStorageStatus } from './storage.mjs';

const status = getStorageStatus();
console.log(status);
// 輸出：
// {
//   mode: 'local',  // 或 'kv'
//   kv_url: null,   // 或 URL
//   data_dir: '/path/to/data'  // 或 null
// }
```

---

## 鍵命名約定

玄冥江湖使用冒號（`:`）作為鍵分隔符：

```
world-state                # 遊戲世界狀態（單鍵）
leaderboard               # 全球排行榜（單鍵）

saves:1                   # 玩家存檔 1
saves:2                   # 玩家存檔 2
saves:3                   # 玩家存檔 3

users:{uuid}              # 玩家帳號（用 UUID）
```

### 本地儲存映射

冒號自動轉換為目錄分隔符：

```
鍵：users:ce4934d2-28d0-4109-a4c5-283a627c8540
↓
檔案：data/users/ce4934d2-28d0-4109-a4c5-283a627c8540.json
```

### KV 儲存映射

KV 使用原始鍵（不轉換）：

```
鍵：users:ce4934d2-28d0-4109-a4c5-283a627c8540
↓
Redis 鍵：users:ce4934d2-28d0-4109-a4c5-283a627c8540
```

---

## 本地模式詳細說明

### 檔案結構

```
wuxia-rpg/
└── data/
    ├── world-state.json
    ├── leaderboard.json
    ├── saves/
    │   ├── save_1.json
    │   ├── save_2.json
    │   └── save_3.json
    └── users/
        ├── ce4934d2-28d0-4109-a4c5-283a627c8540.json
        └── ... (更多玩家)
```

### 原子性寫入

本地模式使用兩步驟確保資料完整性：

```javascript
// storage.mjs 的 localSet 實作

1. 寫入臨時檔案：data/world-state.json.tmp
2. 原子重命名：data/world-state.json.tmp → data/world-state.json
```

如果 Node.js 程序在寫入中途崩潰，原始檔案不會損壞。

### 性能

- **讀取**: < 1ms（磁碟速度，通常 SSD）
- **寫入**: < 10ms（包含 fsync）
- **列舉**: < 50ms（目錄掃描）

---

## KV 模式詳細說明

### Upstash Redis KV

Upstash 是無伺服器 Redis 服務：

- **API**: 支援 REST 和 CLI
- **通訊**: HTTPS（安全，無需 TLS 設定）
- **認證**: Bearer Token（簡潔，無密碼複雜性）
- **免費方案**: 10,000 個指令/月、100MB 儲存

### REST API 呼叫範例

```bash
# 讀取鍵
curl -X GET https://your-url.upstash.io/get/world-state \
  -H "Authorization: Bearer token" | jq

# 寫入鍵
curl -X POST https://your-url.upstash.io/set/world-state \
  -H "Authorization: Bearer token" \
  -H "Content-Type: application/json" \
  -d '{"data": {"players": 100}}'

# 刪除鍵
curl -X POST https://your-url.upstash.io/del/world-state \
  -H "Authorization: Bearer token"

# 列舉鍵（SCAN）
curl -X GET https://your-url.upstash.io/keys/saves:* \
  -H "Authorization: Bearer token" | jq
```

### 性能

- **讀取**: 50-150ms（網路延遲 + Redis 處理）
- **寫入**: 50-150ms（同上）
- **列舉**: 100-200ms（SCAN 操作）

延遲來自網路往返，不是計算。

### 成本監控

Upstash 免費方案：

- **限額**: 10,000 指令/月
- **玄冥江湖估計**: 
  - 讀取存檔: 1 指令
  - 保存狀態: 1 指令
  - 列舉存檔: 1 指令
  - **每玩家每小時**: ~10-20 指令
  - **月使用量**: ~3,000-5,000 指令（20 個活躍玩家）

足夠輕中度使用。

---

## 錯誤處理

### 讀取失敗

```javascript
const state = await storageGet('world-state');
if (!state) {
  console.warn('資料不存在，使用預設值');
  return DEFAULT_STATE;
}
```

### 寫入失敗（本地）

```javascript
try {
  await storageSet('world-state', state);
} catch (e) {
  console.error('[Storage] 寫入失敗:', e.message);
  // 發送告警、回退等
}
```

### KV 連接失敗

```javascript
// storage.mjs 自動記錄錯誤
// 驗證：
// 1. KV_REST_API_URL 和 KV_REST_API_TOKEN 正確
// 2. 網路連接正常
// 3. Upstash 資料庫未超額

// 調試：
curl https://your-url.upstash.io/ping \
  -H "Authorization: Bearer token"
```

---

## 遷移指南

### 從本地到 KV（生產部署）

1. **在本地開發**：使用 JSON 檔案
2. **部署前**：
   ```bash
   # 讀取本地檔案
   cat data/world-state.json
   ```
3. **在 Vercel 設定 KV 環境變數**：
   ```
   KV_REST_API_URL=...
   KV_REST_API_TOKEN=...
   ```
4. **重新部署**：
   ```bash
   vercel --prod
   ```
5. **（可選）遷移資料**：
   ```bash
   # 撰寫遷移腳本，讀取本地 JSON，寫入 KV
   ```

### 從 KV 備份到本地

```javascript
// backup.mjs
import { storageKeys, storageGet } from './storage.mjs';
import { writeFileSync, mkdirSync } from 'fs';

const patterns = ['world-state', 'saves:*', 'users:*', 'leaderboard'];
for (const pattern of patterns) {
  const keys = await storageKeys(pattern);
  for (const key of keys) {
    const data = await storageGet(key);
    const path = `backup/${key.replace(/:/g, '_')}.json`;
    mkdirSync('backup', { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
  }
}
```

---

## 整合範例

### 在 server.js 中使用

```javascript
import express from 'express';
import { storageGet, storageSet, initializeStorage } from './storage.mjs';

const app = express();

// 初始化（啟動時）
initializeStorage();

// 讀取狀態
app.get('/api/state', async (req, res) => {
  const state = await storageGet('world-state');
  res.json(state || {});
});

// 保存狀態
app.post('/api/save', async (req, res) => {
  await storageSet('world-state', req.body.state);
  res.json({ ok: true });
});

app.listen(3000);
```

---

## 故障排除

### 本地模式：檔案權限錯誤

```
Error: EACCES: permission denied, open 'data/world-state.json'
```

**解決方案**:
```bash
chmod 755 wuxia-rpg/data
chmod 644 wuxia-rpg/data/*.json
```

### KV 模式：連接超時

```
Error: fetch timeout
```

**原因**: 網路問題或 Upstash 服務異常

**解決方案**:
1. 檢查網路連接
2. 在 Upstash 主頁檢查資料庫狀態
3. 重試（自動重試邏輯見 server.js）

### KV 模式：Token 過期

```
[Storage] KV GET 失敗 (401): Unauthorized
```

**原因**: Token 已過期或無效

**解決方案**:
1. 在 Upstash 主頁重新產生 Token
2. 更新 Vercel 環境變數
3. 重新部署

---

## 最佳實踐

1. **開發時使用本地**：迅速反覆運算，無外部依賴
2. **生產使用 KV**：確保資料持久化和擴展性
3. **鍵命名統一**：使用冒號分隔符便於管理
4. **錯誤日誌**：始終捕捉和記錄儲存錯誤
5. **定期備份**：在 Upstash 啟用快照功能

---

## 相關文件

- [DEPLOY.md](./DEPLOY.md) — 完整部署指南
- [server.js](./server.js) — API 實作
- [storage.mjs](./storage.mjs) — 儲存模組原始碼
- [.env.example](./.env.example) — 環境變數範本

---

**更新日期**: 2026-04-08
