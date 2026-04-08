/**
 * 玄冥江湖 健康檢查腳本
 * 執行：npm run health
 * 用途：快速確認伺服器狀態，自動化監控用
 */

const BASE = 'http://localhost:3000';
const startTime = Date.now();

async function check(name, fn) {
  try {
    const result = await fn();
    console.log(`✓ ${name}`);
    return result;
  } catch (e) {
    console.error(`✗ ${name} — ${e.message}`);
    return null;
  }
}

async function main() {
  console.log('\n玄冥江湖 健康檢查 —', new Date().toLocaleString('zh-TW'));
  console.log('─'.repeat(44));

  // 1. 伺服器連線
  const status = await check('伺服器連線', async () => {
    const res = await fetch(`${BASE}/api/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    if (!d.ok) throw new Error('ok 非 true');
    return d;
  });

  if (!status) {
    console.error('\n❌ 伺服器無回應，請確認已執行 npm start');
    process.exit(1);
  }

  // 2. 遊戲狀態
  await check('遊戲狀態 API', async () => {
    const res = await fetch(`${BASE}/api/state`);
    const d = await res.json();
    if (!d.player || !d.world) throw new Error('狀態結構不完整');
    return d;
  });

  // 3. 地圖資料
  await check('地圖 10個地點', async () => {
    const res = await fetch(`${BASE}/api/state`);
    const d = await res.json();
    if (Object.keys(d.map).length !== 10) throw new Error(`地點數量不符：${Object.keys(d.map).length}`);
  });

  // 4. NPC 資料
  await check('NPC 8位人物', async () => {
    const res = await fetch(`${BASE}/api/state`);
    const d = await res.json();
    if (Object.keys(d.npcs).length !== 8) throw new Error(`NPC數量不符：${Object.keys(d.npcs).length}`);
  });

  // 5. 任務系統
  await check('任務系統', async () => {
    const res = await fetch(`${BASE}/api/quests`);
    const d = await res.json();
    if (!Array.isArray(d.available)) throw new Error('任務格式不正確');
  });

  // 6. 存檔清單
  await check('存檔系統', async () => {
    const res = await fetch(`${BASE}/api/saves`);
    const d = await res.json();
    if (!Array.isArray(d) || d.length !== 3) throw new Error('存檔槽位不足');
  });

  // 7. 成就系統
  await check('成就系統', async () => {
    const res = await fetch(`${BASE}/api/achievements`);
    const d = await res.json();
    if (!d.all?.length) throw new Error('成就資料缺失');
  });

  // 8. 靜態資源
  await check('前端 HTML 存在', async () => {
    const res = await fetch(`${BASE}/`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  await check('前端 JS 存在', async () => {
    const res = await fetch(`${BASE}/game.js`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  await check('前端 CSS 存在', async () => {
    const res = await fetch(`${BASE}/style.css`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  const elapsed = Date.now() - startTime;
  console.log('─'.repeat(44));
  console.log(`完成（${elapsed}ms）— 第${status.day}天 異常${status.anomaly_spread}% 已完成任務${status.quests_completed || 0}`);
  console.log();
}

main().catch(e => {
  console.error('健康檢查失敗：', e.message);
  process.exit(1);
});
