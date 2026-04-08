/**
 * 玄冥江湖 除錯報告腳本
 * 執行：npm run debug
 * 用途：生成完整遊戲狀態診斷報告
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = join(__dirname, '..');

function readJSON(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null;
  } catch { return null; }
}

function section(title) {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(50));
}

function row(label, value, warn = false) {
  const icon = warn ? '⚠' : ' ';
  console.log(`${icon} ${label.padEnd(28)} ${String(value)}`);
}

async function main() {
  console.log('\n玄冥江湖 除錯報告');
  console.log('生成時間：', new Date().toLocaleString('zh-TW'));

  // ── 1. 檔案結構 ──
  section('1. 專案檔案結構');
  const requiredFiles = [
    'server.js', 'package.json', '.env',
    'public/index.html', 'public/game.js', 'public/style.css',
    'data/world-state.json',
  ];
  for (const f of requiredFiles) {
    const full = join(BASE, f);
    const exists = existsSync(full);
    if (exists) {
      const size = statSync(full).size;
      row(f, `${(size / 1024).toFixed(1)} KB`);
    } else {
      row(f, '❌ 不存在', true);
    }
  }

  // ── 2. 存檔狀態 ──
  section('2. 當前遊戲狀態');
  const state = readJSON(join(BASE, 'data/world-state.json'));
  if (!state) {
    console.log('  ⚠ 尚無遊戲狀態（未開始遊戲）');
  } else {
    row('玩家名稱',      state.player?.name || '未知');
    row('玩家身份',      state.player?.identity || 'none');
    row('目前地點',      state.world?.location || '?');
    row('遊戲天數',      `第 ${state.world?.day || 0} 天`);
    row('遊戲回合',      state.turn || 0);
    row('理智',          `${state.player?.sanity}/${state.player?.maxSanity}`);
    row('異常擴散',      `${state.world?.anomaly_spread}%`, state.world?.anomaly_spread >= 70);
    row('鎮子穩定',      `${state.world?.town_stability}%`, state.world?.town_stability <= 30);
    row('已知事實',      state.world?.known_facts?.length || 0);
    row('已觸發異常事件', state.world?.triggered_events?.length || 0);
    row('故事階段',      state.world?.phase || '?');
    row('已建造建築',    state.buildings?.length || 0);
    row('對話歷程',      `${state.conversation_history?.length || 0} 條`);
    row('任務-可用',     state.quests?.available?.length || 0);
    row('任務-進行中',   state.quests?.active?.length || 0);
    row('任務-已完成',   state.quests?.completed?.length || 0);
    row('成就數',        state.achievements?.length || 0);
    row('戰鬥中',        state.combat_state?.active ? '是' : '否');
    row('遊戲已結束',    state.ended ? `是（${state.ending_id}）` : '否');
  }

  // ── 3. 存檔槽 ──
  section('3. 存檔槽位');
  const savesDir = join(BASE, 'data/saves');
  if (!existsSync(savesDir)) {
    console.log('  ⚠ 存檔目錄不存在');
  } else {
    for (let slot = 1; slot <= 3; slot++) {
      const savePath = join(savesDir, `save_${slot}.json`);
      if (!existsSync(savePath)) {
        row(`存檔 ${slot}`, '空');
      } else {
        const save = readJSON(savePath);
        row(`存檔 ${slot}`, `${save?.saveName || '無名'} · ${save?.saveTime || '未知時間'}`);
      }
    }
  }

  // ── 4. 環境設定 ──
  section('4. 環境設定（.env）');
  const envPath = join(BASE, '.env');
  if (!existsSync(envPath)) {
    console.log('  ⚠ .env 檔案不存在！');
  } else {
    const envContent = readFileSync(envPath, 'utf-8');
    const hasApiKey = envContent.includes('ANTHROPIC_API_KEY=') && !envContent.includes('ANTHROPIC_API_KEY=\n');
    const useOllama = envContent.includes('USE_OLLAMA=true');
    row('ANTHROPIC_API_KEY', hasApiKey ? '已設定' : '⚠ 未設定', !hasApiKey);
    row('USE_OLLAMA',        useOllama ? 'true（使用本地AI）' : 'false（使用Claude API）');
    const portMatch = envContent.match(/PORT=(\d+)/);
    row('PORT', portMatch ? portMatch[1] : '3000（預設）');
  }

  // ── 5. 伺服器連線 ──
  section('5. 伺服器連線測試');
  try {
    const res = await fetch('http://localhost:3000/api/status', { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    row('伺服器狀態',  '🟢 運行中');
    row('回應內容',    JSON.stringify(data).substring(0, 60));
  } catch (e) {
    row('伺服器狀態', '🔴 無法連線（未啟動或崩潰）', true);
    console.log('  提示：執行 npm start 啟動伺服器');
  }

  // ── 6. 常見問題診斷 ──
  section('6. 常見問題診斷');
  const issues = [];

  if (state) {
    if (state.world?.anomaly_spread >= 80) issues.push('異常擴散過高（≥80%），即將觸發終局');
    if (state.player?.sanity <= 20)        issues.push('玩家理智極低（≤20），接近崩潰結局');
    if (state.world?.town_stability <= 20) issues.push('鎮子穩定極低（≤20%），接近崩潰結局');
    if (state.conversation_history?.length >= 45) issues.push('對話歷程接近上限（45/50），考慮存檔');
    if (!state.player?.character)          issues.push('玩家尚未創建角色（character 為 null）');
  }

  if (issues.length === 0) {
    console.log('  ✓ 未發現明顯問題');
  } else {
    issues.forEach(i => console.log(`  ⚠ ${i}`));
  }

  console.log('\n' + '═'.repeat(50) + '\n');
}

main().catch(console.error);
