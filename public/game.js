// ══════════════════════════════════════════════════════════════
// 玄冥江湖 v2.0 · 客戶端邏輯
// ══════════════════════════════════════════════════════════════

// ── i18n (多語言支援) ──
let currentLang = localStorage.getItem('wuxia_lang') || 'zh-TW';
let i18nData = {};
async function loadI18n(lang) {
  try {
    const res = await fetch(`/i18n/${lang}.json`);
    if (!res.ok) throw new Error(`Failed to load language: ${lang}`);
    i18nData = await res.json();
    currentLang = lang;
    localStorage.setItem('wuxia_lang', lang);
    applyI18n();
    // 更新語言按鈕狀態
    document.querySelectorAll('.lang-btn').forEach(btn => {
      if (btn.dataset.lang === currentLang) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
    // 觸發事件讓其他監聽器知道語言已改變
    window.dispatchEvent(new CustomEvent('languageChanged', { detail: { lang } }));
  } catch (e) {
    console.error('i18n load error:', e);
    if (lang !== 'zh-TW') loadI18n('zh-TW');
  }
}
function t(key) {
  return i18nData[key] || key;
}
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.placeholder = t(key);
    } else {
      el.textContent = t(key);
    }
  });
}

// ── 狀態 ──
let isLoading = false;
let modalMode = 'save';
let currentPanel = 'story';
let autoSaveTimer = null;
let charSelections = { background: null, martial_style: null, personality: null };

// ── 帳號狀態 ──
let authToken = localStorage.getItem('wuxia_token') || null;
let currentUser = null;

// ── DOM 參照 ──
const titleScreen   = document.getElementById('title-screen');
const charScreen    = document.getElementById('char-screen');
const gameScreen    = document.getElementById('game-screen');
const storyOutput   = document.getElementById('story-output');
const actionInput   = document.getElementById('action-input');
const btnSend       = document.getElementById('btn-send');
const loadingEl     = document.getElementById('loading-indicator');
const saveModal     = document.getElementById('save-modal');
const combatModal   = document.getElementById('combat-modal');
const achieveModal  = document.getElementById('achievement-modal');
const achieveToast  = document.getElementById('achievement-toast');

// ══════════════════════════════════════════════════════════════
// 開始畫面
// ══════════════════════════════════════════════════════════════
document.getElementById('btn-new-game').addEventListener('click', async () => {
  await fetch('/api/new-game', { method: 'POST' });
  showCharCreation();
});

document.getElementById('btn-load-game').addEventListener('click', () => {
  modalMode = 'load';
  openModal();
});

// ══════════════════════════════════════════════════════════════
// 角色創建
// ══════════════════════════════════════════════════════════════
function showCharCreation() {
  titleScreen.classList.add('hidden');
  charScreen.classList.remove('hidden');
  charSelections = { background: null, martial_style: null, personality: null };
  document.getElementById('char-name').value = '';
  document.querySelectorAll('.char-opt').forEach(o => o.classList.remove('selected'));
  document.getElementById('btn-char-confirm').disabled = true;
  updateCharPreview();
}

document.getElementById('btn-char-back').addEventListener('click', () => {
  charScreen.classList.add('hidden');
  titleScreen.classList.remove('hidden');
});

// 選項點擊
document.querySelectorAll('.char-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    const group = opt.dataset.group;
    document.querySelectorAll(`[data-group="${group}"]`).forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    charSelections[group] = opt.dataset.val;
    updateCharPreview();
    checkCharReady();
  });
});

document.getElementById('char-name').addEventListener('input', () => {
  updateCharPreview();
  checkCharReady();
});

function checkCharReady() {
  const name = document.getElementById('char-name').value.trim();
  const ready = name.length > 0 && charSelections.background && charSelections.martial_style && charSelections.personality;
  document.getElementById('btn-char-confirm').disabled = !ready;
}

function updateCharPreview() {
  const preview = document.getElementById('char-preview');
  const name = document.getElementById('char-name').value.trim() || '（未填寫）';
  const { background, martial_style, personality } = charSelections;

  if (!background && !martial_style && !personality) {
    preview.innerHTML = '<div class="preview-placeholder">請選擇以上選項查看角色預覽</div>';
    return;
  }

  const bonusMap = {
    '江湖浪人': '木材 +10，江湖聲望 +5',
    '朝廷欽差': '鐵料 +10，收容聲望 +5',
    '邪教叛徒': '虛空碎片 +3，異常聲望 +5',
    '隱士遺孤': '理智上限 +10，各聲望 +3',
    '剛猛': '攻擊力 +5',
    '輕靈': '攻擊 +2 防禦 +3',
    '陰詭': '攻擊 +3 防禦 +2 異常抗性 +5',
    '醫毒': '攻擊 +1 防禦 +2',
    '俠義': '江湖聲望 +10',
    '自保': '初始理智 +10',
    '求知': '收容聲望 +10',
    '復仇': '江湖聲望 +5',
  };

  preview.innerHTML = `
    <div class="preview-card">
      <div class="preview-name">${name}</div>
      <div class="preview-tags">
        ${background ? `<span class="preview-tag bg-tag">${background}</span>` : ''}
        ${martial_style ? `<span class="preview-tag ms-tag">${martial_style}</span>` : ''}
        ${personality ? `<span class="preview-tag p-tag">${personality}</span>` : ''}
      </div>
      <div class="preview-bonuses">
        ${background ? `<div class="bonus-line">出身加成：${bonusMap[background] || ''}</div>` : ''}
        ${martial_style ? `<div class="bonus-line">武學加成：${bonusMap[martial_style] || ''}</div>` : ''}
        ${personality ? `<div class="bonus-line">性格加成：${bonusMap[personality] || ''}</div>` : ''}
      </div>
    </div>
  `;
}

document.getElementById('btn-char-confirm').addEventListener('click', async () => {
  const name = document.getElementById('char-name').value.trim();
  if (!name || !charSelections.background || !charSelections.martial_style || !charSelections.personality) return;

  const res = await fetch('/api/character/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, background: charSelections.background, martial_style: charSelections.martial_style, personality: charSelections.personality })
  });
  const data = await res.json();
  if (data.success) {
    charScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');
    const stateRes = await fetch('/api/state');
    const stateData = await stateRes.json();
    updateUI(stateData);
    startAutoSave();
    playBGM('town');
    await sendAction(`【遊戲開始】${name}是一名${charSelections.background}，武學流派為${charSelections.martial_style}，性格根骨為${charSelections.personality}。請描述這名主角初次抵達青石鎮的傍晚場景，帶出無名歸人事件的第一個線索，並給出3個符合主角身份的初始行動選項。`);
  }
});

// ══════════════════════════════════════════════════════════════
// 畫面切換
// ══════════════════════════════════════════════════════════════
function switchToGame(data) {
  titleScreen.classList.add('hidden');
  charScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  if (data) updateUI(data);
  startAutoSave();
}

function switchToTitle() {
  gameScreen.classList.add('hidden');
  charScreen.classList.add('hidden');
  titleScreen.classList.remove('hidden');
  storyOutput.innerHTML = '';
  stopAutoSave();
}

// ══════════════════════════════════════════════════════════════
// 面板切換
// ══════════════════════════════════════════════════════════════
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentPanel = btn.dataset.panel;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
    document.getElementById(`panel-${currentPanel}`).classList.remove('hidden');
  });
});

// ══════════════════════════════════════════════════════════════
// 打字機效果
// ══════════════════════════════════════════════════════════════
function typeText(el, text, speed = 18) {
  // 尊重 prefers-reduced-motion：直接顯示全文
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = text;
    storyOutput.scrollTop = storyOutput.scrollHeight;
    return;
  }
  let i = 0;
  el.textContent = '';
  const interval = setInterval(() => {
    el.textContent += text[i];
    i++;
    storyOutput.scrollTop = storyOutput.scrollHeight;
    if (i >= text.length) clearInterval(interval);
  }, speed);
}

// ══════════════════════════════════════════════════════════════
// 敘事輸出
// ══════════════════════════════════════════════════════════════
function appendEntry(text, type = 'ai') {
  const entry = document.createElement('div');
  entry.className = `story-entry ${type}-entry animate__animated animate__fadeIn`;

  const textEl = document.createElement('div');
  textEl.className = 'entry-text';

  if (type === 'ai') {
    typeText(textEl, text.trim());
  } else {
    textEl.textContent = type === 'player' ? `▷ ${text}` : text;
  }

  entry.appendChild(textEl);
  storyOutput.appendChild(entry);
  storyOutput.scrollTop = storyOutput.scrollHeight;
}

function appendAnomalyEvent(ev) {
  const entry = document.createElement('div');
  entry.className = 'story-entry anomaly-entry animate__animated animate__shakeX';
  entry.innerHTML = `<div class="anomaly-title">⚠ 異常事件：${ev.title}</div><div class="entry-text">${ev.desc}</div>`;
  storyOutput.appendChild(entry);
  storyOutput.scrollTop = storyOutput.scrollHeight;
}

function appendEnding(ending) {
  const entry = document.createElement('div');
  entry.className = 'story-entry ending-entry animate__animated animate__fadeIn';
  entry.innerHTML = `<div class="ending-title">═══ 結局：${ending.title} ═══</div><div class="entry-text">${ending.desc}</div>`;
  storyOutput.appendChild(entry);
  storyOutput.scrollTop = storyOutput.scrollHeight;
}

// ══════════════════════════════════════════════════════════════
// 快速行動靈感（點擊僅填入輸入框，玩家可自由修改後再送出）
// ══════════════════════════════════════════════════════════════

// 依地點動態建構靈感庫
const LOCATION_ACTIONS = {
  '青石鎮':   ['詢問客棧掌櫃關於失蹤商人的消息', '在廣場張貼告示，打聽異常線索', '悄悄靠近那口古井，仔細察看', '找說書人柳白問問玄冥關的往事', '在鎮子裡漫步，觀察鎮民的神情'],
  '玄冥關廢墟':['在廢墟中搜尋守軍留下的日誌或遺物', '在廢墟深處靜坐冥想，感受異常波動', '找到最後完好的哨樓，向四周張望', '清理瓦礫，尋找埋藏的線索'],
  '枯骨峽谷': ['沿著去路腳印，深入峽谷探查', '辨識骨陣的排列規律，試著找出圖案意義', '在峽谷壁畫旁停留，細細辨讀'],
  '霧隱山':   ['循著歌聲方向前行，尋找聲音來源', '在霧氣濃厚處觀察霧的流動方向', '登頂靜坐，以內功感知山中異象'],
  '沉淵寺':   ['拜訪玄真道人，詢問虛空的本質', '在藏經閣翻閱關於異常的典籍', '協助道人補全寺廟各角落的封印符文'],
  '古道驛站': ['徹底搜索驛站每個房間', '嘗試補全牆上被破壞的隔離符文', '在驛站後院枯井旁尋找藏匿物'],
  '血染古橋': ['觀察橋面血跡的分布與形狀', '走到橋中央，靜靜感受此地氣場', '嘗試在橋面繪製臨時性的安定符文'],
  '廢棄軍寨': ['在地窖中搜尋封存的軍報', '翻找軍官宿舍裡遺留的私人日誌', '在練兵場中，感受那種詭異的整齊'],
  '天機閣遺址':['細讀穹頂星象圖，找出「客星」軌跡', '翻閱虛空潮汐的未完成計算', '在天文臺頂端，以功法感知夜空異常'],
  '星淵深洞': ['沿洞壁慢行，辨識那些「長出來的」名字', '靠近那扇「門」，感受另一側的氣息', '在洞口盤坐冥想，保持理智的距離'],
};

// 通用靈感（地點無對應時使用）
const GENERIC_ACTIONS = [
  '仔細觀察周圍有無異常跡象', '尋找可以交談的人，打聽消息',
  '靜下心來，感受此地的氣場', '蒐集更多關於玄冥關事件的線索',
  '找個隱蔽角落，先觀察再行動',
];

function renderQuickActions(state) {
  const container = document.getElementById('quick-actions');
  container.innerHTML = '';

  if (state?.combat_state?.active) {
    container.innerHTML = '<div class="qa-hint">⚔ 戰鬥進行中——請於戰鬥面板操作</div>';
    return;
  }

  // 標題提示
  const hint = document.createElement('div');
  hint.className = 'qa-hint';
  hint.textContent = '💡 靈感（點擊填入，可自由修改）';
  container.appendChild(hint);

  // 動態選取靈感：任務優先 → 地點專屬 → 通用
  const inspirations = [];

  // 1. 進行中任務（最多 1 條）
  if (state?.quests?.active?.length > 0) {
    const q = state.quests.active[0];
    inspirations.push({ label: `📜 ${q.title}`, action: `繼續推進任務「${q.title}」` });
  }

  // 2. 終局特殊
  if (state?.world?.phase === 'final') {
    inspirations.push({ label: '⚠ 面對終局', action: '面對眼前的終局，做出最後決斷' });
  }

  // 3. 地點專屬靈感（隨機取 3 條）
  const loc = state?.world?.location || '青石鎮';
  const locPool = LOCATION_ACTIONS[loc] || GENERIC_ACTIONS;
  const shuffled = [...locPool].sort(() => Math.random() - 0.5);
  shuffled.slice(0, 3).forEach(action => {
    inspirations.push({ label: action.slice(0, 12) + (action.length > 12 ? '…' : ''), action });
  });

  // 4. 低理智時加入特殊選項
  if (state?.player?.sanity < 40) {
    inspirations.push({ label: '😵 試著穩定心神', action: '試圖穩定動搖的理智，以冥想調息' });
  }

  // 渲染按鈕（點擊只填入文字框，不自動送出）
  inspirations.slice(0, 5).forEach(qa => {
    const btn = document.createElement('button');
    btn.className = 'qa-btn';
    btn.title = qa.action; // hover 時顯示完整行動描述
    btn.textContent = qa.label;
    btn.addEventListener('click', () => {
      actionInput.value = qa.action;
      actionInput.focus();
      // 移動游標到末尾
      actionInput.setSelectionRange(actionInput.value.length, actionInput.value.length);
    });
    container.appendChild(btn);
  });
}

// ══════════════════════════════════════════════════════════════
// UI 更新
// ══════════════════════════════════════════════════════════════
function updateUI(data) {
  if (!data) return;
  const { player, world, map, buildings, building_defs, anomaly_log, npcs, quests, combat_state, achievements } = data;

  // 血條與百分比
  const sanityPct = (player.sanity / player.maxSanity) * 100;
  document.getElementById('sanity-bar').style.width = sanityPct + '%';
  document.getElementById('sanity-bar').style.background = sanityPct < 30 ? '#c43030' : sanityPct < 60 ? '#c4902a' : '#4a9a7a';
  document.getElementById('sanity-text').textContent = `${player.sanity}/${player.maxSanity}`;

  document.getElementById('stability-bar').style.width = world.town_stability + '%';
  document.getElementById('stability-text').textContent = world.town_stability + '%';
  document.getElementById('anomaly-bar').style.width = world.anomaly_spread + '%';
  document.getElementById('anomaly-text').textContent = world.anomaly_spread + '%';

  // 身份徽章
  const identityEl = document.getElementById('identity-display');
  const labels = { none: '旅人', jianghu: '江湖人', containment: '收容者', anomaly: '異常接觸者' };
  identityEl.textContent = labels[player.identity] || '旅人';
  identityEl.className = `identity-badge identity-${player.identity || 'none'}`;

  // 聲望
  document.getElementById('rep-jianghu').textContent     = player.reputation.jianghu;
  document.getElementById('rep-containment').textContent = player.reputation.containment;
  document.getElementById('rep-anomaly').textContent     = player.reputation.anomaly;

  // 時間 / 地點
  document.getElementById('time-display').textContent     = `第${world.day}天 · ${world.time}`;
  document.getElementById('location-display').textContent = world.location;

  // 戰鬥資訊
  if (player.combat) {
    document.getElementById('level-text').textContent  = `Lv.${player.combat.level}`;
    document.getElementById('combat-power').textContent   = player.combat.power;
    document.getElementById('combat-defense').textContent = player.combat.defense;
    document.getElementById('combat-xp').textContent      = player.combat.xp;
  }

  // 資源
  if (world.resources) {
    document.getElementById('res-stone').textContent = world.resources.stone || 0;
    document.getElementById('res-wood').textContent  = world.resources.wood  || 0;
    document.getElementById('res-iron').textContent  = world.resources.iron  || 0;
    document.getElementById('res-void').textContent  = world.resources.void_shard || 0;
  }

  // 技能 / 物品
  document.getElementById('skills-list').textContent  = player.skills.length  > 0 ? player.skills.join('　')  : '（無）';
  document.getElementById('items-list').textContent   = player.inventory.length > 0 ? player.inventory.join('　') : '（無）';

  // 各面板
  if (map)           renderMap(map, world.location);
  if (npcs)          renderNPCs(npcs, world.location);
  if (quests)        renderQuests(quests);
  if (building_defs) renderBuildings(buildings || [], building_defs, player.identity, world.resources);
  if (anomaly_log)   renderAnomalyLog(anomaly_log);
  renderClues(world.known_facts || []);

  // 快速行動
  renderQuickActions(data);

  // 戰鬥彈窗
  if (combat_state?.active) {
    showCombatModal(combat_state, player);
  }
}

// ══════════════════════════════════════════════════════════════
// 地圖渲染
// ══════════════════════════════════════════════════════════════
function renderMap(map, currentLocation) {
  const container = document.getElementById('map-container');
  if (!container) return; // Defensive check
  container.innerHTML = '';

  // 排序：已解鎖優先，當前位置最前
  const entries = Object.entries(map).sort(([ka, a], [kb, b]) => {
    if (ka === currentLocation) return -1;
    if (kb === currentLocation) return 1;
    if (a.unlocked && !b.unlocked) return -1;
    if (!a.unlocked && b.unlocked) return 1;
    return 0;
  });

  entries.forEach(([key, loc]) => {
    const isCurrent = key === currentLocation;
    const isNeighbour = map[currentLocation]?.connections?.includes(key);
    const canMove = loc.unlocked && !isCurrent && isNeighbour;
    const nearbyLocked = !loc.unlocked && isNeighbour; // 相鄰但未解鎖

    const card = document.createElement('div');
    card.className = `map-card ${loc.unlocked ? '' : 'locked'} ${isCurrent ? 'current' : ''} ${nearbyLocked ? 'nearby-locked' : ''}`;

    // 異常濃度鑽石圖示
    const diamonds = '◆'.repeat(loc.anomaly_level) + '◇'.repeat(5 - loc.anomaly_level);

    card.innerHTML = `
      <div class="map-name">${loc.unlocked ? loc.label : '？？？'}</div>
      ${loc.unlocked
        ? `<div class="map-desc">${loc.desc}</div>
           <div class="map-anomaly">異常濃度：${diamonds}</div>`
        : `<div class="map-hint">🔒 ${loc.unlock_hint || '繼續探索即可解鎖'}</div>`
      }
      ${isCurrent ? '<div class="map-here">◀ 當前位置</div>' : ''}
      ${canMove ? `<button class="btn-move" data-loc="${key}">前往此地</button>` : ''}
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('.btn-move').forEach(btn => {
    btn.addEventListener('click', () => moveToLocation(btn.dataset.loc));
  });
}

async function moveToLocation(location) {
  const res = await fetch('/api/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location })
  });
  const data = await res.json();
  if (data.success) {
    updateUI(data.state);
    appendEntry(`你離開了當前地點，前往 ${location}。${data.sanity_lost > 0 ? `（異常氣息消耗理智 -${data.sanity_lost}）` : ''}`, 'system');
    if (data.new_achievements?.length) showAchievements(data.new_achievements);
    if (data.newly_unlocked?.length)   showUnlockNotices(data.newly_unlocked);
    document.querySelector('[data-panel="story"]').click();
    await sendAction(`【移動】我抵達了 ${location}，請描述這個地點的環境和第一印象。`);
  } else {
    appendEntry(`⚠ ${data.error}`, 'system');
  }
}

// ══════════════════════════════════════════════════════════════
// NPC 面板渲染
// ══════════════════════════════════════════════════════════════
function renderNPCs(npcs, currentLocation) {
  const container = document.getElementById('npc-container');
  if (!container) return; // Defensive check
  container.innerHTML = '';

  // Sort: alive first, current location first
  const entries = Object.entries(npcs).sort(([, a], [, b]) => {
    if (!a.alive && b.alive) return 1;
    if (a.alive && !b.alive) return -1;
    return 0;
  });

  if (entries.length === 0) {
    container.innerHTML = '<div class="npc-empty">尚無已知人物</div>';
    return;
  }

  entries.forEach(([id, npc]) => {
    const card = document.createElement('div');
    card.className = `npc-card ${!npc.alive ? 'npc-dead' : ''}`;

    const trustPct  = Math.max(0, (npc.trust + 100) / 2);  // -100~100 → 0~100%
    const fearPct   = npc.fear;

    card.innerHTML = `
      <div class="npc-header">
        <div class="npc-name">${npc.name} ${!npc.alive ? '<span class="npc-status-dead">（已故）</span>' : ''}</div>
        <div class="npc-location">📍 ${npc.location}</div>
      </div>
      <div class="npc-desc">${npc.description}</div>
      <div class="npc-meters">
        <div class="npc-meter">
          <span class="meter-label">信任</span>
          <div class="meter-bar"><div class="meter-fill trust-fill" style="width:${trustPct}%"></div></div>
          <span class="meter-val">${npc.trust > 0 ? '+' : ''}${npc.trust}</span>
        </div>
        <div class="npc-meter">
          <span class="meter-label">恐懼</span>
          <div class="meter-bar"><div class="meter-fill fear-fill" style="width:${fearPct}%"></div></div>
          <span class="meter-val">${npc.fear}</span>
        </div>
      </div>
      ${npc.alive ? `<button class="btn-npc-talk" data-id="${id}" data-name="${npc.name}">與${npc.name}交談</button>` : ''}
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('.btn-npc-talk').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name;
      document.querySelector('[data-panel="story"]').click();
      actionInput.value = `我靠近${name}，試圖與他交談，詢問關於無名歸人和玄冥關的事`;
      handleSend();
    });
  });
}

// ══════════════════════════════════════════════════════════════
// 任務面板渲染
// ══════════════════════════════════════════════════════════════
function renderQuests(quests) {
  const container = document.getElementById('quests-container');
  if (!container) return; // Defensive check
  container.innerHTML = '';

  // 進行中
  if (quests.active?.length > 0) {
    const title = document.createElement('div');
    title.className = 'quest-section-title';
    title.textContent = '── 進行中 ──';
    container.appendChild(title);
    quests.active.forEach(q => renderQuestCard(container, q, 'active'));
  }

  // 可接取
  if (quests.available?.length > 0) {
    const title = document.createElement('div');
    title.className = 'quest-section-title';
    title.textContent = '── 可接取 ──';
    container.appendChild(title);
    quests.available.forEach(q => renderQuestCard(container, q, 'available'));
  }

  // 已完成
  if (quests.completed?.length > 0) {
    const title = document.createElement('div');
    title.className = 'quest-section-title completed-title';
    title.textContent = `── 已完成（${quests.completed.length}）──`;
    container.appendChild(title);
    quests.completed.forEach(q => renderQuestCard(container, q, 'completed'));
  }

  if (!quests.active?.length && !quests.available?.length && !quests.completed?.length) {
    container.innerHTML = '<div class="quest-empty">尚無可用任務</div>';
  }
}

function renderQuestCard(container, q, status) {
  const card = document.createElement('div');
  card.className = `quest-card quest-${status}`;

  const rewardStr = [];
  if (q.rep_reward?.jianghu)     rewardStr.push(`江湖 +${q.rep_reward.jianghu}`);
  if (q.rep_reward?.containment) rewardStr.push(`收容 +${q.rep_reward.containment}`);
  if (q.rep_reward?.anomaly)     rewardStr.push(`異常 +${q.rep_reward.anomaly}`);
  if (q.item_reward) rewardStr.push(`物品：${q.item_reward}`);

  card.innerHTML = `
    <div class="quest-header">
      <div class="quest-title">${q.title} ${status === 'completed' ? '✓' : ''}</div>
      <div class="quest-status-badge quest-badge-${status}">${{ active: '進行中', available: '可接取', completed: '已完成' }[status]}</div>
    </div>
    <div class="quest-desc">${q.desc}</div>
    ${rewardStr.length ? `<div class="quest-reward">獎勵：${rewardStr.join('　')}</div>` : ''}
    ${status === 'available' ? `<button class="btn-quest-accept" data-id="${q.id}">接取任務</button>` : ''}
    ${status === 'active' ? `<button class="btn-quest-go" data-id="${q.id}" data-title="${q.title}" data-desc="${q.desc}">繼續任務</button>` : ''}
  `;
  container.appendChild(card);
}

// Quest event delegation
document.getElementById('quests-container').addEventListener('click', async e => {
  if (e.target.classList.contains('btn-quest-accept')) {
    const id = e.target.dataset.id;
    const res = await fetch('/api/quests/accept', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quest_id: id })
    });
    const data = await res.json();
    if (data.success) {
      renderQuests(data.quests);
      appendEntry(`【接取任務】${data.quest.title}：${data.quest.desc}`, 'system');
    }
  }
  if (e.target.classList.contains('btn-quest-go')) {
    document.querySelector('[data-panel="story"]').click();
    actionInput.value = `繼續執行任務「${e.target.dataset.title}」：${e.target.dataset.desc}`;
    handleSend();
  }
});

// ══════════════════════════════════════════════════════════════
// 建設渲染
// ══════════════════════════════════════════════════════════════
function renderBuildings(buildings, defs, identity, resources) {
  const container = document.getElementById('build-container');
  if (!container) return; // Defensive check
  container.innerHTML = '';
  const built = buildings.map(b => b.id);

  if (buildings.length > 0) {
    const title = document.createElement('div');
    title.className = 'build-section-title';
    title.textContent = '── 已建造 ──';
    container.appendChild(title);
    buildings.forEach(b => {
      const def = defs[b.id];
      if (!def) return;
      const card = document.createElement('div');
      card.className = 'build-card built';
      card.innerHTML = `<div class="build-name">${def.name} ✓</div><div class="build-desc">${def.desc}</div>`;
      container.appendChild(card);
    });
  }

  const available = Object.values(defs).filter(d => !built.includes(d.id));
  if (available.length > 0) {
    const title = document.createElement('div');
    title.className = 'build-section-title';
    title.textContent = '── 可建造 ──';
    container.appendChild(title);

    available.forEach(def => {
      const costStr = Object.entries(def.cost).map(([k, v]) => `${resLabel(k)}×${v}`).join(' ');
      const canAfford = Object.entries(def.cost).every(([k, v]) => k === 'sanity_cost' || (resources[k] || 0) >= v);
      const identityMatch = def.identity === 'none' || def.identity === identity;

      const card = document.createElement('div');
      card.className = `build-card ${canAfford && identityMatch ? '' : 'unavailable'}`;
      card.innerHTML = `
        <div class="build-name">${def.name}</div>
        <div class="build-desc">${def.desc}</div>
        <div class="build-cost">需要：${costStr}</div>
        ${def.identity !== 'none' && !identityMatch ? `<div class="build-note">需要身份：${def.identity}</div>` : ''}
        ${canAfford && identityMatch ? `<button class="btn-build" data-id="${def.id}">建造</button>` : ''}
      `;
      container.appendChild(card);
    });
  }

  container.querySelectorAll('.btn-build').forEach(btn => {
    btn.addEventListener('click', () => buildStructure(btn.dataset.id));
  });
}

function resLabel(key) {
  return { stone: '石料', wood: '木材', iron: '鐵料', void_shard: '虛空碎片', sanity_cost: '理智' }[key] || key;
}

async function buildStructure(id) {
  const res = await fetch('/api/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ building_id: id })
  });
  const data = await res.json();
  if (data.success) {
    updateUI(data.state);
    appendEntry(`【建設完成】${data.building.name}已建造完成。${data.building.desc}`, 'system');
    if (data.new_achievements?.length) showAchievements(data.new_achievements);
  } else {
    appendEntry(`⚠ 建設失敗：${data.error}`, 'system');
  }
}

// ══════════════════════════════════════════════════════════════
// 異常記錄本渲染
// ══════════════════════════════════════════════════════════════
function renderAnomalyLog(log) {
  const container = document.getElementById('log-container');
  if (!container) return; // Defensive check
  container.innerHTML = '';

  if (log.length === 0) {
    container.innerHTML = '<div class="log-empty">尚無異常記錄</div>';
    return;
  }

  log.forEach((entry, i) => {
    const card = document.createElement('div');
    card.className = 'log-card';
    card.innerHTML = `
      <div class="log-header">異常檔案 #${String(i + 1).padStart(3, '0')}　第${entry.day}天記錄</div>
      <div class="log-title">${entry.title}</div>
      <div class="log-desc">${entry.desc}</div>
      <div class="log-impact">理智衝擊 ${entry.sanity_delta}　穩定衝擊 ${entry.stability_delta}</div>
      <div class="log-status">狀態：持續觀察中</div>
    `;
    container.appendChild(card);
  });
}

// ══════════════════════════════════════════════════════════════
// 線索日誌渲染
// ══════════════════════════════════════════════════════════════
function renderClues(clues) {
  const container = document.getElementById('clues-container');
  if (!container) return;
  container.innerHTML = '';

  if (!clues || clues.length === 0) {
    container.innerHTML = '<div class="log-empty">尚無線索——與 NPC 交談或探索可發現線索</div>';
    return;
  }

  clues.forEach((clue, i) => {
    const card = document.createElement('div');
    card.className = 'log-card';
    card.innerHTML = `
      <div class="log-header">線索 #${String(i + 1).padStart(3, '0')}</div>
      <div class="log-title" style="color:var(--teal-bright,#4abcbc)">🔍 ${clue}</div>
      <div class="log-status" style="color:var(--gold-dim,#8a6a14)">已確認</div>
    `;
    container.appendChild(card);
  });
}

// ══════════════════════════════════════════════════════════════
// 戰鬥彈窗
// ══════════════════════════════════════════════════════════════
function showCombatModal(combatState, player) {
  if (!combatState?.active) return;
  document.getElementById('combat-enemy-name').textContent = combatState.enemy.name;
  updateCombatBars(combatState, player);
  combatModal.classList.remove('hidden');
}

function updateCombatBars(combatState, player) {
  if (!combatState) return;
  const hpPct = (combatState.enemy.hp / combatState.enemy.maxHp) * 100;
  document.getElementById('enemy-hp-text').textContent = `${combatState.enemy.hp}/${combatState.enemy.maxHp}`;
  document.getElementById('enemy-hp-bar').style.width = hpPct + '%';
  document.getElementById('player-sanity-text').textContent = `${player.sanity}/${player.maxSanity}`;
  const sanPct = (player.sanity / player.maxSanity) * 100;
  document.getElementById('player-combat-sanity-bar').style.width = sanPct + '%';
}

async function doCombatAction(action) {
  const res = await fetch('/api/combat/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action })
  });
  const data = await res.json();

  // Show combat log
  const logEl = document.getElementById('combat-log');
  data.log.forEach(line => {
    const div = document.createElement('div');
    div.className = 'combat-log-entry';
    div.textContent = line;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  });

  if (data.state) {
    updateUI(data.state);
    if (data.state.combat_state) updateCombatBars(data.state.combat_state, data.state.player);
  }

  if (data.ended) {
    setTimeout(() => {
      combatModal.classList.add('hidden');
      document.getElementById('combat-log').innerHTML = '';
      if (data.victory) {
        appendEntry('【戰鬥結束】你擊敗了敵人。', 'system');
        if (data.new_achievements?.length) showAchievements(data.new_achievements);
      } else if (data.fled) {
        appendEntry('【戰鬥結束】你成功逃脫。', 'system');
      } else {
        appendEntry('【戰鬥失敗】你的理智已耗盡……', 'system');
      }
    }, 1500);
  }
}

document.getElementById('btn-attack').addEventListener('click', () => doCombatAction('attack'));
document.getElementById('btn-defend').addEventListener('click', () => doCombatAction('defend'));
document.getElementById('btn-use-item').addEventListener('click', () => doCombatAction('use_item'));
document.getElementById('btn-flee').addEventListener('click', () => doCombatAction('flee'));

// ══════════════════════════════════════════════════════════════
// NPC 名稱偵測：自動路由到 NPC 對話 API
// ══════════════════════════════════════════════════════════════
const NPC_NAME_MAP = {
  '無名歸人': 'unnamed_survivor', '歸人': 'unnamed_survivor',
  '陳掌櫃': 'innkeeper', '掌櫃': 'innkeeper', '客棧掌櫃': 'innkeeper',
  '鎮長': 'elder', '李老爺': 'elder', '鎮長李老爺': 'elder',
  '衛霖': 'young_warrior', '少俠': 'young_warrior', '少俠衛霖': 'young_warrior',
  '玄真': 'taoist', '道人': 'taoist', '玄真道人': 'taoist',
  '張三': 'wounded_soldier', '殘兵': 'wounded_soldier', '殘兵張三': 'wounded_soldier',
  '柳白': 'storyteller', '說書人': 'storyteller', '說書人柳白': 'storyteller',
  '無憶孩兒': 'amnesiac_child', '孩兒': 'amnesiac_child', '孩子': 'amnesiac_child',
  '宋懷仁': 'physician', '醫師': 'physician', '流浪醫師': 'physician', '流浪醫師宋懷仁': 'physician',
};

// 關鍵字偵測是否在與某 NPC 交談（問 / 找 / 告訴 / 詢問 + NPC名稱）
const TALK_VERBS = /問|詢問|拜訪|找|請教|告訴|交談|聊|對話|跟.*說|與.*談|和.*說|向.*問/;

function detectNpcTarget(text) {
  // 先看是否有「動詞 + NPC名稱」的模式
  for (const [name, id] of Object.entries(NPC_NAME_MAP)) {
    const hasTalkVerb = TALK_VERBS.test(text);
    if (text.includes(name) && hasTalkVerb) return id;
  }
  // 如果純粹只打 NPC 名字或「問 NPC」這種短輸入，也算
  for (const [name, id] of Object.entries(NPC_NAME_MAP)) {
    if (text.startsWith('問' + name) || text === name || text === '找' + name) return id;
  }
  return null;
}

// ── 共用 UI 處理函式 ──────────────────────────────────────────
function handleApiResponse(data) {
  if (data.error) {
    appendEntry(`⚠ ${data.error}`, 'system');
    return;
  }
  if (data.triggered_event) appendAnomalyEvent(data.triggered_event);
  appendEntry(data.message, 'ai');
  updateUI(data.state);
  if (data.ending) appendEnding(data.ending);
  if (data.new_achievements?.length) showAchievements(data.new_achievements);
  if (data.newly_unlocked?.length)   showUnlockNotices(data.newly_unlocked);
  if (data.combat_triggered) {
    appendEntry(`⚠ 遭遇敵人：${data.combat_triggered.enemy}！`, 'system');
    fetch('/api/combat/state')
      .then(r => r.json())
      .then(d => { if (d?.state?.combat_state?.active) showCombatModal(d.state.combat_state, data.state.player); });
  }
}

// ══════════════════════════════════════════════════════════════
// 傳送行動（智能路由：NPC 對話 / 一般行動）
// ══════════════════════════════════════════════════════════════
async function sendAction(action) {
  if (isLoading) return;
  isLoading = true;
  btnSend.disabled = true;
  loadingEl.classList.remove('hidden');

  try {
    // 偵測是否在與特定 NPC 交談
    const npcId = detectNpcTarget(action);

    let res, data;
    if (npcId) {
      // 路由到 NPC 對話 API（回應更貼近角色個性）
      res = await fetch('/api/npc/talk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ npc_id: npcId, message: action })
      });
      data = await res.json();
      if (data.npc) {
        appendEntry(`【與${data.npc.name}交談】`, 'system');
      }
    } else {
      // 一般行動 API
      res = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      data = await res.json();
    }

    handleApiResponse(data);

  } catch (e) {
    appendEntry('⚠ 連線異常，請稍後再試', 'system');
  } finally {
    isLoading = false;
    btnSend.disabled = false;
    loadingEl.classList.add('hidden');
  }
}

function handleSend() {
  const text = actionInput.value.trim();
  if (!text || isLoading) return;
  appendEntry(text, 'player');
  actionInput.value = '';
  actionInput.style.height = 'auto';
  sendAction(text);
}

btnSend.addEventListener('click', handleSend);
actionInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
});
actionInput.addEventListener('input', () => {
  actionInput.style.height = 'auto';
  actionInput.style.height = Math.min(actionInput.scrollHeight, 120) + 'px';
});

// Add keyboard hint (only show on focus if not already present)
(function initInputHint() {
  const hint = document.createElement('div');
  hint.className = 'input-hint';
  hint.textContent = '💡 Enter 送出　Shift+Enter 換行';
  hint.style.cssText = 'font-size:0.75rem;color:var(--gold-dim,#8a6a14);margin-top:0.5rem;text-align:right;opacity:0.7;';
  const inputArea = document.querySelector('.input-area');
  if (inputArea) inputArea.appendChild(hint);
})();

// ══════════════════════════════════════════════════════════════
// 成就系統
// ══════════════════════════════════════════════════════════════
function showAchievements(achievements) {
  if (!achieveToast) return; // Defensive check
  achievements.forEach((ach, i) => {
    setTimeout(() => {
      achieveToast.textContent = `🏆 成就解鎖：${ach.title} — ${ach.desc}`;
      achieveToast.classList.remove('hidden');
      achieveToast.classList.add('animate__animated', 'animate__slideInRight');
      setTimeout(() => {
        achieveToast.classList.add('animate__slideOutRight');
        setTimeout(() => {
          achieveToast.classList.add('hidden');
          achieveToast.classList.remove('animate__animated', 'animate__slideInRight', 'animate__slideOutRight');
        }, 500);
      }, 3000);
    }, i * 3500);
  });
}

// ══════════════════════════════════════════════════════════════
// 解鎖通知（地點 / 任務）
// ══════════════════════════════════════════════════════════════
function showUnlockNotices(items) {
  items.forEach((item, i) => {
    setTimeout(() => {
      const toast = document.createElement('div');
      toast.className = 'unlock-toast animate__animated animate__slideInLeft';
      if (item.type === 'location') {
        toast.innerHTML = `<span class="unlock-icon">🗺</span><span class="unlock-text">地點解鎖：<strong>${item.name}</strong><br><small>${item.hint}</small></span>`;
        // 同時在故事欄顯示
        appendEntry(`【地點解鎖】${item.name}已可前往——${item.hint}`, 'system');
      } else {
        toast.innerHTML = `<span class="unlock-icon">📜</span><span class="unlock-text">新任務：<strong>${item.title}</strong></span>`;
        appendEntry(`【任務解鎖】「${item.title}」現在可以接取`, 'system');
      }
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.classList.add('animate__slideOutLeft');
        setTimeout(() => toast.remove(), 500);
      }, 4000);
    }, i * 4500);
  });
}

document.getElementById('btn-achievements').addEventListener('click', async () => {
  const res = await fetch('/api/achievements');
  const data = await res.json();
  const list = document.getElementById('achievement-list');
  list.innerHTML = '';

  data.all.forEach(ach => {
    const earned = data.earned.some(e => e.id === ach.id);
    const item = document.createElement('div');
    item.className = `achievement-item ${earned ? 'earned' : 'locked'}`;
    item.innerHTML = `
      <div class="ach-icon">${earned ? '🏆' : '🔒'}</div>
      <div class="ach-info">
        <div class="ach-title">${ach.title}</div>
        <div class="ach-desc">${earned ? ach.desc : '???'}</div>
      </div>
    `;
    list.appendChild(item);
  });

  achieveModal.classList.remove('hidden');
});

document.getElementById('btn-close-achievement').addEventListener('click', () => {
  achieveModal.classList.add('hidden');
});

// ══════════════════════════════════════════════════════════════
// 存讀檔
// ══════════════════════════════════════════════════════════════
document.getElementById('btn-save').addEventListener('click', () => { modalMode = 'save'; openModal(); });
document.getElementById('btn-load').addEventListener('click', () => { modalMode = 'load'; openModal(); });
document.getElementById('btn-close-modal').addEventListener('click', () => saveModal.classList.add('hidden'));
document.getElementById('btn-menu').addEventListener('click', () => {
  if (confirm('回到主選單？（未存檔的進度將會遺失）')) switchToTitle();
});

async function openModal() {
  document.getElementById('modal-title').textContent = modalMode === 'save' ? '存　檔' : '讀　檔';
  const res = await fetch('/api/saves');
  const saves = await res.json();
  const container = document.getElementById('save-slots');
  container.innerHTML = '';

  saves.forEach(s => {
    const btn = document.createElement('button');
    btn.className = 'save-slot';
    btn.innerHTML = s.empty
      ? `存檔位 ${s.slot}　<span class="slot-meta">（空）</span>`
      : `存檔位 ${s.slot}　${s.name}<span class="slot-meta">${s.time}</span>`;
    btn.addEventListener('click', () => handleSlotClick(s.slot));
    container.appendChild(btn);
  });

  saveModal.classList.remove('hidden');
}

async function handleSlotClick(slot) {
  saveModal.classList.add('hidden');
  if (modalMode === 'save') {
    await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot }) });
    appendEntry(`── 存檔完成（位置 ${slot}）──`, 'system');
  } else {
    const res = await fetch('/api/load', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot }) });
    const data = await res.json();
    if (data.success) {
      storyOutput.innerHTML = '';
      switchToGame(data.state);
      appendEntry(`── 讀取存檔（位置 ${slot}）──`, 'system');
      await sendAction('【讀取存檔】簡短描述當前場景讓玩家回憶情境，並給出3個行動選項繼續遊戲。');
    }
  }
}

// ══════════════════════════════════════════════════════════════
// 自動存檔（每 5 分鐘）
// ══════════════════════════════════════════════════════════════
function startAutoSave() {
  stopAutoSave();
  autoSaveTimer = setInterval(async () => {
    try {
      await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot: 1 }) });
      // Silent auto-save to slot 1
    } catch (e) {
      console.warn('[自動存檔] 失敗:', e);
    }
  }, 5 * 60 * 1000); // every 5 minutes
}

function stopAutoSave() {
  if (autoSaveTimer) { clearInterval(autoSaveTimer); autoSaveTimer = null; }
}

// ══════════════════════════════════════════════════════════════
// 帳號系統
// ══════════════════════════════════════════════════════════════
async function checkAuth() {
  if (!authToken) { updateAccountUI(null); return; }
  const res = await fetch('/api/auth/me', {
    headers: { 'Authorization': `Bearer ${authToken}` }
  }).catch(() => null);
  if (res?.ok) {
    const data = await res.json();
    currentUser = data.user || data;
    updateAccountUI(currentUser);
  } else {
    authToken = null;
    localStorage.removeItem('wuxia_token');
    updateAccountUI(null);
  }
}

function updateAccountUI(user) {
  const loggedOut = document.getElementById('account-logged-out');
  const loggedIn  = document.getElementById('account-logged-in');
  const nameEl    = document.getElementById('account-username-display');
  if (!loggedOut || !loggedIn) return;
  if (user) {
    loggedOut.classList.add('hidden');
    loggedIn.classList.remove('hidden');
    if (nameEl) nameEl.textContent = `⚔ ${user.username || user.name || '旅人'}`;
  } else {
    loggedOut.classList.remove('hidden');
    loggedIn.classList.add('hidden');
  }
}

async function handleLogin() {
  const username = document.getElementById('login-username')?.value.trim();
  const password = document.getElementById('login-password')?.value;
  const errEl    = document.getElementById('login-error');
  if (!username || !password) { if (errEl) { errEl.textContent = '請填寫帳號和密碼'; errEl.classList.remove('hidden'); } return; }
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (res.ok && data.token) {
    authToken = data.token;
    localStorage.setItem('wuxia_token', authToken);
    currentUser = data.user;
    updateAccountUI(currentUser);
    document.getElementById('login-modal')?.classList.add('hidden');
    // 清除輸入框
    if (document.getElementById('login-username')) document.getElementById('login-username').value = '';
    if (document.getElementById('login-password')) document.getElementById('login-password').value = '';
    if (errEl) errEl.classList.add('hidden');
  } else {
    if (errEl) { errEl.textContent = data.error || '登入失敗'; errEl.classList.remove('hidden'); }
  }
}

async function handleRegister() {
  const username = document.getElementById('reg-username')?.value.trim();
  const password = document.getElementById('reg-password')?.value;
  const email    = document.getElementById('reg-email')?.value.trim();
  const errEl    = document.getElementById('reg-error');
  if (!username || !password) { if (errEl) { errEl.textContent = '請填寫必要欄位'; errEl.classList.remove('hidden'); } return; }
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, email })
  });
  const data = await res.json();
  if (res.ok && data.token) {
    authToken = data.token;
    localStorage.setItem('wuxia_token', authToken);
    currentUser = data.user;
    updateAccountUI(currentUser);
    document.getElementById('register-modal')?.classList.add('hidden');
    // 清除輸入框
    if (document.getElementById('reg-username')) document.getElementById('reg-username').value = '';
    if (document.getElementById('reg-password')) document.getElementById('reg-password').value = '';
    if (document.getElementById('reg-email')) document.getElementById('reg-email').value = '';
    if (errEl) errEl.classList.add('hidden');
  } else {
    if (errEl) { errEl.textContent = data.error || '註冊失敗'; errEl.classList.remove('hidden'); }
  }
}

function handleLogout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('wuxia_token');
  updateAccountUI(null);
}

// ── 帳號按鈕事件綁定 ──
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-login-open')?.addEventListener('click', () => {
    document.getElementById('login-modal')?.classList.remove('hidden');
  });
  document.getElementById('btn-register-open')?.addEventListener('click', () => {
    document.getElementById('register-modal')?.classList.remove('hidden');
  });
  document.getElementById('btn-login-cancel')?.addEventListener('click', () => {
    document.getElementById('login-modal')?.classList.add('hidden');
  });
  document.getElementById('btn-register-cancel')?.addEventListener('click', () => {
    document.getElementById('register-modal')?.classList.add('hidden');
  });
  document.getElementById('btn-login-submit')?.addEventListener('click', handleLogin);
  document.getElementById('btn-register-submit')?.addEventListener('click', handleRegister);
  document.getElementById('btn-logout')?.addEventListener('click', handleLogout);
  document.getElementById('switch-to-register')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('login-modal')?.classList.add('hidden');
    document.getElementById('register-modal')?.classList.remove('hidden');
  });
  // 頁面載入時自動驗證 token
  checkAuth();
});

// ══════════════════════════════════════════════════════════════
// 音效系統（Howler.js）
// ══════════════════════════════════════════════════════════════
let currentBGM = null;
let bgmEnabled = true;
let sfxEnabled = true;

// ══════════════════════════════════════════════════════════════
// 玩家回饋系統（Alpha 測試）
// ══════════════════════════════════════════════════════════════
let feedbackType = 'bug';

function toggleFeedbackPanel() {
  const panel = document.getElementById('feedback-panel');
  if (!panel) return;
  panel.classList.toggle('hidden');
}

function setFeedbackType(type) {
  feedbackType = type;
  document.querySelectorAll('.feedback-type-btn').forEach(btn => {
    if (btn.dataset.type === type) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

async function sendFeedback() {
  const text = document.getElementById('feedback-text')?.value || '';
  const contact = document.getElementById('feedback-contact')?.value || '';

  if (!text.trim()) {
    alert('請輸入回饋內容');
    return;
  }

  const state = await fetch('/api/state').then(r => r.json()).catch(() => null);
  const res = await fetch('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: feedbackType, message: text, state_snapshot: state, contact })
  });

  if (res.ok) {
    alert('感謝你的回饋！已提交成功。');
    document.getElementById('feedback-text').value = '';
    document.getElementById('feedback-contact').value = '';
    toggleFeedbackPanel();
  } else {
    alert('回饋提交失敗，請稍後重試。');
  }
}

// BGM 音效（使用免費 CDN 音效，或本地檔案）
const BGM_TRACKS = {
  title:  { src: ['https://cdn.freesound.org/previews/331/331848_4517009-lq.mp3'], volume: 0.3 },
  town:   { src: ['https://cdn.freesound.org/previews/352/352543_5678382-lq.mp3'], volume: 0.25 },
  combat: { src: ['https://cdn.freesound.org/previews/242/242054_1022651-lq.mp3'], volume: 0.4 },
  anomaly:{ src: ['https://cdn.freesound.org/previews/328/328846_5121236-lq.mp3'], volume: 0.2 },
};

function playBGM(trackKey) {
  if (!bgmEnabled || !window.Howl) return;
  if (currentBGM) { try { currentBGM.fade(currentBGM.volume(), 0, 800); setTimeout(() => { try { currentBGM.stop(); } catch(e) {} }, 800); } catch(e) {} }
  const t = BGM_TRACKS[trackKey];
  if (!t) return;
  try {
    currentBGM = new Howl({ ...t, loop: true, html5: true });
    currentBGM.play();
  } catch(e) {}
}

function playSFX(type) {
  if (!sfxEnabled || !window.Howl) return;
  const sfxMap = {
    click:   { src: ['https://cdn.freesound.org/previews/242/242501_4642680-lq.mp3'], volume: 0.5 },
    action:  { src: ['https://cdn.freesound.org/previews/414/414209_5121236-lq.mp3'], volume: 0.4 },
    anomaly: { src: ['https://cdn.freesound.org/previews/442/442862_9015704-lq.mp3'], volume: 0.6 },
    victory: { src: ['https://cdn.freesound.org/previews/320/320775_527080-lq.mp3'],  volume: 0.5 },
    achieve: { src: ['https://cdn.freesound.org/previews/220/220206_4062977-lq.mp3'], volume: 0.7 },
  };
  const s = sfxMap[type];
  if (!s) return;
  try { new Howl({ ...s, html5: true }).play(); } catch(e) {}
}

// 音量控制 UI（右上角靜音按鈕）
(function initAudioControls() {
  const audioBtn = document.createElement('button');
  audioBtn.id = 'btn-audio';
  audioBtn.title = '音效開關';
  audioBtn.textContent = '🔊';
  audioBtn.style.cssText = 'position:fixed;top:12px;right:12px;z-index:999;background:rgba(30,20,50,0.7);border:1px solid #3a3a55;color:#c8c0b0;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:0.85rem;';
  audioBtn.addEventListener('click', () => {
    bgmEnabled = !bgmEnabled;
    sfxEnabled = !sfxEnabled;
    audioBtn.textContent = bgmEnabled ? '🔊' : '🔇';
    if (!bgmEnabled && currentBGM) { try { currentBGM.pause(); } catch(e) {} }
    else if (bgmEnabled && currentBGM) { try { currentBGM.play(); } catch(e) {} }
  });
  document.body.appendChild(audioBtn);
})();

// ══════════════════════════════════════════════════════════════
// 標題畫面粒子動畫
// ══════════════════════════════════════════════════════════════
(function initTitleParticles() {
  const container = document.getElementById('title-particles');
  if (!container) return;
  const symbols = ['✦','⊰','⊱','◆','◇','✧','❋','⟡','⬡'];
  const count = 30;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    const size = 8 + Math.random() * 16;
    const x = Math.random() * 100;
    const y = Math.random() * 100;
    const duration = 6 + Math.random() * 10;
    const delay = Math.random() * -10;
    p.textContent = symbols[Math.floor(Math.random() * symbols.length)];
    p.style.cssText = `
      position:absolute; left:${x}%; top:${y}%;
      font-size:${size}px; color:rgba(196,154,42,${0.05 + Math.random() * 0.2});
      animation: particleFloat ${duration}s ${delay}s infinite ease-in-out;
      pointer-events:none; user-select:none;
    `;
    container.appendChild(p);
  }
  // 注入粒子動畫 CSS
  const style = document.createElement('style');
  style.textContent = `
    @keyframes particleFloat {
      0%,100% { transform: translateY(0px) rotate(0deg) scale(1); opacity: 0.3; }
      25%      { transform: translateY(-20px) rotate(10deg) scale(1.1); opacity: 0.8; }
      50%      { transform: translateY(-8px) rotate(-5deg) scale(0.95); opacity: 0.5; }
      75%      { transform: translateY(-30px) rotate(15deg) scale(1.05); opacity: 0.7; }
    }
    #title-particles { position:absolute; inset:0; overflow:hidden; pointer-events:none; }
    /* 異常事件閃爍效果 */
    .anomaly-entry { animation: anomalyPulse 0.5s ease-in-out; }
    @keyframes anomalyPulse { 0% { background: rgba(139,42,74,0.3); } 100% { background: transparent; } }
    /* 結局畫面 */
    .ending-entry { border: 1px solid #c49a2a; background: rgba(30,20,10,0.8); padding: 1.5rem; border-radius: 8px; text-align: center; }
    .ending-title { font-size: 1.4rem; color: #c49a2a; margin-bottom: 1rem; letter-spacing: .3rem; }
    /* 音效按鈕 */
    #btn-audio:hover { background: rgba(50,35,80,0.9); }
  `;
  document.head.appendChild(style);
})();

// ══════════════════════════════════════════════════════════════
// 標題畫面自動播放 BGM
// ══════════════════════════════════════════════════════════════
document.getElementById('btn-new-game').addEventListener('click', () => { playSFX('click'); }, true);
document.getElementById('btn-load-game').addEventListener('click', () => { playSFX('click'); }, true);

// ══════════════════════════════════════════════════════════════
// 初始化
// ══════════════════════════════════════════════════════════════
(async () => {
  // 載入多語言資源
  await loadI18n(currentLang);

  // 更新語言按鈕的 active 狀態
  document.querySelectorAll('.lang-btn').forEach(btn => {
    if (btn.dataset.lang === currentLang) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // 監聽語言切換
  window.addEventListener('languageChanged', () => {
    document.querySelectorAll('.lang-btn').forEach(btn => {
      if (btn.dataset.lang === currentLang) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  });

  // 載入遊戲狀態
  const res = await fetch('/api/state');
  const data = await res.json();
  if (data.world) updateUI(data);
})();

// 載入 Howler.js（動態）
(function loadHowler() {
  if (window.Howl) return;
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/howler/2.2.4/howler.min.js';
  s.onload = () => { console.log('[音效] Howler.js 載入完成'); };
  s.onerror = () => { console.warn('[音效] Howler.js 載入失敗，音效停用'); };
  document.head.appendChild(s);
})();
