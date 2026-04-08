/**
 * 玄冥江湖 v2.0 — 自動化 API 測試
 * 執行：npm test（需先啟動伺服器 npm start）
 */

const BASE = 'http://localhost:3000';
let passed = 0, failed = 0;

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  return { status: res.status, data: await res.json() };
}

function assert(label, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   玄冥江湖 API 自動化測試                  ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // ── 1. 健康狀態 ──
  console.log('【1】基礎健康檢查');
  const status = await req('GET', '/api/status');
  assert('伺服器回應 200', status.status === 200);
  assert('回應含 ok:true', status.data.ok === true);
  assert('回應含 day 欄位', typeof status.data.day === 'number');
  assert('回應含 phase 欄位', ['early','mid','late','final'].includes(status.data.phase));

  // ── 2. 新遊戲 ──
  console.log('\n【2】新遊戲初始化');
  const newGame = await req('POST', '/api/new-game');
  assert('新遊戲回應 200', newGame.status === 200);
  assert('新遊戲 success:true', newGame.data.success === true);

  // ── 3. 角色創建 ──
  console.log('\n【3】角色創建');
  const charBad = await req('POST', '/api/character/create', { name: '', background: '江湖浪人', martial_style: '剛猛', personality: '俠義' });
  assert('空名字回 400', charBad.status === 400);

  const charOk = await req('POST', '/api/character/create', {
    name: '測試俠', background: '江湖浪人', martial_style: '剛猛', personality: '俠義'
  });
  assert('合法角色創建 200', charOk.status === 200);
  assert('角色名稱正確', charOk.data.player?.name === '測試俠');

  const charBadBg = await req('POST', '/api/character/create', { name: '測試', background: '無效背景', martial_style: '剛猛', personality: '俠義' });
  assert('無效背景回 400', charBadBg.status === 400);

  // ── 4. 狀態取得 ──
  console.log('\n【4】遊戲狀態');
  const state = await req('GET', '/api/state');
  assert('狀態取得 200', state.status === 200);
  assert('玩家資訊存在', !!state.data.player);
  assert('世界資訊存在', !!state.data.world);
  assert('地圖資訊存在', !!state.data.map);
  assert('NPC 資訊存在', !!state.data.npcs);
  assert('任務資訊存在', !!state.data.quests);
  assert('建築定義存在', !!state.data.building_defs);
  assert('地圖含青石鎮', !!state.data.map['青石鎮']);
  assert('10個地點', Object.keys(state.data.map).length === 10);
  assert('9個NPC', Object.keys(state.data.npcs).length === 9);
  assert('初始地點正確', state.data.world.location === '青石鎮');
  assert('初始異常值正常', state.data.world.anomaly_spread >= 0 && state.data.world.anomaly_spread <= 100);
  assert('玩家有戰鬥屬性', !!state.data.player.combat);
  assert('玩家等級初始為1', state.data.player.combat.level === 1);

  // ── 5. 任務系統 ──
  console.log('\n【5】任務系統');
  const quests = await req('GET', '/api/quests');
  assert('任務取得 200', quests.status === 200);
  assert('有可用任務', quests.data.available?.length > 0);

  if (quests.data.available?.length > 0) {
    const firstQuestId = quests.data.available[0].id;
    const accept = await req('POST', '/api/quests/accept', { quest_id: firstQuestId });
    assert('接取任務 200', accept.status === 200);
    assert('任務移至進行中', accept.data.state?.quests?.active?.some(q => q.id === firstQuestId));

    // 重複接取應失敗
    const acceptDup = await req('POST', '/api/quests/accept', { quest_id: firstQuestId });
    assert('重複接取應失敗 400', acceptDup.status === 400);
  }

  // ── 6. 移動系統 ──
  console.log('\n【6】移動系統');
  // 先與掌櫃對話以解鎖枯骨峽谷（innkeeper trust >= 25）
  await req('POST', '/api/npc/talk', { npc_id: 'innkeeper', message: '掌櫃，關於失蹤的商人' });
  await req('POST', '/api/npc/talk', { npc_id: 'innkeeper', message: '峽谷有什麼危險？' });
  const moveOk = await req('POST', '/api/move', { location: '枯骨峽谷' });
  assert('移動至連接地點成功', moveOk.status === 200);
  assert('移動後狀態更新', moveOk.data.state?.world?.location === '枯骨峽谷');

  const moveBad = await req('POST', '/api/move', { location: '星淵深洞' });
  assert('無法跳躍移動', moveBad.status === 400);

  // 回到青石鎮
  await req('POST', '/api/new-game');

  // ── 7. 建設系統 ──
  console.log('\n【7】建設系統');
  const buildBad = await req('POST', '/api/build', { building_id: 'unknown_building' });
  assert('未知建築回 400', buildBad.status === 400);

  // 設定角色以解鎖 identity 相關建築
  await req('POST', '/api/character/create', { name: '建設測試', background: '江湖浪人', martial_style: '剛猛', personality: '俠義' });

  // 嘗試建造（資源不足）
  const buildNoRes = await req('POST', '/api/build', { building_id: 'void_altar' });
  assert('資源不足無法建造', buildNoRes.status === 400 || (buildNoRes.data && !buildNoRes.data.success));

  // ── 8. 存檔系統 ──
  console.log('\n【8】存讀檔系統');
  const saveOk = await req('POST', '/api/save', { slot: 1 });
  assert('存檔成功', saveOk.status === 200 && saveOk.data.success);

  const savesList = await req('GET', '/api/saves');
  assert('存檔列表 200', savesList.status === 200);
  assert('存檔列表是陣列', Array.isArray(savesList.data));
  assert('存檔列表有3個槽位', savesList.data.length === 3);
  assert('槽位1已存檔', !savesList.data[0].empty);

  const loadOk = await req('POST', '/api/load', { slot: 1 });
  assert('讀檔成功', loadOk.status === 200 && loadOk.data.success);

  const loadBad = await req('POST', '/api/load', { slot: 3 }); // slot 3 為空槽位
  assert('空槽位讀取回 404', loadBad.status === 404);

  // ── 9. 戰鬥系統 ──
  console.log('\n【9】戰鬥系統');
  const combatStart = await req('POST', '/api/combat/start', { enemy_id: 'possessed_civilian' });
  assert('啟動戰鬥 200', combatStart.status === 200);
  assert('戰鬥狀態為 active', combatStart.data.combat?.active === true);

  const combatState = await req('GET', '/api/combat/state');
  assert('取得戰鬥狀態 200', combatState.status === 200);
  assert('敵人名稱存在', !!combatState.data.combat?.enemy?.name);

  const attackRes = await req('POST', '/api/combat/action', { action: 'attack' });
  assert('攻擊行動 200', attackRes.status === 200);
  assert('攻擊有回應 log', Array.isArray(attackRes.data.log) && attackRes.data.log.length > 0);

  // 逃跑（多試幾次以提高成功率）
  for (let i = 0; i < 5; i++) {
    const fleeRes = await req('POST', '/api/combat/action', { action: 'flee' });
    if (fleeRes.data?.fled || fleeRes.data?.ended) break;
  }
  const afterFlee = await req('GET', '/api/combat/state');
  // 不強制要求逃跑成功（有隨機性）
  assert('戰鬥狀態可查詢', afterFlee.status === 200);

  // ── 10. 成就系統 ──
  console.log('\n【10】成就系統');
  const achievements = await req('GET', '/api/achievements');
  assert('成就取得 200', achievements.status === 200);
  assert('成就列表存在', Array.isArray(achievements.data.all));
  assert('成就定義非空', achievements.data.all.length > 0);

  // ── 11. 版本資訊 ──
  console.log('\n【11】版本資訊');
  const version = await req('GET', '/api/version');
  assert('版本資訊 200', version.status === 200);
  assert('版本號存在', !!version.data.version);
  assert('功能列表存在', Array.isArray(version.data.features));
  assert('平台列表存在', Array.isArray(version.data.platforms));

  // ── 12. 回饋系統 ──
  console.log('\n【12】回饋系統');
  const fbOk = await req('POST', '/api/feedback', { type: 'bug', message: '測試回饋訊息' });
  assert('回饋提交 200', fbOk.status === 200 && fbOk.data.success);

  const fbBad = await req('POST', '/api/feedback', { type: 'bug', message: '' });
  assert('空回饋回 400', fbBad.status === 400);

  const fbList = await req('GET', '/api/feedback');
  assert('回饋列表 200', fbList.status === 200);
  assert('回饋統計存在', typeof fbList.data.total === 'number');

  // ── 13. 分析系統 ──
  console.log('\n【13】分析系統');
  const analyticsOk = await req('POST', '/api/analytics', { event: 'test_event', data: { test: true } });
  assert('事件記錄 200', analyticsOk.status === 200 && analyticsOk.data.success);

  const analyticsBad = await req('POST', '/api/analytics', { event: '', data: {} });
  assert('空事件名回 400', analyticsBad.status === 400);

  const analyticsSummary = await req('GET', '/api/analytics/summary');
  assert('分析摘要 200', analyticsSummary.status === 200);
  assert('總計數存在', typeof analyticsSummary.data.total === 'number');

  // ── 結果 ──
  const total = passed + failed;
  console.log('\n══════════════════════════════════════════');
  console.log(`測試結果：${passed}/${total} 通過`);
  if (failed > 0) {
    console.log(`失敗：${failed} 個`);
    process.exit(1);
  } else {
    console.log('🎉 全部測試通過！');
  }
  console.log('══════════════════════════════════════════\n');
}

runTests().catch(err => {
  console.error('\n❌ 測試執行失敗（伺服器是否已啟動？）：', err.message);
  process.exit(1);
});
