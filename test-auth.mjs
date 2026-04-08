import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3000';
let token = '';

async function test(method, path, body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (token) options.headers['Authorization'] = `Bearer ${token}`;
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}${path}`, options);
  const data = await res.json();
  console.log(`${method} ${path}:`, res.status, JSON.stringify(data, null, 2));
  return data;
}

(async () => {
  console.log('=== 認證系統測試 ===\n');

  // 測試註冊
  console.log('1. 註冊新用戶...');
  const reg = await test('POST', '/api/auth/register', {
    username: 'testplayer',
    password: 'password123',
    email: 'test@example.com'
  });
  if (reg.token) token = reg.token;
  console.log('');

  // 測試登錄
  console.log('2. 登錄用戶...');
  const login = await test('POST', '/api/auth/login', {
    username: 'testplayer',
    password: 'password123'
  });
  if (login.token) token = login.token;
  console.log('');

  // 獲取用戶信息
  console.log('3. 獲取認證用戶信息...');
  await test('GET', '/api/auth/me');
  console.log('');

  // 測試排行榜提交
  console.log('4. 提交遊戲分數到排行榜...');
  await test('POST', '/api/leaderboard/submit', {
    ending_id: 'hero_ending',
    days_survived: 15,
    achievements_count: 5,
    quests_completed: 4,
    anomaly_spread: 45
  });
  console.log('');

  // 查看排行榜
  console.log('5. 查看排行榜前 20 名...');
  await test('GET', '/api/leaderboard');
  console.log('');

  // 測試雲端存檔
  console.log('6. 測試雲端存檔 (save 1 slot)...');
  await test('POST', '/api/auth/save-cloud/1');
  console.log('');

  console.log('=== 所有測試完成 ===');
})();
