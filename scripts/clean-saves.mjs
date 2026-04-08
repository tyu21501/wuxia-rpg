/**
 * 清理存檔工具
 * 執行：npm run clean
 */
import { existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = join(__dirname, '..');

const args = process.argv.slice(2);
const target = args[0]; // 'all' | '1' | '2' | '3'

if (!target) {
  console.log('用法：node scripts/clean-saves.mjs [all|1|2|3]');
  process.exit(0);
}

const slots = target === 'all' ? [1, 2, 3] : [parseInt(target)].filter(n => n >= 1 && n <= 3);

slots.forEach(slot => {
  const p = join(BASE, 'data/saves', `save_${slot}.json`);
  if (existsSync(p)) {
    unlinkSync(p);
    console.log(`已刪除存檔槽位 ${slot}`);
  } else {
    console.log(`存檔槽位 ${slot} 本來就是空的`);
  }
});

// Also clean world-state if 'all'
if (target === 'all') {
  const ws = join(BASE, 'data/world-state.json');
  if (existsSync(ws)) {
    unlinkSync(ws);
    console.log('已清除當前遊戲狀態');
  }
}
