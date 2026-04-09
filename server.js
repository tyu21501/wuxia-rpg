import express from 'express';
import compression from 'compression';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { generateNarrative, generateNpcDialogue, parseAndApplyStateBlock } from './narrative-engine.mjs';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// ── 壓縮中間件（節省網路流量 ~60-80%）──
app.use(compression({ level: 6, threshold: 512 }));

app.use(express.json());
app.use(express.static(join(__dirname, 'public'), {
  maxAge: '1h',                // 靜態資源快取 1 小時
  etag: true,
  lastModified: true,
}));

// ── 簡易記憶體快取（降低磁碟 I/O）──
const _cache = new Map();
const CACHE_TTL = 5000; // 5 秒
function cachedRead(key, readFn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;
  const data = readFn();
  _cache.set(key, { data, ts: Date.now() });
  return data;
}
function invalidateCache(key) { _cache.delete(key); }

// ── 安全標頭 ──
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ══════════════════════════════════════════════════════════════
// AI 後端選擇
// ══════════════════════════════════════════════════════════════
const USE_OLLAMA = process.env.USE_OLLAMA === 'true';
let callAI;

// ── 本地備用敘事引擎（無需 API，API 失敗時自動切換）──
// 使用 narrative-engine.mjs 的豐富敘事庫
function localNarrative(action, state) {
  return generateNarrative(action, state);
}

if (USE_OLLAMA) {
  const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
  const ollamaClient = new OpenAI({ apiKey: 'ollama', baseURL: OLLAMA_BASE });
  const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-r1:8b';
  console.log(`[AI] Ollama 模式：${OLLAMA_BASE}  模型：${OLLAMA_MODEL}`);
  // fallbackFn?: () => string — 若提供則 API 失敗時呼叫，否則用通用 localNarrative
  callAI = async (systemPrompt, messages, state, fallbackFn) => {
    try {
      const res = await ollamaClient.chat.completions.create({
        model: OLLAMA_MODEL, max_tokens: 1200,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
      });
      return res.choices[0].message.content;
    } catch (e) {
      console.warn('[敘事引擎] Ollama 失敗，切換備用模式:', e.message?.slice(0, 80));
      if (fallbackFn) return fallbackFn();
      const lastMsg = messages[messages.length - 1]?.content || '';
      return localNarrative(lastMsg, state || {});
    }
  };
} else {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  // fallbackFn?: () => string — 若提供則 API 失敗時呼叫，否則用通用 localNarrative
  callAI = async (systemPrompt, messages, state, fallbackFn) => {
    try {
      const res = await anthropic.messages.create({
        model: ANTHROPIC_MODEL, max_tokens: 1200,
        system: systemPrompt, messages,
      });
      return res.content[0].text;
    } catch (e) {
      // API 失敗（餘額不足、網路錯誤、未設 key 等）→ 自動切換備用敘事
      console.warn('[敘事引擎] API 失敗，切換本地備用模式:', e.message?.slice(0, 80));
      if (fallbackFn) return fallbackFn();
      const lastMsg = messages[messages.length - 1]?.content || '';
      return localNarrative(lastMsg, state || {});
    }
  };
}

// ── Vercel 環境偵測：生產環境用 /tmp（可寫），本地用 data/ ──
const IS_PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = IS_PROD ? '/tmp/wuxia-data' : join(__dirname, 'data');
const STATE_FILE = join(DATA_DIR, 'world-state.json');
const SAVES_DIR = join(DATA_DIR, 'saves');
const USERS_DIR = join(DATA_DIR, 'users');
const LEADERBOARD_FILE = join(DATA_DIR, 'leaderboard.json');

// ── 安全建立目錄（Vercel /tmp 可寫，但 __dirname 唯讀）──
try { mkdirSync(DATA_DIR,   { recursive: true }); } catch {}
try { mkdirSync(SAVES_DIR,  { recursive: true }); } catch {}
try { mkdirSync(USERS_DIR,  { recursive: true }); } catch {}

// ── KV 環境偵測（Upstash）──
const USE_KV = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

// ── KV 輔助函式 ──────────────────────────────────────────────
async function kvGet(key) {
  try {
    const r = await fetch(`${process.env.KV_REST_API_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}
async function kvSet(key, value) {
  try {
    await fetch(`${process.env.KV_REST_API_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.stringify(value))
    });
  } catch (e) { console.error('[KV SET]', e.message); }
}

const JWT_SECRET = process.env.JWT_SECRET || 'wuxia-secret-key-change-in-prod';
const JWT_EXPIRY = '7d';

// 啟動時初始化排行榜檔案（本地開發用，KV 環境不需要）
if (!USE_KV) {
  try {
    if (!existsSync(LEADERBOARD_FILE)) {
      writeFileSync(LEADERBOARD_FILE, JSON.stringify({ entries: [] }, null, 2));
    }
  } catch {}
}

// ══════════════════════════════════════════════════════════════
// 地圖定義（10 個地點）
// ══════════════════════════════════════════════════════════════
const LOCATIONS = {
  '青石鎮': {
    label: '青石鎮', desc: '異常事件的起點，無名歸人出沒之處',
    connections: ['玄冥關廢墟', '枯骨峽谷', '沉淵寺', '霧隱山', '古道驛站'],
    unlocked: true, anomaly_level: 1,
    enemy_pool: ['possessed_civilian', 'cultist']
  },
  '霧隱山': {
    label: '霧隱山', desc: '常年雲霧繚繞，山中偶有詭異的歌聲傳出',
    connections: ['青石鎮', '天機閣遺址'],
    unlocked: false, anomaly_level: 2,
    enemy_pool: ['anomaly_beast', 'void_shade']
  },
  '古道驛站': {
    label: '古道驛站', desc: '荒廢的官道驛站，牆上刻滿無人識得的符文',
    connections: ['青石鎮', '血染古橋'],
    unlocked: false, anomaly_level: 1,
    enemy_pool: ['possessed_civilian', 'cultist']
  },
  '玄冥關廢墟': {
    label: '玄冥關廢墟', desc: '三千士兵覆沒之地，異常能量最為濃烈',
    connections: ['青石鎮', '廢棄軍寨', '星淵深洞'],
    unlocked: false, anomaly_level: 4,
    enemy_pool: ['possessed_soldier', 'void_elder']
  },
  '枯骨峽谷': {
    label: '枯骨峽谷', desc: '峽谷中散落著無名骸骨，夜間有聲音',
    connections: ['青石鎮', '廢棄軍寨'],
    unlocked: false, anomaly_level: 2,
    enemy_pool: ['anomaly_beast', 'void_shade']
  },
  '沉淵寺': {
    label: '沉淵寺', desc: '廢棄古寺，據說僧侶曾記錄過「異常」',
    connections: ['青石鎮', '星淵深洞'],
    unlocked: false, anomaly_level: 2,
    enemy_pool: ['cultist', 'void_shade']
  },
  '血染古橋': {
    label: '血染古橋', desc: '橋面永遠乾不透的血跡，橋下傳來均勻的呼吸聲',
    connections: ['古道驛站', '玄冥關廢墟'],
    unlocked: false, anomaly_level: 3,
    enemy_pool: ['possessed_soldier', 'void_shade']
  },
  '廢棄軍寨': {
    label: '廢棄軍寨', desc: '玄冥關守軍的後方補給站，食物尚未腐爛卻空無一人',
    connections: ['枯骨峽谷', '玄冥關廢墟'],
    unlocked: false, anomaly_level: 3,
    enemy_pool: ['possessed_soldier', 'cultist']
  },
  '天機閣遺址': {
    label: '天機閣遺址', desc: '皇室占星機構，殘存大量關於「天際異象」的殘卷',
    connections: ['霧隱山', '星淵深洞'],
    unlocked: false, anomaly_level: 3,
    enemy_pool: ['cultist', 'void_elder']
  },
  '星淵深洞': {
    label: '星淵深洞', desc: '異常的核心起源地，進入者鮮有回頭',
    connections: ['玄冥關廢墟', '沉淵寺', '天機閣遺址'],
    unlocked: false, anomaly_level: 5,
    enemy_pool: ['void_elder', 'void_shade', 'possessed_soldier']
  }
};

// ══════════════════════════════════════════════════════════════
// 進階解鎖條件（地點 + 任務）
// ══════════════════════════════════════════════════════════════
const LOCATION_UNLOCK_CONDITIONS = {
  '青石鎮':     { always: true },
  '古道驛站':   { min_day: 2,
                  hint: '聽說鎮南古道驛站近日有商旅失蹤，牆上刻著無人識得的符文' },
  '枯骨峽谷':   { npc_trust: { innkeeper: 25 }, or_day: 4,
                  hint: '陳掌櫃透露：失蹤商人最後被目擊在鎮東的枯骨峽谷' },
  '霧隱山':     { min_facts: 2, or_rep: { jianghu: 15, containment: 15 },
                  hint: '蒐集足夠線索後，霧隱山的謎聲傳說開始有跡可循' },
  '沉淵寺':     { anomaly_spread: 20, or_npc_trust: { taoist: 20 },
                  hint: '異常擴散加劇，或與玄真道人深談後，廢棄古寺的位置在心中浮現' },
  '玄冥關廢墟': { min_facts: 4, or_rep: { jianghu: 20, containment: 20 },
                  hint: '線索已足夠指引你——通往玄冥關廢墟的路終於清晰' },
  '血染古橋':   { visited_any: ['古道驛站'], anomaly_spread: 25,
                  hint: '古道驛站的符文指向一座傳說中染血的古橋，沿古道北行可達' },
  '廢棄軍寨':   { visited_any: ['枯骨峽谷'], min_day: 5,
                  hint: '峽谷骸骨上的軍牌銘文指向後方的廢棄補給站' },
  '天機閣遺址': { visited_any: ['霧隱山'], min_facts: 5,
                  hint: '霧隱山的謎聲隱隱指向更高處的皇室舊址' },
  '星淵深洞':   { min_facts: 8, anomaly_spread: 55,
                  hint: '當你掌握足夠真相，異常的核心起源才會在意識中顯現' },
};

// 任務解鎖條件：並非所有任務一開始就可接取
const QUEST_UNLOCK_CONDITIONS = {
  find_merchant:       { always: true },                               // 起始任務
  young_warrior_quest: { always: true },                               // 起始任務（衛霖在青石鎮）
  seal_the_well:       { or_day: 3, npc_trust: { innkeeper: 20 } },   // 第3天或與掌櫃建立信任
  ruins_investigation: { visited_any: ['玄冥關廢墟'] },                // 親訪廢墟後解鎖
  fog_mystery:         { visited_any: ['霧隱山'] },                    // 踏上霧隱山後解鎖
  exorcise_soldier:    { visited_any: ['廢棄軍寨'] },                  // 發現軍寨後解鎖
  temple_records:      { visited_any: ['沉淵寺'] },                    // 進入古寺後解鎖
  stargazer_ruins:     { visited_any: ['天機閣遺址'] },                // 探索遺址後解鎖
  bridge_ghost:        { visited_any: ['血染古橋'] },                  // 踏上血染古橋後解鎖
  child_memory:        { npc_trust: { amnesiac_child: 80 } },          // 與無憶孩兒建立深度信任
  physician_dilemma:   { always: true },                               // 起始任務（流浪醫師在青石鎮）
  void_ritual:         { visited_any: ['星淵深洞'], min_facts: 6 },    // 深入星淵且掌握足夠知識
};

// ══════════════════════════════════════════════════════════════
// 進階解鎖檢查函式
// ══════════════════════════════════════════════════════════════
function checkUnlocks(state) {
  const w = state.world;
  const p = state.player;
  const visitedSet = new Set(
    Object.entries(state._location_unlocks || {}).filter(([, v]) => v).map(([k]) => k)
  );
  const newlyUnlocked = [];

  // ── 地點解鎖 ──
  for (const [key, cond] of Object.entries(LOCATION_UNLOCK_CONDITIONS)) {
    if (LOCATIONS[key]?.unlocked) continue;
    let ok = false;
    if (cond.always)                                                       ok = true;
    if (!ok && cond.min_day         && w.day >= cond.min_day)             ok = true;
    if (!ok && cond.or_day          && w.day >= cond.or_day)              ok = true;
    if (!ok && cond.min_facts       && w.known_facts.length >= cond.min_facts) ok = true;
    if (!ok && cond.anomaly_spread  && w.anomaly_spread >= cond.anomaly_spread) ok = true;
    if (!ok && cond.npc_trust) {
      for (const [id, min] of Object.entries(cond.npc_trust))
        if ((state.npcs[id]?.trust ?? -Infinity) >= min) { ok = true; break; }
    }
    if (!ok && cond.or_npc_trust) {
      for (const [id, min] of Object.entries(cond.or_npc_trust))
        if ((state.npcs[id]?.trust ?? -Infinity) >= min) { ok = true; break; }
    }
    if (!ok && cond.or_rep) {
      for (const [rep, min] of Object.entries(cond.or_rep))
        if ((p.reputation[rep] || 0) >= min) { ok = true; break; }
    }
    if (!ok && cond.visited_any) {
      if (cond.visited_any.some(v => visitedSet.has(v))) ok = true;
    }
    if (ok && LOCATIONS[key]) {
      LOCATIONS[key].unlocked = true;
      newlyUnlocked.push({ type: 'location', key, name: LOCATIONS[key].label, hint: cond.hint || '' });
      w.events.push(`【地點解鎖】${LOCATIONS[key].label}：${cond.hint || '可以前往了'}`);
    }
  }

  // ── 任務解鎖 ──
  for (const [id, cond] of Object.entries(QUEST_UNLOCK_CONDITIONS)) {
    if (state.quests.available.includes(id) ||
        state.quests.active.includes(id)    ||
        state.quests.completed.includes(id)) continue;
    let ok = false;
    if (cond.always)                                           ok = true;
    if (!ok && cond.or_day  && w.day >= cond.or_day)         ok = true;
    if (!ok && cond.min_day && w.day >= cond.min_day)        ok = true;
    if (!ok && cond.npc_trust) {
      for (const [npcId, min] of Object.entries(cond.npc_trust))
        if ((state.npcs[npcId]?.trust ?? -Infinity) >= min) { ok = true; break; }
    }
    if (!ok && cond.visited_any) {
      if (cond.visited_any.some(v => visitedSet.has(v))) ok = true;
    }
    if (ok && QUEST_DEFS[id]) {
      state.quests.available.push(id);
      newlyUnlocked.push({ type: 'quest', id, title: QUEST_DEFS[id].title });
    }
  }

  return newlyUnlocked;
}

// ══════════════════════════════════════════════════════════════
// 建築定義
// ══════════════════════════════════════════════════════════════
const BUILDING_DEFS = {
  mountain_gate: { id: 'mountain_gate', name: '山門', identity: 'jianghu', desc: '招募江湖人，每天提升江湖聲望 +2', cost: { stone: 20, wood: 30 }, effect: { rep_jianghu_per_day: 2, capacity: 5 } },
  training_ground: { id: 'training_ground', name: '練武場', identity: 'jianghu', desc: '修練武功，戰鬥攻擊力 +10', cost: { stone: 15, wood: 20 }, effect: { combat_bonus: 10 } },
  alliance_hall: { id: 'alliance_hall', name: '聚義堂', identity: 'jianghu', desc: '江湖人聚集地，接取更多任務', cost: { stone: 25, wood: 35 }, effect: { quest_slots: 3 } },
  containment_cell: { id: 'containment_cell', name: '收容室', identity: 'containment', desc: '收容異常物品，即時降低異常 -15%', cost: { stone: 40, iron: 20 }, effect: { anomaly_control: 15, capacity: 3 } },
  research_lab: { id: 'research_lab', name: '研究院', identity: 'containment', desc: '研究異常，每天自動降低擴散 -1%', cost: { stone: 30, iron: 15 }, effect: { intel_per_day: 1 } },
  seal_array: { id: 'seal_array', name: '封印陣', identity: 'containment', desc: '強力封印，每天降低擴散 -2%', cost: { stone: 50, iron: 30 }, effect: { anomaly_spread_reduction: 5 } },
  corruption_zone: { id: 'corruption_zone', name: '污染區', identity: 'anomaly', desc: '強化異能，每天消耗理智 -3，異常聲望 +3', cost: { void_shard: 10 }, effect: { anomaly_power: 20, sanity_cost_per_day: 3, rep_anomaly_per_day: 3 } },
  void_altar: { id: 'void_altar', name: '虛空祭壇', identity: 'anomaly', desc: '與異界溝通，獲得禁忌知識，每天異常聲望 +5', cost: { void_shard: 20, sanity_cost: 15 }, effect: { forbidden_knowledge: true, rep_anomaly_per_day: 5 } },
  medical_hall: { id: 'medical_hall', name: '醫館', identity: 'none', desc: '治療傷員，每天恢復理智 +5', cost: { stone: 20, wood: 25 }, effect: { sanity_regen_per_day: 5 } },
  watchtower: { id: 'watchtower', name: '望樓', identity: 'none', desc: '監視異常動向，每天額外降低擴散 -1%', cost: { stone: 30, wood: 15 }, effect: { anomaly_delay: 1 } },
};

// ══════════════════════════════════════════════════════════════
// 敵人定義
// ══════════════════════════════════════════════════════════════
const ENEMIES = {
  possessed_civilian: { id: 'possessed_civilian', name: '附身鎮民', hp: 25, maxHp: 25, attack: 6, defense: 2, xp: 10, sanity_drain: 5, anomaly_spread: 1, loot: [{ item: '異常碎布', rate: 0.5 }] },
  cultist: { id: 'cultist', name: '虛空崇拜者', hp: 35, maxHp: 35, attack: 10, defense: 4, xp: 20, sanity_drain: 8, anomaly_spread: 2, loot: [{ item: '祭祀符文', rate: 0.7 }, { item: '破舊典籍', rate: 0.3 }] },
  void_shade: { id: 'void_shade', name: '虛空陰影', hp: 20, maxHp: 20, attack: 15, defense: 0, xp: 30, sanity_drain: 15, anomaly_spread: 3, loot: [{ item: '虛空碎片', rate: 0.9 }] },
  possessed_soldier: { id: 'possessed_soldier', name: '玄冥附身士兵', hp: 55, maxHp: 55, attack: 14, defense: 7, xp: 40, sanity_drain: 10, anomaly_spread: 2, loot: [{ item: '軍刀碎片', rate: 0.6 }, { item: '軍牌', rate: 0.4 }] },
  anomaly_beast: { id: 'anomaly_beast', name: '異化野獸', hp: 45, maxHp: 45, attack: 18, defense: 3, xp: 35, sanity_drain: 12, anomaly_spread: 2, loot: [{ item: '畸變獸核', rate: 0.8 }] },
  void_elder: { id: 'void_elder', name: '虛空長老', hp: 80, maxHp: 80, attack: 22, defense: 8, xp: 100, sanity_drain: 25, anomaly_spread: 5, loot: [{ item: '封印之石', rate: 0.9 }, { item: '天外文字', rate: 0.6 }] },
};

// ══════════════════════════════════════════════════════════════
// 任務定義
// ══════════════════════════════════════════════════════════════
const QUEST_DEFS = {
  find_merchant: { id: 'find_merchant', title: '失蹤商人', desc: '客棧掌櫃說一位商人三天前進了枯骨峽谷就再沒回來', location_req: '青石鎮', rep_reward: { jianghu: 15 }, resource_reward: { stone: 15, wood: 10 }, item_reward: '商人遺物', sanity_reward: 5 },
  seal_the_well: { id: 'seal_the_well', title: '封印邪井', desc: '鎮中心古井滲出黑色液體，鎮民說有東西在看著他們', location_req: '青石鎮', rep_reward: { containment: 20, jianghu: 10 }, resource_reward: { iron: 10 }, item_reward: '古老封印符', sanity_reward: 10 },
  ruins_investigation: { id: 'ruins_investigation', title: '廢墟調查', desc: '玄冥關廢墟深處有守軍留下的軍務日誌，記錄著事件真相', location_req: '玄冥關廢墟', rep_reward: { containment: 25 }, resource_reward: { void_shard: 5 }, item_reward: '軍務日誌', sanity_reward: 0 },
  fog_mystery: { id: 'fog_mystery', title: '霧中謎聲', desc: '霧隱山深處的歌聲被多名樵夫聽見，沒有人找得到聲音來源', location_req: '霧隱山', rep_reward: { jianghu: 10, anomaly: 10 }, resource_reward: { void_shard: 3 }, item_reward: '霧中殘影', sanity_reward: -5 },
  exorcise_soldier: { id: 'exorcise_soldier', title: '驅除附身', desc: '廢棄軍寨中有被異常附身的士兵，需要解除附身或了結他們', location_req: '廢棄軍寨', rep_reward: { jianghu: 20, containment: 15 }, resource_reward: { iron: 20 }, item_reward: '士兵遺信', sanity_reward: -10 },
  temple_records: { id: 'temple_records', title: '古寺典籍', desc: '沉淵寺的僧侶曾秘密記錄異常現象，那些典籍可能解開一切謎題', location_req: '沉淵寺', rep_reward: { containment: 30 }, resource_reward: { void_shard: 8 }, item_reward: '異常典籍', sanity_reward: -5 },
  stargazer_ruins: { id: 'stargazer_ruins', title: '星象殘卷', desc: '天機閣的占星殘卷記載了玄冥關事件前的天象異象', location_req: '天機閣遺址', rep_reward: { containment: 20, anomaly: 15 }, resource_reward: { void_shard: 10 }, item_reward: '星象殘卷', sanity_reward: -8 },
  young_warrior_quest: { id: 'young_warrior_quest', title: '少俠的誓言', desc: '少俠衛霖的父親是玄冥關守軍之一，他要你幫他找到父親最後的消息', location_req: '青石鎮', rep_reward: { jianghu: 25 }, resource_reward: { wood: 20 }, item_reward: '衛將軍令牌', sanity_reward: 5 },
  // ── Sprint 4 新增任務 ─────────────────────────────────────────
  bridge_ghost:        { id: 'bridge_ghost', title: '古橋冤魂', desc: '血染古橋下夜夜傳出哭聲，當地人說是被異常殺死的旅人的冤魂在徘徊，需要超度或查明真相', location_req: '血染古橋', rep_reward: { jianghu: 20, containment: 10 }, resource_reward: { iron: 15, wood: 10 }, item_reward: '冤魂遺物', sanity_reward: -8 },
  child_memory:        { id: 'child_memory', title: '找回記憶', desc: '無憶孩兒反覆念叨的數字似乎是某種座標或密碼，解開它或許能找到她遺失的過去', location_req: '青石鎮', rep_reward: { containment: 30, jianghu: 10 }, resource_reward: { void_shard: 6 }, item_reward: '孩兒記憶碎片', sanity_reward: 0 },
  physician_dilemma:   { id: 'physician_dilemma', title: '醫者困境', desc: '流浪醫師宋懷仁的藥材被異常污染，他需要你協助找到替代藥材或安撫患者，病人正在瘋狂邊緣', location_req: '青石鎮', rep_reward: { jianghu: 15, containment: 15 }, resource_reward: { stone: 10, wood: 15 }, item_reward: '解毒藥方', sanity_reward: 10 },
  void_ritual:         { id: 'void_ritual', title: '虛空祭祀', desc: '星淵深洞內壁的符文描述了一個可以「問詢虛空」的儀式，代價是理智，但可能獲得異常路線的關鍵知識', location_req: '星淵深洞', rep_reward: { anomaly: 35 }, resource_reward: { void_shard: 15 }, item_reward: '虛空啟示錄', sanity_reward: -20 },
};

// ══════════════════════════════════════════════════════════════
// 異常事件池（12 個）
// ══════════════════════════════════════════════════════════════
const ANOMALY_EVENTS = [
  { id: 'whisper',         trigger_spread: 10, title: '耳語',       desc: '鎮民開始聽見無人發出的耳語，內容皆為死者的名字',                                     sanity_delta: -5,  stability_delta: -5  },
  { id: 'cold_breath',     trigger_spread: 15, title: '寒氣入骨',   desc: '鎮中出現幾個地點終年不化的冷氣，接近時鼻息成霜，那裡曾是玄冥關士兵休息的地方',       sanity_delta: -7,  stability_delta: -6  },
  { id: 'mirror',          trigger_spread: 20, title: '鏡中異象',   desc: '井水倒影顯示的不是觀看者的臉，而是另一個人',                                         sanity_delta: -10, stability_delta: -8  },
  { id: 'memory_loss',     trigger_spread: 30, title: '記憶侵蝕',   desc: '部分鎮民開始忘記彼此，如同無名歸人的詛咒蔓延',                                       sanity_delta: -15, stability_delta: -15 },
  { id: 'animal_exodus',   trigger_spread: 35, title: '百獸逃離',   desc: '鎮子附近的動物開始大規模向同一方向逃跑——方向正好與玄冥關相反，牠們似乎嗅到了什麼', sanity_delta: -8,  stability_delta: -12 },
  { id: 'star_map',        trigger_spread: 40, title: '星圖夢境',   desc: '習武之人修煉時夢見同一幅星圖，指向玄冥關方向',                                       sanity_delta: -10, stability_delta: -5  },
  { id: 'blood_rain',      trigger_spread: 48, title: '血色晨霧',   desc: '清晨的霧氣帶有淡淡血腥味，凝結在衣物上留下紅色痕跡',                                 sanity_delta: -12, stability_delta: -10 },
  { id: 'void_crack',      trigger_spread: 55, title: '虛空裂縫',   desc: '青石鎮邊緣出現空間扭曲，透過裂縫可見不屬於此世的景象',                               sanity_delta: -20, stability_delta: -20 },
  { id: 'shadow_people',   trigger_spread: 62, title: '陰影行人',   desc: '夜間出現無實體的人影，動作與白天見過的人一模一樣卻無臉',                             sanity_delta: -18, stability_delta: -15 },
  { id: 'mass_amnesia',    trigger_spread: 70, title: '集體遺忘',   desc: '全鎮有三成人口同時忘記了自己的名字',                                                 sanity_delta: -25, stability_delta: -30 },
  { id: 'reverse_time',    trigger_spread: 76, title: '時光倒流',   desc: '持續三刻鐘內，某些地點物品倒退至昨日狀態，死去的家禽又活了回來',                     sanity_delta: -22, stability_delta: -20 },
  { id: 'void_whisper_mass', trigger_spread: 80, title: '萬人同夢', desc: '整鎮所有人在同一夜做了同樣的夢：無盡的黑暗中，有無數雙眼睛在看他們',                 sanity_delta: -28, stability_delta: -25 },
  { id: 'final_sign',      trigger_spread: 85, title: '終末徵兆',   desc: '天空出現異常星象，玄冥關方向有巨大不明物體移動',                                     sanity_delta: -30, stability_delta: -40 },
  { id: 'reality_fracture',trigger_spread: 92, title: '現實碎裂',   desc: '部分建築同時呈現兩個不同狀態——同時是廢墟也是完好的',                               sanity_delta: -35, stability_delta: -35 },
  { id: 'name_erasure',    trigger_spread: 97, title: '名字消失',   desc: '所有書寫下來的名字開始自行消失，無名歸人的詛咒蔓延至文字本身',                       sanity_delta: -40, stability_delta: -50 },
];

// ══════════════════════════════════════════════════════════════
// 結局條件（9 個）
// ══════════════════════════════════════════════════════════════
const ENDINGS = [
  { id: 'seal_jianghu',        title: '劍封玄冥',   condition: s => s.world.anomaly_spread < 30 && s.player.reputation.jianghu >= 80 && s.player.identity === 'jianghu',                                          desc: '以江湖之力封印異常，青石鎮恢復平靜，但封印者永遠無法離開' },
  { id: 'research_containment',title: '檔案終結',   condition: s => s.world.known_facts.length >= 10 && s.player.reputation.containment >= 80 && s.player.identity === 'containment',                              desc: '完整記錄並收容所有異常，你成為秘密組織的傳奇調查員' },
  { id: 'coexist_anomaly',     title: '虛空同行',   condition: s => s.player.reputation.anomaly >= 80 && s.player.identity === 'anomaly' && s.player.sanity > 30,                                                  desc: '與異常融合共存，獲得超越人類的感知，但永遠不再是人' },
  { id: 'destroy_all',         title: '焚天滅異',   condition: s => s.world.anomaly_spread <= 0 && s.world.town_stability >= 80,                                                                                    desc: '徹底消滅異常，世界回歸正軌，但消滅的代價無人知曉' },
  { id: 'sacrifice_jianghu',   title: '以命換命',   condition: s => s.player.reputation.jianghu >= 60 && s.player.sanity < 20 && s.world.town_stability > 50,                                                      desc: '以殘存的理智作為最後的犧牲，以一人之瘋換整鎮之安' },
  { id: 'escape_truth',        title: '逃離真相',   condition: s => s.world.day >= 20 && s.world.known_facts.length >= 7 && s.player.sanity > 60 && s.world.anomaly_spread < 50,                                   desc: '帶著所知的真相離開青石鎮，但你永遠無法確定那些記憶是否真實' },
  { id: 'nameless_become',     title: '無名化身',   condition: s => s.player.reputation.anomaly >= 60 && s.player.identity === 'anomaly' && s.world.anomaly_spread >= 70,                                          desc: '你不再記得自己的名字——你成為了下一個「無名歸人」' },
  { id: 'bad_end_madness',     title: '理智崩潰',   condition: s => s.player.sanity <= 0,                                                                                                                           desc: '理智耗盡，你成為了新的異常現象' },
  { id: 'bad_end_collapse',    title: '鎮毀人亡',   condition: s => s.world.town_stability <= 0,                                                                                                                     desc: '青石鎮徹底崩潰，異常吞噬一切' },
  // ── Sprint 4 新增結局 ─────────────────────────────────────────
  { id: 'unnamed_accord',      title: '無名契約',   condition: s => s.npcs.unnamed_survivor?.trust >= 60 && s.world.known_facts.length >= 6 && s.player.sanity > 40,                                                desc: '你與無名歸人達成了某種超越語言的協議。他帶走了異常，而你帶走了無法向任何人解釋的記憶' },
  { id: 'physician_salvation', title: '以藥渡劫',   condition: s => s.quests.completed.includes('physician_dilemma') && s.player.reputation.jianghu >= 50 && s.world.town_stability >= 60,                          desc: '宋醫師的藥救了無數人。在異常的侵蝕中，人性的溫度竟成了最後的防線，青石鎮僥倖得以延續' },
];

// ══════════════════════════════════════════════════════════════
// 預設狀態
// ══════════════════════════════════════════════════════════════
function getDefaultState() {
  return {
    player: {
      name: '旅人', identity: 'none',
      character: null,
      sanity: 100, maxSanity: 100,
      reputation: { jianghu: 0, containment: 0, anomaly: 0 },
      skills: [], inventory: [],
      combat: { power: 10, defense: 5, anomaly_resist: 0, level: 1, xp: 0 }
    },
    world: {
      location: '青石鎮',
      anomaly_spread: 5, town_stability: 100,
      day: 1, time: '傍晚',
      known_facts: [],
      events: ['無名歸人三天前出現在青石鎮，無人認識他'],
      phase: 'early',
      triggered_events: [],
      resources: { stone: 10, wood: 20, iron: 0, void_shard: 0 }
    },
    npcs: {
      unnamed_survivor: { name: '無名歸人',   trust: 0,  fear: 50, revealed_info: [], alive: true, location: '青石鎮破廟',     description: '玄冥關一役全軍覆沒，三個月後他獨自走回。沒有任何人記得他。' },
      innkeeper:        { name: '陳掌櫃',     trust: 20, fear: 10, revealed_info: [], alive: true, location: '悅來客棧',       description: '青石鎮悅來客棧的老掌櫃，見多識廣，消息靈通。' },
      elder:            { name: '鎮長李老爺', trust: 10, fear: 30, revealed_info: [], alive: true, location: '鎮長府',         description: '鎮長，想把無名歸人的事壓下去，維持鎮子安定。' },
      young_warrior:    { name: '少俠衛霖',   trust: 30, fear: 5,  revealed_info: [], alive: true, location: '青石鎮演武場',   description: '年輕氣盛的習武少年，發誓要查清玄冥關真相為父報仇。' },
      taoist:           { name: '玄真道人',   trust: 0,  fear: 20, revealed_info: [], alive: true, location: '沉淵寺',         description: '自稱能「觀異」的道士，言行神秘，似乎知道一些外人不知道的事。' },
      wounded_soldier:  { name: '殘兵張三',   trust: -10,fear: 80, revealed_info: [], alive: true, location: '廢棄軍寨',       description: '玄冥關事件的幸存者之一，因過度驚嚇幾近瘋癲，說話前言不搭後語。' },
      storyteller:      { name: '說書人柳白', trust: 40, fear: 0,  revealed_info: [], alive: true, location: '悅來客棧',       description: '走遍江湖的老說書人，記憶力異常好，似乎什麼都見過，什麼都記得。' },
      amnesiac_child:   { name: '無憶孩兒',   trust: 70, fear: 10, revealed_info: [], alive: true, location: '枯骨峽谷',       description: '在峽谷被發現的孩子，不記得自己的名字和過去，只會重複說一串數字。' },
      wandering_physician: { name: '流浪醫師宋懷仁', trust: 15, fear: 5, revealed_info: [], alive: true, location: '青石鎮', description: '遊歷各地的郎中，藥術精湛卻因醫治一名「異常患者」而身陷麻煩，他見過用醫術無法解釋的症狀。' },
    },
    buildings: [],
    anomaly_log: [],
    combat_log: [],
    combat_state: null,
    quests: {
      // 起始僅有三個任務；其餘依劇情條件由 checkUnlocks() 逐步解鎖
      available: ['find_merchant', 'young_warrior_quest', 'physician_dilemma'],
      active: [], completed: []
    },
    achievements: [],
    conversation_history: [],
    turn: 0, started: false,
    ended: false, ending_id: null
  };
}

// ══════════════════════════════════════════════════════════════
// 帳號系統輔助函式
// ══════════════════════════════════════════════════════════════
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: '缺少認證令牌' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: '令牌無效或已過期' });
    req.user = user;
    next();
  });
}

// ── 使用者：KV（生產）或本地 JSON（開發）──
async function loadUser(userId) {
  if (USE_KV) return kvGet(`users:${userId}`);
  const path = join(USERS_DIR, `${userId}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

async function saveUser(user) {
  if (USE_KV) return kvSet(`users:${user.id}`, user);
  const path = join(USERS_DIR, `${user.id}.json`);
  try { writeFileSync(path, JSON.stringify(user, null, 2), 'utf-8'); } catch {}
}

// ── 排行榜：KV（生產）或本地 JSON（開發）──
async function loadLeaderboard() {
  if (USE_KV) return (await kvGet('wuxia:leaderboard')) || { entries: [] };
  try {
    if (!existsSync(LEADERBOARD_FILE)) return { entries: [] };
    return JSON.parse(readFileSync(LEADERBOARD_FILE, 'utf-8'));
  } catch { return { entries: [] }; }
}

async function saveLeaderboard(lb) {
  if (USE_KV) return kvSet('wuxia:leaderboard', lb);
  try { writeFileSync(LEADERBOARD_FILE, JSON.stringify(lb, null, 2)); } catch {}
}

function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      const raw = readFileSync(STATE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      // ── Migration：確保必要欄位存在 ──
      if (!parsed.world.triggered_events) parsed.world.triggered_events = [];
      if (!parsed.quests) parsed.quests = { available: Object.keys(QUEST_DEFS), active: [], completed: [] };
      if (!parsed.achievements) parsed.achievements = [];
      if (!parsed.combat_state) parsed.combat_state = null;
      // 恢復 LOCATIONS 解鎖狀態（全域 LOCATIONS 不持久化，從 state 同步）
      if (parsed._location_unlocks) {
        for (const [loc, unlocked] of Object.entries(parsed._location_unlocks)) {
          if (LOCATIONS[loc]) LOCATIONS[loc].unlocked = unlocked;
        }
      }
      return parsed;
    } catch (e) {
      console.error('[loadState] world-state.json 損壞，使用預設狀態:', e.message);
      const backup = STATE_FILE + '.bak';
      try { writeFileSync(backup, readFileSync(STATE_FILE)); } catch {}
      return getDefaultState();
    }
  }
  return getDefaultState();
}
function saveState(state) {
  if (state.conversation_history.length > 50) state.conversation_history = state.conversation_history.slice(-50);
  state._location_unlocks = Object.fromEntries(Object.entries(LOCATIONS).map(([k, v]) => [k, v.unlocked]));
  // /tmp 可寫（Vercel），__dirname 唯讀；用 try-catch 防止崩潰
  try {
    const tmp = STATE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    // 原子替換失敗時直接寫入
    try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8'); } catch (e2) {
      console.error('[saveState] 保存失敗:', e2.message);
    }
  }
}

// ══════════════════════════════════════════════════════════════
// 系統提示詞
// ══════════════════════════════════════════════════════════════
function buildSystemPrompt(state) {
  const identityLabel = { none: '身份未定的旅人', jianghu: '江湖人', containment: '收容者', anomaly: '異常接觸者' }[state.player.identity] || '旅人';
  const npcSummary = Object.values(state.npcs).map(n =>
    `  - ${n.name}（${n.location}）信任${n.trust} 恐懼${n.fear}${n.revealed_info.length ? ' 已透露：' + n.revealed_info.join('、') : ''}`
  ).join('\n');
  const facts = state.world.known_facts.length > 0 ? state.world.known_facts.map(f => `  - ${f}`).join('\n') : '  （尚無）';
  const buildings = state.buildings.length > 0 ? state.buildings.map(b => `  - ${b.name}`).join('\n') : '  （尚無）';
  const loc = LOCATIONS[state.world.location];
  const connections = loc ? loc.connections.join('、') : '';
  const resources = state.world.resources;
  const activeQuests = state.quests?.active?.map(id => QUEST_DEFS[id]?.title).filter(Boolean).join('、') || '（無）';

  const charInfo = state.player.character
    ? `主角姓名：${state.player.name}　出身：${state.player.character.background}　武學：${state.player.character.martial_style}　性格根骨：${state.player.character.personality}`
    : `主角姓名：${state.player.name}`;

  // 取最近 4 條 AI 回應摘要，避免重複描述同樣場景
  const recentAI = state.conversation_history
    .filter(m => m.role === 'assistant')
    .slice(-4)
    .map(m => cleanNarrative(m.content).slice(0, 60) + '…')
    .join('\n  ');

  return `你是玄冥江湖這部互動武俠恐怖小說的說書人，也是玩家真正的敘事夥伴。

【世界背景】
架空古代中國。三個月前，玄冥關守軍三千人全數覆沒，無一生還。近日，一名士兵獨自走回了青石鎮——他記得所有死去袍澤的名字與面容，卻沒有任何人記得他曾存在過，連他的母親也不認識他。他自己也不知道自己叫什麼。這是第一個異常。

【當前情境】
地點：${state.world.location}（鄰近地點：${connections}）
時間：第${state.world.day}天 ${state.world.time}
${charInfo}
主角身份：${identityLabel}　理智餘量：${state.player.sanity}/${state.player.maxSanity}
異常蔓延：${state.world.anomaly_spread}%　人心穩定：${state.world.town_stability}%
故事階段：${{ early: '序章（異常初現）', mid: '中期（蔓延擴大）', late: '後期（危機逼近）', final: '終局（命運交匯）' }[state.world.phase] || '序章'}
持有：${state.player.inventory.join('、') || '身無長物'}
技藝：${state.player.skills.join('、') || '暫無'}
進行中任務：${activeQuests}
近期事件：${state.world.events.slice(-3).join('；') || '（尚無）'}

【在場可互動的人物】
${npcSummary}

【已知事實】
${facts}

【最近的敘事片段（不要重複這些內容）】
  ${recentAI || '（尚無）'}

【核心寫作原則】
❶ 直接回應玩家的行動。玩家做什麼，世界就對應地發生什麼。每次回應必須讓情節真正推進，而非重述場景。
❷ 字數靈活：簡短行動（問話、移動）100-180字即可；重要場景或事件探索可到 350字。不要為了字數填充無意義的大氣渲染。
❸ 不列選項，不說「你可以」，不暗示下一步。讓玩家自己決定。
❹ 異常現象只描述感官表象，絕不解釋成因。
❺ 江湖人物永遠用武學/鬼神框架誤解異常，但這種誤解要有說服力、有時甚至讓人半信半疑。
❻ 可以自由使用對話、動作、環境、心理等敘事手法混合，不必每次都是純景物描寫。
❼ 全文繁體中文，風格凝練，帶古龍式留白與克蘇魯式宇宙恐懼感。
❽ 重要：對話應真實反映NPC個性，而非公式化的「鎮民說：…」。讓每個角色有獨特聲音。

【NPC個性速查】
無名歸人——茫然、疏離、偶爾說出讓人不寒而慄的話；陳掌櫃——市儈、多話、隱瞞甚多；
鎮長李老爺——強撐鎮定、實則恐懼；少俠衛霖——衝動熱血、不信邪；
玄真道人——睿智沉默、知道比說的多；殘兵張三——神智不清、說瘋話但偶含真相；
說書人柳白——話中帶刺、用典故暗示；無憶孩兒——純真卻說出成人不該知道的事；
流浪醫師宋懷仁——精準觀察、用醫理解釋但也疑惑重重。

【狀態標記格式】（故事段落後，僅有變化時才附加，不顯示給玩家）
《狀態》理智變化:數字 異常變化:數字 穩定變化:數字 身份:文字 江湖聲望:數字 收容聲望:數字 異常聲望:數字 新事實:文字 新事件:文字 新技能:文字 新物品:文字 前往:地名 NPC信任:名稱:數字 NPC恐懼:名稱:數字 任務完成:任務編號《結束》

任務編號：find_merchant / seal_the_well / ruins_investigation / fog_mystery / exorcise_soldier / temple_records / stargazer_ruins / young_warrior_quest / bridge_ghost / child_memory / physician_dilemma / void_ritual

無變化則完全省略狀態標記。`;
}

// ══════════════════════════════════════════════════════════════
// 文字清理
// ══════════════════════════════════════════════════════════════
function cleanNarrative(raw) {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/《狀態》[\s\S]*?《結束》/g, '')
    .replace(/\[STATE_UPDATE\][\s\S]*?\[\/STATE_UPDATE\]/g, '')
    .replace(/\{[\s\S]*?"delta"[\s\S]*?\}/g, '')
    .replace(/^[{}\[\]].*/gm, '')
    .replace(/^\s*"[a-z_]+"\s*:/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ══════════════════════════════════════════════════════════════
// 中文格式狀態解析
// ══════════════════════════════════════════════════════════════
function applyStateUpdateChinese(state, str) {
  try {
    const p = state.player; const w = state.world;
    const get = (key) => { const m = str.match(new RegExp(key + ':(-?[\\d]+)')); return m ? parseInt(m[1]) : 0; };
    const getStr = (key) => { const m = str.match(new RegExp(key + ':([^\\s《》]+)')); return m ? m[1] : ''; };

    const sd = get('理智變化'); if (sd) p.sanity = Math.max(0, Math.min(p.maxSanity, p.sanity + sd));
    const ad = get('異常變化'); if (ad) w.anomaly_spread = Math.min(100, Math.max(0, w.anomaly_spread + ad));
    const td = get('穩定變化'); if (td) w.town_stability = Math.min(100, Math.max(0, w.town_stability + td));
    const rj = get('江湖聲望'); if (rj) p.reputation.jianghu += rj;
    const rc = get('收容聲望'); if (rc) p.reputation.containment += rc;
    const ra = get('異常聲望'); if (ra) p.reputation.anomaly += ra;
    const rs = get('石料'); if (rs) w.resources.stone += rs;
    const rw = get('木材'); if (rw) w.resources.wood += rw;
    const ri = get('鐵料'); if (ri) w.resources.iron += ri;
    const rv = get('虛空'); if (rv) w.resources.void_shard += rv;

    const identity = getStr('身份');
    if (identity && ['jianghu', 'containment', 'anomaly'].includes(identity)) p.identity = identity;

    const fact = getStr('新事實'); if (fact && !w.known_facts.includes(fact)) w.known_facts.push(fact);
    const event = getStr('新事件'); if (event) w.events.push(event);
    const skill = getStr('新技能'); if (skill && !p.skills.includes(skill)) p.skills.push(skill);
    const item = getStr('新物品'); if (item) p.inventory.push(item);

    const moveTo = getStr('前往');
    if (moveTo && LOCATIONS[moveTo]) {
      w.location = moveTo;
      LOCATIONS[moveTo].unlocked = true;
      p.sanity = Math.max(0, p.sanity - LOCATIONS[moveTo].anomaly_level * 2);
    }

    // NPC 信任/恐懼（增量）
    for (const m of str.matchAll(/NPC信任:([^:\s《]+):(-?\d+)/g)) {
      const npc = Object.values(state.npcs).find(n => n.name === m[1]);
      if (npc) npc.trust = Math.max(-100, Math.min(100, npc.trust + parseInt(m[2])));
    }
    for (const m of str.matchAll(/NPC恐懼:([^:\s《]+):(-?\d+)/g)) {
      const npc = Object.values(state.npcs).find(n => n.name === m[1]);
      if (npc) npc.fear = Math.max(0, Math.min(100, npc.fear + parseInt(m[2])));
    }

    // 任務完成
    const questComplete = getStr('任務完成');
    if (questComplete && state.quests) {
      completeQuest(state, questComplete);
    }
  } catch (e) {
    console.error('[狀態解析錯誤]', e.message);
  }
}

// ══════════════════════════════════════════════════════════════
// 任務系統
// ══════════════════════════════════════════════════════════════
function completeQuest(state, questId) {
  if (!state.quests) return;
  const def = QUEST_DEFS[questId];
  if (!def) return;
  if (state.quests.completed.includes(questId)) return;

  state.quests.active = state.quests.active.filter(id => id !== questId);
  state.quests.available = state.quests.available.filter(id => id !== questId);
  state.quests.completed.push(questId);

  // Apply rewards
  if (def.rep_reward) {
    if (def.rep_reward.jianghu)     state.player.reputation.jianghu     += def.rep_reward.jianghu;
    if (def.rep_reward.containment) state.player.reputation.containment += def.rep_reward.containment;
    if (def.rep_reward.anomaly)     state.player.reputation.anomaly     += def.rep_reward.anomaly;
  }
  if (def.resource_reward) {
    if (def.resource_reward.stone)     state.world.resources.stone     += def.resource_reward.stone     || 0;
    if (def.resource_reward.wood)      state.world.resources.wood      += def.resource_reward.wood      || 0;
    if (def.resource_reward.iron)      state.world.resources.iron      += def.resource_reward.iron      || 0;
    if (def.resource_reward.void_shard)state.world.resources.void_shard+= def.resource_reward.void_shard|| 0;
  }
  if (def.item_reward) state.player.inventory.push(def.item_reward);
  if (def.sanity_reward) state.player.sanity = Math.max(0, Math.min(state.player.maxSanity, state.player.sanity + def.sanity_reward));

  // XP and level up
  const xpGain = 25;
  state.player.combat.xp += xpGain;
  checkLevelUp(state);

  checkAchievements(state);
}

// ══════════════════════════════════════════════════════════════
// 戰鬥系統
// ══════════════════════════════════════════════════════════════
function startCombat(state, enemyId) {
  const enemyDef = ENEMIES[enemyId];
  if (!enemyDef) return null;

  state.combat_state = {
    active: true,
    enemy: JSON.parse(JSON.stringify(enemyDef)),
    turn: 0,
    log: [],
    fled: false
  };
  return state.combat_state;
}

function processCombatAction(state, action) {
  const cs = state.combat_state;
  if (!cs || !cs.active) return { error: '當前沒有進行中的戰鬥' };

  const p = state.player;
  const e = cs.enemy;
  let result = { log: [], ended: false, victory: false, fled: false };

  if (action === 'attack') {
    // Player attacks
    const hasTraining = state.buildings.find(b => b.id === 'training_ground');
    const combatBonus = hasTraining ? BUILDING_DEFS.training_ground.effect.combat_bonus : 0;
    const playerAtk = p.combat.power + combatBonus + Math.floor(Math.random() * 6);
    const dmg = Math.max(1, playerAtk - e.defense);
    e.hp = Math.max(0, e.hp - dmg);
    result.log.push(`你出手，造成 ${dmg} 點傷害（敵方剩餘生命：${e.hp}）`);

    if (e.hp <= 0) {
      result.ended = true;
      result.victory = true;
      result.log.push(`【勝利】${e.name}被擊敗了！`);
      // Rewards
      p.combat.xp += e.xp;
      const lootItems = e.loot.filter(l => Math.random() < l.rate).map(l => l.item);
      lootItems.forEach(item => p.inventory.push(item));
      if (lootItems.length) result.log.push(`獲得：${lootItems.join('、')}`);
      checkLevelUp(state);
      cs.active = false;
      state.combat_state = null;
      return result;
    }
  } else if (action === 'defend') {
    // Boost defense this turn
    const defBonus = Math.floor(p.combat.defense * 0.5);
    result.log.push(`你採取防禦姿態（本回合防禦 +${defBonus}）`);
    // Enemy still attacks but with penalty
    const enemyDmg = Math.max(0, e.attack - p.combat.defense - defBonus + Math.floor(Math.random() * 4) - 2);
    p.sanity = Math.max(0, p.sanity - Math.floor(e.sanity_drain * 0.5));
    if (enemyDmg > 0) result.log.push(`${e.name}攻擊，但你格擋了大部分，受到 ${enemyDmg} 點傷害（精神衝擊）`);
    else result.log.push(`你完全格擋了${e.name}的攻擊`);
    cs.turn++;
    result.state = getPublicState(state);
    return result;
  } else if (action === 'use_item') {
    result.log.push('你使用了隨身物品補充精力');
    p.sanity = Math.min(p.maxSanity, p.sanity + 10);
    result.log.push('理智恢復 +10');
  } else if (action === 'flee') {
    // 逃跑公式：基礎 40% + 等級加成 5%/級 - 敵方防禦懲罰 3%/點，限制在 10%~85% 之間
    const fleeChance = Math.min(0.85, Math.max(0.10, 0.40 + p.combat.level * 0.05 - e.defense * 0.03));
    if (Math.random() < fleeChance) {
      cs.active = false;
      state.combat_state = null;
      result.fled = true;
      result.ended = true;
      result.log.push('你成功逃脫！');
      p.sanity = Math.max(0, p.sanity - 5);
      return result;
    } else {
      result.log.push('逃跑失敗！');
    }
  }

  // Enemy attacks (if not fled or dead) — 遊戲使用理智作為生命值，敵方造成固定精神傷害
  if (!result.ended) {
    p.sanity = Math.max(0, p.sanity - e.sanity_drain);
    result.log.push(`${e.name}反擊，造成 ${e.sanity_drain} 點精神傷害（理智剩餘：${p.sanity}）`);

    if (p.sanity <= 0) {
      result.ended = true;
      result.victory = false;
      result.log.push('【敗北】你的理智已耗盡……');
      cs.active = false;
      state.combat_state = null;
    }
  }

  cs.turn++;
  result.state = getPublicState(state);
  return result;
}

function checkLevelUp(state) {
  const p = state.player;
  const xpNeeded = p.combat.level * 100;
  if (p.combat.xp >= xpNeeded) {
    p.combat.level++;
    p.combat.xp -= xpNeeded;
    p.combat.power += 3;
    p.combat.defense += 2;
    p.maxSanity = Math.min(120, p.maxSanity + 5);
    p.sanity = Math.min(p.maxSanity, p.sanity + 10);
    state.world.events.push(`【成長】等級提升至 ${p.combat.level}，能力有所增強`);
    checkAchievements(state);
    return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════
// 成就系統
// ══════════════════════════════════════════════════════════════
const ACHIEVEMENTS = [
  // ── 原有成就（保留）────────────────────
  { id: 'first_fact',     title: '初窺真相',   desc: '首次發現確認事實',                  check: s => s.world.known_facts.length >= 1      },
  { id: 'ten_facts',      title: '解謎者',     desc: '發現10個確認事實',                  check: s => s.world.known_facts.length >= 10     },
  { id: 'level_3',        title: '江湖老手',   desc: '等級達到3',                          check: s => s.player.combat.level >= 3           },
  { id: 'three_quests',   title: '行俠仗義',   desc: '完成3個任務',                        check: s => s.quests?.completed?.length >= 3     },
  { id: 'first_build',    title: '據點初立',   desc: '建造第一棟建築',                    check: s => s.buildings.length >= 1             },
  { id: 'sanity_30',      title: '瀕臨崩潰',   desc: '理智降至30以下仍然存活',            check: s => s.player.sanity <= 30 && s.player.sanity > 0 },
  { id: 'anomaly_50',     title: '異常目擊者', desc: '見證異常擴散超過50%',               check: s => s.world.anomaly_spread >= 50         },
  { id: 'all_locations',  title: '踏遍江湖',   desc: '探索所有地點',                       check: s => Object.values(LOCATIONS).every(l => l.unlocked) },

  // ── 探索類成就（5 個）────────────────────
  { id: 'visit_3_loc',    title: '初出茅廬',   desc: '訪問3個不同的地點',                check: s => Object.values(LOCATIONS).filter(l => l.unlocked).length >= 3 },
  { id: 'visit_5_loc',    title: '見聞廣博',   desc: '訪問5個不同的地點',                check: s => Object.values(LOCATIONS).filter(l => l.unlocked).length >= 5 },
  { id: 'visit_8_loc',    title: '行遍十方',   desc: '訪問8個不同的地點',                check: s => Object.values(LOCATIONS).filter(l => l.unlocked).length >= 8 },
  { id: 'secret_chamber', title: '發現密室',   desc: '在廢墟中發現隱藏的密室',            check: s => s.world.known_facts.some(f => f.includes('密室')) },
  { id: 'all_facts_high', title: '真相在握',   desc: '發現15個確認事實',                  check: s => s.world.known_facts.length >= 15     },

  // ── 關係類成就（5 個）────────────────────
  { id: 'max_innkeeper',  title: '掌櫃知己',   desc: '與陳掌櫃達到最高信任',             check: s => s.npcs.innkeeper?.trust >= 80        },
  { id: 'max_young_warrior', title: '並肩同行', desc: '與少俠衛霖達到最高信任',           check: s => s.npcs.young_warrior?.trust >= 80    },
  { id: 'max_taoist',     title: '道法傳承',   desc: '與玄真道人達到最高信任',           check: s => s.npcs.taoist?.trust >= 80           },
  { id: 'max_storyteller', title: '說書人之交', desc: '與說書人柳白達到最高信任',        check: s => s.npcs.storyteller?.trust >= 80      },
  { id: 'four_high_trust', title: '江湖俠杰', desc: '與4個NPC達到高信任度（≥60）',     check: s => Object.values(s.npcs).filter(n => n.trust >= 60).length >= 4 },

  // ── 戰鬥類成就（4 個）────────────────────
  { id: 'first_victory',  title: '初戰告捷',   desc: '贏得第一場戰鬥',                    check: s => s.player.combat.level >= 2           },
  { id: 'level_5',        title: '一代宗師',   desc: '等級達到5',                          check: s => s.player.combat.level >= 5           },
  { id: 'five_quests_done', title: '任俠人生', desc: '完成5個任務',                       check: s => s.quests?.completed?.length >= 5     },
  { id: 'max_rep_jianghu', title: '江湖公敵', desc: '江湖聲望達到100',                   check: s => s.player.reputation.jianghu >= 100   },

  // ── 故事類成就（6 個）────────────────────
  { id: 'seal_ending',    title: '劍封玄冥',   desc: '達成劍封結局',                      check: s => s.ending_id === 'seal_jianghu'       },
  { id: 'research_ending', title: '檔案終結',  desc: '達成檔案終結結局',                  check: s => s.ending_id === 'research_containment' },
  { id: 'anomaly_ending', title: '虛空同行',   desc: '達成虛空同行結局',                  check: s => s.ending_id === 'coexist_anomaly'    },
  { id: 'all_endings_5',  title: '宿命交匯',   desc: '觸發5種不同的結局',                 check: s => s._endings_discovered?.length >= 5   },
  { id: 'true_ending',    title: '終極真相',   desc: '同時達成高知識度和多身份認同',     check: s => s.world.known_facts.length >= 12 && s.player.reputation.containment >= 70 && s.player.reputation.anomaly >= 70 },
  { id: 'all_quests_done', title: '無遺恨', desc: '完成全部8個任務',                    check: s => s.quests?.completed?.length >= 8     },

  // ── 隱藏成就（5 個）───────────────────────
  { id: 'unnamed_secret', title: '???',       desc: '達成隱藏條件',                      check: s => s.npcs.unnamed_survivor?.trust >= 80 && s.player.reputation.anomaly >= 50 },
  { id: 'child_secret',   title: '???',       desc: '達成隱藏條件',                      check: s => s.npcs.amnesiac_child?.trust >= 80   },
  { id: 'perfect_play',   title: '???',       desc: '達成隱藏條件',                      check: s => s.player.sanity >= 90 && s.world.town_stability >= 90 && s.world.anomaly_spread <= 20 },
  { id: 'speedrun',       title: '???',       desc: '達成隱藏條件',                      check: s => s.world.day <= 10 && s.quests?.completed?.length >= 5 },
  { id: 'void_touched',   title: '???',       desc: '達成隱藏條件',                      check: s => s.player.inventory.some(i => i.includes('虛空')) && s.player.reputation.anomaly >= 60 },
];

function checkAchievements(state) {
  if (!state.achievements) state.achievements = [];
  const newAch = [];
  for (const ach of ACHIEVEMENTS) {
    if (!state.achievements.includes(ach.id) && ach.check(state)) {
      state.achievements.push(ach.id);
      newAch.push(ach);
    }
  }
  return newAch;
}

// ══════════════════════════════════════════════════════════════
// 舊版JSON狀態更新（保留相容）
// ══════════════════════════════════════════════════════════════
function applyStateUpdate(state, updateStr) {
  try {
    const u = JSON.parse(updateStr);
    const p = state.player; const w = state.world;
    if (u.sanity_delta)     p.sanity = Math.max(0, Math.min(p.maxSanity, p.sanity + u.sanity_delta));
    if (u.anomaly_delta)    w.anomaly_spread = Math.min(100, Math.max(0, w.anomaly_spread + u.anomaly_delta));
    if (u.stability_delta)  w.town_stability = Math.min(100, Math.max(0, w.town_stability + u.stability_delta));
    if (u.identity && u.identity !== '' && u.identity !== 'none') p.identity = u.identity;
    if (u.rep_jianghu)     p.reputation.jianghu    += u.rep_jianghu;
    if (u.rep_containment) p.reputation.containment += u.rep_containment;
    if (u.rep_anomaly)     p.reputation.anomaly     += u.rep_anomaly;
    if (u.new_fact  && !w.known_facts.includes(u.new_fact))  w.known_facts.push(u.new_fact);
    if (u.new_event) w.events.push(u.new_event);
    if (u.new_skill && !p.skills.includes(u.new_skill))  p.skills.push(u.new_skill);
    if (u.new_item)  p.inventory.push(u.new_item);
    if (u.resource_stone) w.resources.stone += u.resource_stone;
    if (u.resource_wood)  w.resources.wood  += u.resource_wood;
    if (u.resource_iron)  w.resources.iron  += u.resource_iron;
    if (u.resource_void)  w.resources.void_shard += u.resource_void;
    if (u.move_to && LOCATIONS[u.move_to]) {
      w.location = u.move_to;
      LOCATIONS[u.move_to].unlocked = true;
      p.sanity = Math.max(0, p.sanity - LOCATIONS[u.move_to].anomaly_level * 2);
    }
    if (u.build && BUILDING_DEFS[u.build]) {
      const def = BUILDING_DEFS[u.build];
      if (!state.buildings.find(b => b.id === u.build)) {
        state.buildings.push({ id: def.id, name: def.name, built_day: w.day });
        if (def.effect.anomaly_control) w.anomaly_spread = Math.max(0, w.anomaly_spread - def.effect.anomaly_control);
        if (def.effect.anomaly_spread_reduction) w.anomaly_spread = Math.max(0, w.anomaly_spread - def.effect.anomaly_spread_reduction);
      }
    }
    if (u.npc_trust) Object.entries(u.npc_trust).forEach(([id, d]) => {
      if (state.npcs[id]) state.npcs[id].trust = Math.max(-100, Math.min(100, state.npcs[id].trust + d));
    });
    if (u.npc_fear) Object.entries(u.npc_fear).forEach(([id, d]) => {
      if (state.npcs[id]) state.npcs[id].fear = Math.max(0, Math.min(100, state.npcs[id].fear + d));
    });
  } catch (e) {
    console.error('[STATE_UPDATE parse error]', e.message);
  }
}

// ══════════════════════════════════════════════════════════════
// 每回合自動觸發
// ══════════════════════════════════════════════════════════════
function tickWorld(state) {
  const w = state.world;

  if (state.turn % 6 === 0) {
    w.day++;
    const times = ['清晨', '上午', '正午', '下午', '傍晚', '入夜'];
    w.time = times[w.day % 6];

    state.buildings.forEach(b => {
      const def = BUILDING_DEFS[b.id];
      if (!def) return;
      if (def.effect.rep_jianghu_per_day)  state.player.reputation.jianghu  += def.effect.rep_jianghu_per_day;
      if (def.effect.rep_anomaly_per_day)  state.player.reputation.anomaly  += def.effect.rep_anomaly_per_day;
      if (def.effect.sanity_cost_per_day)  state.player.sanity = Math.max(0, state.player.sanity - def.effect.sanity_cost_per_day);
      if (def.effect.sanity_regen_per_day) state.player.sanity = Math.min(state.player.maxSanity, state.player.sanity + def.effect.sanity_regen_per_day);
      if (def.effect.intel_per_day && w.known_facts.length < 15) w.anomaly_spread = Math.max(0, w.anomaly_spread - 1);
      if (def.effect.anomaly_delay) w.anomaly_spread = Math.max(0, w.anomaly_spread - def.effect.anomaly_delay);
    });

    const hasSeal = state.buildings.find(b => b.id === 'seal_array');
    if (hasSeal) w.anomaly_spread = Math.max(0, w.anomaly_spread - 2);

    w.anomaly_spread = Math.min(100, w.anomaly_spread + 1);

    const prevPhase = w.phase;
    if (w.anomaly_spread >= 80 || w.day > 25)      w.phase = 'final';
    else if (w.anomaly_spread >= 55 || w.day > 15) w.phase = 'late';
    else if (w.anomaly_spread >= 25 || w.day > 6)  w.phase = 'mid';
    else                                            w.phase = 'early';
    if (w.phase !== prevPhase) w.events.push(`【階段推進】故事進入${{ mid: '中期', late: '後期', final: '終局', early: '序章' }[w.phase]}`);
  }

  // 異常事件觸發
  let triggeredEvent = null;
  for (const ev of ANOMALY_EVENTS) {
    if (w.anomaly_spread >= ev.trigger_spread && !w.triggered_events.includes(ev.id)) {
      w.triggered_events.push(ev.id);
      state.anomaly_log.push({ id: ev.id, title: ev.title, desc: ev.desc, day: w.day, sanity_delta: ev.sanity_delta, stability_delta: ev.stability_delta });
      w.events.push(`【異常事件】${ev.title}：${ev.desc}`);
      state.player.sanity = Math.max(0, state.player.sanity + ev.sanity_delta);
      w.town_stability    = Math.max(0, w.town_stability + ev.stability_delta);
      if (state.player.identity === 'anomaly') state.player.reputation.anomaly += 3;
      triggeredEvent = ev;
      break; // 每回合最多觸發一個事件
    }
  }

  // 隨機遭遇戰（危險地區 8% 機率）
  const loc = LOCATIONS[w.location];
  if (loc && loc.anomaly_level >= 2 && !state.combat_state && Math.random() < 0.08) {
    const pool = loc.enemy_pool || ['possessed_civilian'];
    startCombat(state, pool[Math.floor(Math.random() * pool.length)]);
  }

  // 每回合檢查解鎖（地點 + 任務）
  const newlyUnlocked = checkUnlocks(state);

  // ── 身份自動解鎖（聲望≥30 自動確立路線） ──────────────────
  const identityUnlockMsg = checkIdentityUnlock(state);
  if (identityUnlockMsg) newlyUnlocked.push(identityUnlockMsg);

  return { event: triggeredEvent, unlocked: newlyUnlocked };
}

// ══════════════════════════════════════════════════════════════
// 身份自動解鎖（聲望≥30 且尚未確立身份）
// ══════════════════════════════════════════════════════════════
function checkIdentityUnlock(state) {
  const p = state.player;
  const rep = p.reputation;
  if (p.identity && p.identity !== 'none') return null; // 已確立身份

  const THRESHOLD = 30;
  const candidates = [];
  if (rep.jianghu     >= THRESHOLD) candidates.push({ id: 'jianghu',     label: '江湖俠客',    score: rep.jianghu     });
  if (rep.containment >= THRESHOLD) candidates.push({ id: 'containment', label: '收容者',      score: rep.containment });
  if (rep.anomaly     >= THRESHOLD) candidates.push({ id: 'anomaly',     label: '異常接觸者',  score: rep.anomaly     });

  if (candidates.length === 0) return null;

  // 取聲望最高者
  candidates.sort((a, b) => b.score - a.score);
  const chosen = candidates[0];
  p.identity = chosen.id;
  state.world.events.push(`【身份確立】${p.name}的路線確立：${chosen.label}（${chosen.id}聲望${chosen.score}）`);
  return { type: 'identity', id: chosen.id, label: chosen.label, message: `【身份確立】你的江湖路線已確立：${chosen.label}` };
}

// ══════════════════════════════════════════════════════════════
// 結局檢查
// ══════════════════════════════════════════════════════════════
function checkEndings(state) {
  for (const ending of ENDINGS) {
    if (ending.condition(state)) return ending;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 公開狀態
// ══════════════════════════════════════════════════════════════
function getPublicState(state) {
  return {
    player: {
      name: state.player.name,
      character: state.player.character,
      identity: state.player.identity,
      sanity: state.player.sanity,
      maxSanity: state.player.maxSanity,
      reputation: state.player.reputation,
      skills: state.player.skills,
      inventory: state.player.inventory,
      combat: state.player.combat
    },
    world: {
      location: state.world.location,
      day: state.world.day,
      time: state.world.time,
      anomaly_spread: state.world.anomaly_spread,
      town_stability: state.world.town_stability,
      resources: state.world.resources,
      phase: state.world.phase,
      known_facts_count: state.world.known_facts.length,
      known_facts: state.world.known_facts,  // 完整線索列表，供前端線索日誌顯示
    },
    map: Object.fromEntries(
      Object.entries(LOCATIONS).map(([k, v]) => [k, {
        label: v.label, desc: v.desc, unlocked: v.unlocked,
        connections: v.connections, anomaly_level: v.anomaly_level,
        // 未解鎖時顯示解鎖提示（幫助玩家知道如何達成條件）
        unlock_hint: !v.unlocked ? (LOCATION_UNLOCK_CONDITIONS[k]?.hint || '繼續探索即可解鎖') : null,
      }])
    ),
    buildings: state.buildings,
    building_defs: BUILDING_DEFS,
    anomaly_log: state.anomaly_log,
    ended: state.ended,
    ending: state.ending_id ? ENDINGS.find(e => e.id === state.ending_id) : null,
    npcs: Object.fromEntries(
      Object.entries(state.npcs).map(([id, n]) => [id, {
        name: n.name, trust: n.trust, fear: n.fear,
        location: n.location, description: n.description, alive: n.alive
      }])
    ),
    quests: {
      available: (state.quests?.available || []).map(id => ({ ...QUEST_DEFS[id], status: 'available' })).filter(Boolean),
      active:    (state.quests?.active    || []).map(id => ({ ...QUEST_DEFS[id], status: 'active'    })).filter(Boolean),
      completed: (state.quests?.completed || []).map(id => ({ ...QUEST_DEFS[id], status: 'completed' })).filter(Boolean),
    },
    combat_state: state.combat_state ? {
      active: true,
      enemy: { name: state.combat_state.enemy.name, hp: state.combat_state.enemy.hp, maxHp: state.combat_state.enemy.maxHp },
      turn: state.combat_state.turn
    } : null,
    achievements: (state.achievements || []).map(id => ACHIEVEMENTS.find(a => a.id === id)).filter(Boolean),
  };
}

// ══════════════════════════════════════════════════════════════
// API 路由
// ══════════════════════════════════════════════════════════════
app.post('/api/action', async (req, res) => {
  const { action } = req.body;
  if (!action?.trim()) return res.status(400).json({ error: '行動不能為空' });

  const state = loadState();
  if (state.ended) return res.json({ message: '遊戲已結束。請開始新遊戲或讀取存檔。', state: getPublicState(state) });

  state.conversation_history.push({ role: 'user', content: action });

  const ending = checkEndings(state);
  if (ending) {
    state.ended = true;
    state.ending_id = ending.id;
    saveState(state);
    return res.json({
      message: `═══ 結局：${ending.title} ═══\n\n${ending.desc}\n\n你的選擇造就了這個結果。`,
      state: getPublicState(state), ending: true
    });
  }

  try {
    const raw = await callAI(buildSystemPrompt(state), state.conversation_history.slice(-24), state);
    state.conversation_history.push({ role: 'assistant', content: raw });

    // 解析《狀態》區塊 — 支援 AI 格式與本地引擎格式
    const match = raw.match(/《狀態》([\s\S]*?)《結束》/);
    let clean;
    if (match) {
      // AI 回應：用原有解析器，再用 parseAndApplyStateBlock 補充線索追蹤
      applyStateUpdateChinese(state, match[1].trim());
      clean = cleanNarrative(raw);
      // 補充線索追蹤（applyStateUpdateChinese 不處理）
      parseAndApplyStateBlock(raw, state);
    } else {
      // 本地引擎回應：直接使用 parseAndApplyStateBlock
      clean = parseAndApplyStateBlock(raw, state);
    }

    state.turn++;
    const { event: triggeredEvent, unlocked: newlyUnlocked } = tickWorld(state);
    const newAchievements = checkAchievements(state);

    saveState(state);
    res.json({
      message: clean,
      state: getPublicState(state),
      triggered_event: triggeredEvent,
      new_achievements: newAchievements,
      newly_unlocked: newlyUnlocked,
      combat_triggered: state.combat_state ? { enemy: state.combat_state.enemy.name } : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '敘事引擎異常：' + err.message });
  }
});

// ── 戰鬥 API ──
app.post('/api/combat/start', (req, res) => {
  const { enemy_id } = req.body;
  const state = loadState();
  if (state.combat_state?.active) return res.status(400).json({ error: '已有進行中的戰鬥' });
  const cs = startCombat(state, enemy_id || 'possessed_civilian');
  if (!cs) return res.status(400).json({ error: '未知敵人' });
  saveState(state);
  const publicState = getPublicState(state);
  res.json({
    success: true,
    combat: publicState.combat_state,
    enemy: cs.enemy,
    state: publicState
  });
});

app.post('/api/combat/action', (req, res) => {
  const { action } = req.body;
  const state = loadState();
  if (!state.combat_state?.active) return res.status(400).json({ error: '當前沒有進行中的戰鬥' });
  const result = processCombatAction(state, action);
  saveState(state);
  res.json({ ...result, state: getPublicState(state) });
});

app.get('/api/combat/state', (req, res) => {
  const state = loadState();
  res.json({ combat: state.combat_state, state: getPublicState(state) });
});

// ── 任務 API ──
app.get('/api/quests', (req, res) => {
  const state = loadState();
  res.json(getPublicState(state).quests);
});

app.post('/api/quests/accept', (req, res) => {
  const { quest_id } = req.body;
  const state = loadState();
  if (!QUEST_DEFS[quest_id]) return res.status(400).json({ error: '未知任務' });
  if (!state.quests.available.includes(quest_id)) return res.status(400).json({ error: '任務不可用' });

  state.quests.available = state.quests.available.filter(id => id !== quest_id);
  state.quests.active.push(quest_id);
  saveState(state);
  res.json({ success: true, quest: QUEST_DEFS[quest_id], state: getPublicState(state) });
});

app.post('/api/quests/complete', (req, res) => {
  const { quest_id } = req.body;
  const state = loadState();
  if (!state.quests.active.includes(quest_id)) return res.status(400).json({ error: '任務未接取或已完成' });
  completeQuest(state, quest_id);
  saveState(state);
  res.json({ success: true, quest: QUEST_DEFS[quest_id], state: getPublicState(state) });
});

// ── NPC 互動 API ──
app.post('/api/npc/talk', async (req, res) => {
  const { npc_id, message } = req.body;
  const state = loadState();
  const npc = state.npcs[npc_id];
  if (!npc) return res.status(400).json({ error: '找不到該角色' });

  // 記錄當前 NPC（供 narrative-engine 的 信任變化 解析使用）
  state._current_npc = npc_id;

  const npcSystemPrompt = `你是武俠恐怖小說中的角色「${npc.name}」。當前信任度：${npc.trust}，恐懼度：${npc.fear}。
地點：${npc.location}。角色描述：${npc.description}
你的性格：${npc.personality || '神秘謹慎'}
玩家發言：${message || '你好，我有些事情想請教你。'}

【回應格式要求】
以角色口吻用純繁體中文說一段話（60至120字，武俠語氣，符合信任/恐懼程度）。
可透露一條關於玄冥關或異常現象的線索。
最後加上《狀態》區塊，例如：

《狀態》
信任變化:5
線索:某個重要線索名稱
《結束》`;

  state.conversation_history.push({ role: 'user', content: `【接觸NPC ${npc.name}】${message || '你好'}` });
  try {
    // fallbackFn：API 失敗時使用 NPC 專屬對話庫（而非通用地點敘事）
    const npcFallback = () => generateNpcDialogue(npc_id, npc, message || '', state);
    const raw = await callAI(npcSystemPrompt, [{ role: 'user', content: message || `你好，${npc.name}，我有些問題想請教你。` }], state, npcFallback);
    // 應用狀態變更（包括信任度提升、線索等）
    const clean = parseAndApplyStateBlock(raw, state);
    // 同步 NPC 信任度到狀態（narrative-engine 已處理）
    delete state._current_npc;
    state.conversation_history.push({ role: 'assistant', content: raw });
    const newlyUnlocked = checkUnlocks(state);
    saveState(state);
    res.json({
      message: clean,
      npc: { name: npc.name, trust: npc.trust, fear: npc.fear },
      state: getPublicState(state),
      newly_unlocked: newlyUnlocked,
    });
  } catch (err) {
    delete state._current_npc;
    res.status(500).json({ error: err.message });
  }
});

// ── 成就 API ──
app.get('/api/achievements', (req, res) => {
  const state = loadState();
  res.json({
    all: ACHIEVEMENTS,
    unlocked: (state.achievements || []).map(id => ACHIEVEMENTS.find(a => a.id === id)).filter(Boolean)
  });
});

// ── 背景故事 API （供 Godot 前端使用） ──
app.get('/api/lore', (req, res) => {
  res.json({
    world: {
      title: '玄冥江湖 · 異常年代',
      description: '三個月前，玄冥關守軍三千人全數覆沒，無一生還。如今異常現象開始侵蝕人間。',
      factions: {
        jianghu: {
          name: '江湖',
          desc: '流浪、自由、行俠仗義。江湖人士用武學與道德規範應對異常，卻往往被異常現象所迷惑。',
          identity_name: '江湖俠客'
        },
        containment: {
          name: '收容',
          desc: '調查、記錄、收容。神祕組織於暗處運作，試圖蒐集異常知識並加以控制。',
          identity_name: '收容者'
        },
        anomaly: {
          name: '異常',
          desc: '融合、進化、超越。與異常共鳴者逐漸領悟超越人類的感知與力量。',
          identity_name: '異常接觸者'
        }
      }
    },
    locations: Object.fromEntries(
      Object.entries(LOCATIONS).map(([k, v]) => [k, {
        name: v.label,
        description: v.desc,
        anomaly_level: v.anomaly_level,
        connections: v.connections
      }])
    ),
    enemies: Object.fromEntries(
      Object.entries(ENEMIES).map(([k, v]) => [k, {
        name: v.name,
        hp: v.maxHp,
        attack: v.attack,
        defense: v.defense,
        sanity_drain: v.sanity_drain,
        xp_reward: v.xp
      }])
    ),
    quests: Object.fromEntries(
      Object.entries(QUEST_DEFS).map(([k, v]) => [k, {
        title: v.title,
        description: v.desc,
        location: v.location_req
      }])
    ),
    anomaly_events: ANOMALY_EVENTS.map(e => ({
      id: e.id,
      title: e.title,
      description: e.desc,
      trigger_spread: e.trigger_spread
    })),
    endings: ENDINGS.map(e => ({
      id: e.id,
      title: e.title,
      description: e.desc
    }))
  });
});

// ── 基礎 API ──
app.post('/api/new-game', (req, res) => {
  const state = getDefaultState();
  state.started = true;
  // 重置所有 LOCATIONS 解鎖狀態，僅保持青石鎮解鎖
  Object.entries(LOCATIONS).forEach(([k, v]) => {
    v.unlocked = (k === '青石鎮');
  });
  saveState(state);
  res.json({ success: true });
});

app.get('/api/state', (req, res) => {
  res.json(getPublicState(loadState()));
});

app.post('/api/build', (req, res) => {
  const { building_id } = req.body;
  const state = loadState();
  const def = BUILDING_DEFS[building_id];
  if (!def) return res.status(400).json({ error: '未知建築' });
  if (state.buildings.find(b => b.id === building_id)) return res.status(400).json({ error: '已建造' });
  // 身份限制檢查（none = 任何人都可建）
  if (def.identity !== 'none' && state.player.identity !== def.identity) {
    const labelMap = { jianghu: '江湖身份', containment: '收容者身份', anomaly: '異常者身份' };
    return res.status(403).json({ error: `此建築需要 ${labelMap[def.identity] || def.identity}，你目前的身份不符合` });
  }

  const r = state.world.resources;
  for (const [resKey, amt] of Object.entries(def.cost)) {
    if (resKey === 'sanity_cost') continue;
    if ((r[resKey] || 0) < amt) return res.status(400).json({ error: `資源不足：需要 ${resKey} x${amt}` });
  }
  for (const [resKey, amt] of Object.entries(def.cost)) {
    if (resKey === 'sanity_cost') { state.player.sanity = Math.max(0, state.player.sanity - amt); continue; }
    r[resKey] -= amt;
  }

  state.buildings.push({ id: def.id, name: def.name, built_day: state.world.day });
  if (def.effect.anomaly_control)         state.world.anomaly_spread = Math.max(0, state.world.anomaly_spread - def.effect.anomaly_control);
  if (def.effect.anomaly_spread_reduction) state.world.anomaly_spread = Math.max(0, state.world.anomaly_spread - def.effect.anomaly_spread_reduction);

  const newAch = checkAchievements(state);
  saveState(state);
  res.json({ success: true, building: def, state: getPublicState(state), new_achievements: newAch });
});

app.post('/api/move', (req, res) => {
  const { location } = req.body;
  const state = loadState();
  const current = LOCATIONS[state.world.location];
  if (!current?.connections.includes(location)) return res.status(400).json({ error: '無法前往該地點' });

  const target = LOCATIONS[location];
  state.world.location = location;
  target.unlocked = true;

  const sanityLoss = target.anomaly_level * 2;
  state.player.sanity = Math.max(0, state.player.sanity - sanityLoss);
  state.world.events.push(`前往 ${location}`);

  // 抵達新地點後立即檢查解鎖（可能觸發周邊地點 / 任務）
  const newlyUnlocked = checkUnlocks(state);
  const newAch = checkAchievements(state);
  saveState(state);
  res.json({ success: true, location, sanity_lost: sanityLoss, state: getPublicState(state), new_achievements: newAch, newly_unlocked: newlyUnlocked });
});

app.post('/api/save', (req, res) => {
  const slot = parseInt(req.body.slot) || 1;
  if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: '存檔槽必須為 1、2 或 3' });
  const state = loadState();
  state.saveName = `${state.player.name} · 第${state.world.day}天`;
  state.saveTime = new Date().toLocaleString('zh-TW');
  writeFileSync(join(SAVES_DIR, `save_${slot}.json`), JSON.stringify(state, null, 2));
  res.json({ success: true });
});

app.post('/api/load', (req, res) => {
  const slot = parseInt(req.body.slot) || 1;
  if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: '存檔槽必須為 1、2 或 3' });
  const path = join(SAVES_DIR, `save_${slot}.json`);
  if (!existsSync(path)) return res.status(404).json({ error: '存檔不存在' });
  const state = JSON.parse(readFileSync(path, 'utf-8'));
  // Migrate old saves
  if (!state.quests) state.quests = { available: Object.keys(QUEST_DEFS), active: [], completed: [] };
  if (!state.achievements) state.achievements = [];
  if (!state.combat_state) state.combat_state = null;
  saveState(state);
  res.json({ success: true, state: getPublicState(state) });
});

app.get('/api/saves', (req, res) => {
  const saves = [1, 2, 3].map(slot => {
    const p = join(SAVES_DIR, `save_${slot}.json`);
    if (!existsSync(p)) return { slot, empty: true };
    const s = JSON.parse(readFileSync(p, 'utf-8'));
    return { slot, empty: false, name: s.saveName || '', time: s.saveTime || '', day: s.world?.day || 1 };
  });
  res.json(saves);
});

app.get('/api/status', (req, res) => {
  const state = loadState();
  res.json({
    ok: true, day: state.world.day, phase: state.world.phase,
    anomaly_spread: state.world.anomaly_spread,
    town_stability: state.world.town_stability,
    ended: state.ended, turn: state.turn,
    quests_completed: state.quests?.completed?.length || 0,
    achievements: state.achievements?.length || 0,
  });
});

const VALID_BACKGROUNDS    = ['江湖浪人', '朝廷欽差', '邪教叛徒', '隱士遺孤'];
const VALID_MARTIAL_STYLES = ['剛猛', '輕靈', '陰詭', '醫毒'];
const VALID_PERSONALITIES  = ['俠義', '自保', '求知', '復仇'];

// Combat style bonus mapping
const STYLE_BONUSES = {
  '剛猛': { power: 5, defense: 0 },
  '輕靈': { power: 2, defense: 3 },
  '陰詭': { power: 3, defense: 2, anomaly_resist: 5 },
  '醫毒': { power: 1, defense: 2 },
};

// ══════════════════════════════════════════════════════════════
// 認證 API 端點
// ══════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username?.trim() || !password?.trim() || !email?.trim()) {
    return res.status(400).json({ error: '用戶名、密碼和郵箱均為必填項' });
  }
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: '用戶名長度必須在 3-20 字元之間' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密碼長度至少 6 字元' });
  }

  // 查找用戶名是否已存在
  let existingUser = null;
  try {
    if (USE_KV) {
      // KV 模式：用 username 索引直接查
      const uid = await kvGet(`usernames:${username.toLowerCase()}`);
      if (uid) existingUser = await loadUser(uid);
    } else if (existsSync(USERS_DIR)) {
      const files = readdirSync(USERS_DIR);
      for (const f of files) {
        const u = await loadUser(f.replace('.json', ''));
        if (u && u.username?.toLowerCase() === username.toLowerCase()) { existingUser = u; break; }
      }
    }
  } catch (e) { console.error('[register] 查找用戶錯誤:', e.message); }

  if (existingUser) return res.status(409).json({ error: '用戶名已存在' });

  const userId = uuidv4();
  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: userId,
    username: username.trim(),
    passwordHash,
    email: email.trim(),
    createdAt: new Date().toISOString(),
    saves: [null, null, null]
  };
  await saveUser(user);
  // KV 模式：建立 username → userId 索引
  if (USE_KV) await kvSet(`usernames:${username.toLowerCase()}`, userId);
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  res.json({ success: true, token, user: { id: user.id, username: user.username, email: user.email } });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password?.trim()) {
    return res.status(400).json({ error: '用戶名和密碼為必填項' });
  }

  let user = null;
  try {
    if (USE_KV) {
      const uid = await kvGet(`usernames:${username.toLowerCase()}`);
      if (uid) user = await loadUser(uid);
    } else if (existsSync(USERS_DIR)) {
      const files = readdirSync(USERS_DIR);
      for (const f of files) {
        const candidate = await loadUser(f.replace('.json', ''));
        if (candidate && candidate.username?.toLowerCase() === username.toLowerCase()) { user = candidate; break; }
      }
    }
  } catch (e) { console.error('[login] 查找用戶錯誤:', e.message); }

  if (!user) return res.status(401).json({ error: '用戶不存在或密碼錯誤' });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: '用戶不存在或密碼錯誤' });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  res.json({ success: true, token, user: { id: user.id, username: user.username, email: user.email } });
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  const user = await loadUser(req.user.id);
  if (!user) return res.status(404).json({ error: '用戶不存在' });
  res.json({ user: { id: user.id, username: user.username, email: user.email, createdAt: user.createdAt } });
});

app.post('/api/auth/save-cloud/:slot', authenticateToken, async (req, res) => {
  const slot = parseInt(req.params.slot);
  if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: '存檔槽必須為 1、2 或 3' });
  const state = loadState();
  const user = await loadUser(req.user.id);
  if (!user) return res.status(404).json({ error: '用戶不存在' });

  state.saveName = `${state.player.name} · 第${state.world.day}天`;
  state.saveTime = new Date().toLocaleString('zh-TW');
  user.saves[slot - 1] = { data: state, name: state.saveName, time: state.saveTime, day: state.world.day };
  await saveUser(user);
  res.json({ success: true });
});

app.post('/api/auth/load-cloud/:slot', authenticateToken, async (req, res) => {
  const slot = parseInt(req.params.slot);
  if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: '存檔槽必須為 1、2 或 3' });
  const user = await loadUser(req.user.id);
  if (!user) return res.status(404).json({ error: '用戶不存在' });

  const save = user.saves[slot - 1];
  if (!save) return res.status(404).json({ error: '存檔不存在' });

  const state = save.data;
  if (!state.quests) state.quests = { available: Object.keys(QUEST_DEFS), active: [], completed: [] };
  if (!state.achievements) state.achievements = [];
  if (!state.combat_state) state.combat_state = null;
  saveState(state);
  res.json({ success: true, state: getPublicState(state) });
});

app.post('/api/leaderboard/submit', async (req, res) => {
  const { ending_id, days_survived, achievements_count, quests_completed, anomaly_spread } = req.body;
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  let username = '(訪客)';
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await loadUser(decoded.id);
      if (user) username = user.username;
    } catch {}
  }

  const score = (achievements_count * 100) + (quests_completed * 50) + (days_survived * 10) - (anomaly_spread * 2);
  const lb = await loadLeaderboard();
  const timestamp = new Date().toISOString();
  lb.entries.push({ username, score, ending_id, days: days_survived, achievements: achievements_count, timestamp });
  lb.entries.sort((a, b) => b.score - a.score);
  lb.entries = lb.entries.slice(0, 100);
  await saveLeaderboard(lb);

  const rank = lb.entries.findIndex(e => e.timestamp === timestamp) + 1;
  res.json({ success: true, score, rank });
});

app.get('/api/leaderboard', async (req, res) => {
  const lb = await loadLeaderboard();
  const topEntries = (lb.entries || []).slice(0, 20).map((e, i) => ({ rank: i + 1, ...e }));
  res.json({ leaderboard: topEntries, total: (lb.entries || []).length });
});

app.get('/api/character', (req, res) => {
  const state = loadState();
  if (!state.player.character) return res.json({ player: null });
  res.json({ player: { name: state.player.name, ...state.player.character } });
});

app.post('/api/character/create', (req, res) => {
  const { name, background, martial_style, personality } = req.body;
  if (!name?.trim())                                return res.status(400).json({ error: '姓名不能為空' });
  if (!VALID_BACKGROUNDS.includes(background))      return res.status(400).json({ error: '無效出身背景' });
  if (!VALID_MARTIAL_STYLES.includes(martial_style))return res.status(400).json({ error: '無效武學流派' });
  if (!VALID_PERSONALITIES.includes(personality))   return res.status(400).json({ error: '無效性格根骨' });

  const state = loadState();
  state.player.name = name.trim();
  state.player.character = { background, martial_style, personality };

  // Apply martial style bonuses
  const bonus = STYLE_BONUSES[martial_style] || {};
  state.player.combat.power         += bonus.power         || 0;
  state.player.combat.defense       += bonus.defense       || 0;
  state.player.combat.anomaly_resist += bonus.anomaly_resist || 0;

  // Background starting resource & reputation bonuses
  if (background === '江湖浪人') {
    state.world.resources.wood         += 10;
    state.player.reputation.jianghu    += 5;
  }
  if (background === '朝廷欽差') {
    state.world.resources.iron         += 10;
    state.player.reputation.containment += 5;
  }
  if (background === '邪教叛徒') {
    state.world.resources.void_shard   += 3;
    state.player.reputation.anomaly    += 5;
  }
  if (background === '隱士遺孤') {
    state.player.maxSanity             += 10;
    state.player.sanity                += 10;
    state.player.reputation.jianghu    += 3;
    state.player.reputation.containment += 3;
    state.player.reputation.anomaly    += 3;
  }

  // Personality starting bonuses
  if (personality === '俠義')   state.player.reputation.jianghu     += 10;
  if (personality === '求知')   state.player.reputation.containment += 10;
  if (personality === '復仇') { state.player.reputation.jianghu     += 5; state.player.combat.power += 2; }
  if (personality === '自保')   state.player.sanity = Math.min(state.player.maxSanity, state.player.sanity + 10);
  saveState(state);
  res.json({ success: true, player: { name: state.player.name, ...state.player.character } });
});

// ── Alpha 測試：玩家回饋 ──────────────────────────────
app.post('/api/feedback', (req, res) => {
  const { type, message, state_snapshot, contact } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: '回饋內容不能為空' });

  const FEEDBACK_FILE = join(DATA_DIR, 'feedback.json');
  let feedbacks = [];
  if (existsSync(FEEDBACK_FILE)) {
    try { feedbacks = JSON.parse(readFileSync(FEEDBACK_FILE, 'utf-8')); } catch {}
  }

  const entry = {
    id: Date.now(),
    type: type || 'general', // bug | suggestion | general
    message: message.trim().slice(0, 1000),
    contact: contact?.slice(0, 100) || '',
    timestamp: new Date().toISOString(),
    game_day: state_snapshot?.world?.day || 0,
    location: state_snapshot?.world?.location || '',
    identity: state_snapshot?.player?.identity || 'none',
  };

  feedbacks.push(entry);
  // 最多保留 1000 筆
  if (feedbacks.length > 1000) feedbacks = feedbacks.slice(-1000);
  writeFileSync(FEEDBACK_FILE, JSON.stringify(feedbacks, null, 2));

  res.json({ success: true, id: entry.id });
});

// ── Alpha 測試：查看回饋（開發用）──────────────────────
app.get('/api/feedback', (req, res) => {
  const FEEDBACK_FILE = join(DATA_DIR, 'feedback.json');
  if (!existsSync(FEEDBACK_FILE)) return res.json([]);
  try {
    const feedbacks = JSON.parse(readFileSync(FEEDBACK_FILE, 'utf-8'));
    // 統計摘要
    const summary = {
      total: feedbacks.length,
      bugs: feedbacks.filter(f => f.type === 'bug').length,
      suggestions: feedbacks.filter(f => f.type === 'suggestion').length,
      recent: feedbacks.slice(-10).reverse(),
    };
    res.json(summary);
  } catch { res.json([]); }
});

// ── Alpha 測試：遊戲分析事件 ──────────────────────────
app.post('/api/analytics', (req, res) => {
  const { event, data } = req.body;
  if (!event) return res.status(400).json({ error: '事件名稱不能為空' });

  const ANALYTICS_FILE = join(DATA_DIR, 'analytics.json');
  let events = [];
  if (existsSync(ANALYTICS_FILE)) {
    try { events = JSON.parse(readFileSync(ANALYTICS_FILE, 'utf-8')); } catch {}
  }

  events.push({
    event,
    data: data || {},
    timestamp: new Date().toISOString(),
    session_id: req.headers['x-session-id'] || 'unknown'
  });

  // 最多保留 5000 筆
  if (events.length > 5000) events = events.slice(-5000);
  writeFileSync(ANALYTICS_FILE, JSON.stringify(events, null, 2));
  res.json({ success: true });
});

// ── Alpha 測試：分析摘要 ──────────────────────────────
app.get('/api/analytics/summary', (req, res) => {
  const ANALYTICS_FILE = join(DATA_DIR, 'analytics.json');
  if (!existsSync(ANALYTICS_FILE)) return res.json({ total: 0, events: {}, endings: {}, popular_locations: {} });
  try {
    const summary = cachedRead('analytics_summary', () => {
      const events = JSON.parse(readFileSync(ANALYTICS_FILE, 'utf-8'));
      const s = { total: events.length, events: {}, endings: {}, popular_locations: {} };
      events.forEach(e => {
        s.events[e.event] = (s.events[e.event] || 0) + 1;
        if (e.event === 'game_end' && e.data?.ending_id) s.endings[e.data.ending_id] = (s.endings[e.data.ending_id] || 0) + 1;
        if (e.event === 'move' && e.data?.location) s.popular_locations[e.data.location] = (s.popular_locations[e.data.location] || 0) + 1;
      });
      return s;
    });
    res.json(summary);
  } catch { res.json({ total: 0, events: {}, endings: {}, popular_locations: {} }); }
});

// ── 版本資訊 ─────────────────────────────────────────
app.get('/api/version', (req, res) => {
  res.json({
    version: '1.0.0-beta',
    build_date: '2026-04-09',
    api_count: 31,
    quest_count: Object.keys(QUEST_DEFS).length,
    location_count: Object.keys(LOCATIONS).length,
    npc_count: 9,
    anomaly_event_count: ANOMALY_EVENTS.length,
    ending_count: ENDINGS.length,
    features: ['account', 'i18n', 'leaderboard', 'combat', 'quests', 'achievements', 'analytics', 'feedback', 'compression'],
    platforms: ['web', 'godot', 'mobile'],
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  玄冥江湖 · 武俠克蘇魯SCP文字冒險RPG     ║`);
  console.log(`║  v2.0  http://localhost:${PORT}             ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
