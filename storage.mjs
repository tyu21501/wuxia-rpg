// ════════════════════════════════════════════════════════════════
// storage.mjs — 儲存抽象層
// ════════════════════════════════════════════════════════════════
// 本地開發：使用 JSON 檔案存儲 (fs)
// Vercel 生產：使用環境變數 KV_REST_API_URL 指向 Upstash Redis
// ════════════════════════════════════════════════════════════════

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

// 判斷是否使用 KV（Vercel 生產環境）
// 需要同時設定 KV_REST_API_URL 和 KV_REST_API_TOKEN
export const USE_KV = !!(
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
);

// ══════════════════════════════════════════════════════════════
// Upstash Redis KV REST API 實作
// ══════════════════════════════════════════════════════════════

async function kvGet(key) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    throw new Error('[Storage] KV 未正確配置：缺少 KV_REST_API_URL 或 KV_REST_API_TOKEN');
  }

  try {
    const url = `${process.env.KV_REST_API_URL}/get/${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      console.error(`[Storage] KV GET 失敗 (${res.status}):`, await res.text());
      return null;
    }

    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch (e) {
    console.error('[Storage] KV GET 例外:', e.message);
    throw e;
  }
}

async function kvSet(key, value, exSeconds = null) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    throw new Error('[Storage] KV 未正確配置：缺少 KV_REST_API_URL 或 KV_REST_API_TOKEN');
  }

  try {
    const params = exSeconds ? `?EX=${exSeconds}` : '';
    const url = `${process.env.KV_REST_API_URL}/set/${encodeURIComponent(key)}${params}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(JSON.stringify(value))
    });

    if (!res.ok) {
      console.error(`[Storage] KV SET 失敗 (${res.status}):`, await res.text());
      throw new Error(`KV SET 失敗: ${res.statusText}`);
    }
  } catch (e) {
    console.error('[Storage] KV SET 例外:', e.message);
    throw e;
  }
}

async function kvDel(key) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    throw new Error('[Storage] KV 未正確配置：缺少 KV_REST_API_URL 或 KV_REST_API_TOKEN');
  }

  try {
    const url = `${process.env.KV_REST_API_URL}/del/${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      console.error(`[Storage] KV DEL 失敗 (${res.status}):`, await res.text());
    }
  } catch (e) {
    console.error('[Storage] KV DEL 例外:', e.message);
    throw e;
  }
}

async function kvKeys(pattern) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    throw new Error('[Storage] KV 未正確配置：缺少 KV_REST_API_URL 或 KV_REST_API_TOKEN');
  }

  try {
    // Upstash SCAN 指令查詢 pattern
    const url = `${process.env.KV_REST_API_URL}/keys/${encodeURIComponent(pattern)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      console.error(`[Storage] KV KEYS 失敗 (${res.status}):`, await res.text());
      return [];
    }

    const data = await res.json();
    return Array.isArray(data.result) ? data.result : [];
  } catch (e) {
    console.error('[Storage] KV KEYS 例外:', e.message);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════
// 本地 JSON 檔案實作
// ══════════════════════════════════════════════════════════════

function localGet(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.error(`[Storage] 本地讀取失敗 (${filePath}):`, e.message);
    return null;
  }
}

function localSet(filePath, value) {
  try {
    const dirPath = dirname(filePath);
    mkdirSync(dirPath, { recursive: true });

    // 先寫臨時檔案，再原子性替換（防止部分寫入導致損壞）
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
    renameSync(tmp, filePath);
  } catch (e) {
    console.error(`[Storage] 本地寫入失敗 (${filePath}):`, e.message);
    throw e;
  }
}

function localExists(filePath) {
  return existsSync(filePath);
}

function localDel(filePath) {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (e) {
    console.error(`[Storage] 本地刪除失敗 (${filePath}):`, e.message);
    throw e;
  }
}

function localKeys(pattern) {
  try {
    // 支援簡單的路徑模式，如 'users:*' → '/data/users/*.json'
    const parts = pattern.split(':');
    const dirPath = join(DATA_DIR, ...parts.slice(0, -1));

    if (!existsSync(dirPath)) return [];

    const files = readdirSync(dirPath).filter(f => f.endsWith('.json'));
    const prefix = parts.slice(0, -1).join(':');
    return files.map(f => (prefix ? prefix + ':' : '') + f.replace('.json', ''));
  } catch (e) {
    console.error(`[Storage] 本地列舉失敗 (pattern=${pattern}):`, e.message);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════
// 公開 API —— 選擇性使用 KV 或本地檔案
// ══════════════════════════════════════════════════════════════

/**
 * 讀取資料
 * @param {string} key - 儲存鍵 (e.g., 'world-state', 'users:uuid', 'saves:slot1')
 * @returns {Promise<any>} 資料物件或 null
 */
export async function storageGet(key) {
  if (USE_KV) {
    return kvGet(key);
  }

  const filePath = join(DATA_DIR, key.replace(/:/g, '/') + '.json');
  return localGet(filePath);
}

/**
 * 寫入資料
 * @param {string} key - 儲存鍵
 * @param {any} value - 要存儲的資料
 * @returns {Promise<void>}
 */
export async function storageSet(key, value) {
  if (USE_KV) {
    return kvSet(key, value);
  }

  const filePath = join(DATA_DIR, key.replace(/:/g, '/') + '.json');
  return localSet(filePath, value);
}

/**
 * 檢查資料是否存在
 * @param {string} key - 儲存鍵
 * @returns {Promise<boolean>}
 */
export async function storageExists(key) {
  if (USE_KV) {
    const val = await kvGet(key);
    return val !== null;
  }

  const filePath = join(DATA_DIR, key.replace(/:/g, '/') + '.json');
  return localExists(filePath);
}

/**
 * 刪除資料
 * @param {string} key - 儲存鍵
 * @returns {Promise<void>}
 */
export async function storageDel(key) {
  if (USE_KV) {
    return kvDel(key);
  }

  const filePath = join(DATA_DIR, key.replace(/:/g, '/') + '.json');
  return localDel(filePath);
}

/**
 * 列舉符合模式的所有鍵
 * @param {string} pattern - 模式 (e.g., 'users:*', 'saves:*')
 * @returns {Promise<string[]>} 鍵列表
 */
export async function storageKeys(pattern) {
  if (USE_KV) {
    return kvKeys(pattern);
  }

  return localKeys(pattern);
}

/**
 * 初始化儲存系統（確保必要的目錄存在）
 * @returns {void}
 */
export function initializeStorage() {
  if (USE_KV) {
    console.log('[Storage] 模式：Upstash Redis KV');
    console.log('[Storage] API 端點:', process.env.KV_REST_API_URL);
  } else {
    console.log('[Storage] 模式：本地 JSON 檔案');
    console.log('[Storage] 資料目錄:', DATA_DIR);
    mkdirSync(DATA_DIR, { recursive: true });
    mkdirSync(join(DATA_DIR, 'saves'), { recursive: true });
    mkdirSync(join(DATA_DIR, 'users'), { recursive: true });
  }
}

/**
 * 取得儲存系統狀態資訊
 * @returns {Object}
 */
export function getStorageStatus() {
  return {
    mode: USE_KV ? 'kv' : 'local',
    kv_url: process.env.KV_REST_API_URL || null,
    data_dir: USE_KV ? null : DATA_DIR
  };
}
