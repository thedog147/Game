/* ============================================================
 * HexCiv AI 對手（精簡版 v1）
 * ------------------------------------------------------------
 * 這個檔案由房主的瀏覽器在「勾選 AI 對手並按開始」時才載入，
 * 主遊戲檔案本身不含任何 AI 程式碼。
 *
 * 運作方式：
 *   · AI 是房間裡的「一名正常玩家」（自己的 WebSocket 連線、自己的 PID、自己的陣營），
 *     所以伺服器的回合、結束回合、斷線機制完全不用改。
 *   · AI 只用「封包」得知戰場：看得到的敵人 = 己方單位視野範圍內的敵人。
 *   · 規則（移動範圍、傷害公式、地形）透過主遊戲提供的 window.HexAIBridge 讀取，
 *     不在這裡重寫一份，主遊戲規則調整時 AI 自動跟著變。
 *   · 房主斷線時，AI 暫停（不動作、不結束回合），回合由伺服器計時器接手。
 *
 * 簡化版已知限制（刻意先不做）：
 *   · 不處理補給/油料/糧食：AI 彈藥每回合自動回 1 點（上限為兵種上限）
 *   · 不踩地雷（等於免疫地雷）、不用政戰/通信/空投等特殊技能
 *   · 編制固定：戰車2、步兵3、偵察車1、砲兵1
 * ============================================================ */
(function(){
'use strict';
if(window.HexAI && window.HexAI.version) return;   // 已載入就不重複

const AI_VERSION   = 1;
const NEED_API     = 1;                 // 需要主遊戲橋接 API 版本
const LOADOUT      = { TANK:2, INFANTRY:3, SCOUT:1, ARTILLERY:1 };
const ACT_DELAY    = 700;               // 每個單位動作間隔（毫秒），避免瞬間灌封包
const SEEN_MEMORY  = 3;                 // 看過的敵人位置記憶幾回合
const MAX_RECONN   = 5;

const S = {
  ws:null, pid:null, team:null, token:null,
  units:{},            // uid → {uid,typeID,team,q,r,hp,mine,ammo}
  nextN:1,
  started:false, deployed:false, deploying:false,
  activeTeam:null, turnCount:1,
  acting:false, turnToken:0,
  seen:{},             // 敵方 uid → {q,r,turn}
  stopped:false, reconn:0, joined:false,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = (...a) => { try{ console.log('[AI]', ...a); }catch(e){} };
function B(){ const b = window.HexAIBridge; if(!b || b.api !== NEED_API) throw new Error('主遊戲版本與 AI 不相容（需要 API '+NEED_API+'）'); return b; }

// ── 封包送出 ───────────────────────────────────────────────
function send(type, payload){
  const ws = S.ws;
  if(!ws || ws.readyState !== 1) return false;
  try{ ws.send(JSON.stringify({ type, roomID:B().roomID(), ts:Date.now(), payload:payload||{} })); return true; }
  catch(e){ return false; }
}

// ── 加入房間：連線 → JOIN → 選陣營/編制 → 準備就緒 ──────────
function join(opts){
  return new Promise((resolve, reject)=>{
    let b;
    try{ b = B(); }catch(e){ reject(e); return; }
    S.team  = opts.team;
    S.token = 'ai-' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
    S.stopped = false;
    let settled = false;
    const fail = m => { if(settled) return; settled = true; try{ S.ws && S.ws.close(); }catch(e){} reject(new Error(m)); };
    const ok   = () => { if(settled) return; settled = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(()=>fail('AI 加入房間逾時'), 12000);
    S._onJoined = ok; S._onFail = fail;
    openSocket(b);
  });
}

function openSocket(b){
  let ws;
  try{ ws = new WebSocket(b.wsUrl()); }catch(e){ if(S._onFail) S._onFail('AI 無法連線：'+e.message); return; }
  S.ws = ws;
  ws.onopen = () => send('JOIN', { team:S.team, name:'AI對手', role:'PLAYER', rejoinToken:S.token });
  ws.onmessage = evt => {
    let p; try{ p = JSON.parse(evt.data); }catch(e){ return; }
    try{ handle(p); }catch(err){ log('封包處理失敗', p && p.type, err); }
  };
  ws.onerror = () => { if(S._onFail) S._onFail('AI 連線錯誤'); };
  ws.onclose = () => {
    if(S.stopped || ws !== S.ws) return;
    if(!S.joined){ if(S._onFail) S._onFail('AI 連線被關閉'); return; }
    // 遊戲中斷線：自動重連（用 token 拿回原本身份）
    if(S.reconn < MAX_RECONN){
      S.reconn++;
      setTimeout(()=>{ if(!S.stopped){ try{ openSocket(B()); }catch(e){} } }, 2000 * S.reconn);
    } else { log('重連次數用完，AI 停止'); stop(); }
  };
}

function stop(){
  S.stopped = true; S.turnToken++;
  try{ S.ws && S.ws.close(); }catch(e){}
  S.ws = null;
}

// ── 封包處理 ────────────────────────────────────────────────
function handle(p){
  if(!p || !p.type) return;
  if(p.type === 'BATCH'){
    const evs = p.payload && p.payload.events;
    if(Array.isArray(evs)) for(const ev of evs){ try{ handle(ev); }catch(e){} }
    return;
  }
  const d = p.payload || {};
  switch(p.type){
    case 'JOIN_ACK': {
      S.pid = d.playerID; S.joined = true;
      if(d.reconnected){
        log('重連成功');
        send('REQUEST_UNITS', { includeOwn:true });
        return;
      }
      send('TEAM_LOADOUT_UPDATE', { team:S.team, loadout:{...LOADOUT}, pts:0 });
      send('PLAYER_READY',        { team:S.team, loadout:{...LOADOUT} });
      if(S._onJoined) S._onJoined();
      break;
    }
    case 'GAME_START':
      S.started = true;
      if(!S.deploying && !S.deployed) deploy();
      break;
    case 'UNIT_SPAWN': {
      if(!d.uid) break;
      const own = S.pid != null && String(d.uid).startsWith(S.pid + '_');
      if(own){
        const u = S.units[d.uid];
        if(u){ if(d.q != null) u.q = d.q; if(d.r != null) u.r = d.r; if(d.hp != null) u.hp = d.hp; }
        else if(d.hp > 0){ // 重連補課
          S.units[d.uid] = Object.assign({}, d, { mine:true, ammo:ammoMax(d.typeID) });
        }
      } else {
        S.units[d.uid] = { uid:d.uid, typeID:d.typeID, team:d.team, q:d.q, r:d.r, hp:d.hp, mine:false };
      }
      break;
    }
    case 'UNIT_MOVE': {
      const u = S.units[d.uid]; if(!u) { if(d.uid && d.hp > 0) S.units[d.uid] = { uid:d.uid, typeID:d.typeID, team:d.team, q:d.q, r:d.r, hp:d.hp, mine:false }; break; }
      if(d.hp != null && d.hp <= 0){ delete S.units[d.uid]; break; }
      if(!u.mine){ u.q = d.q; u.r = d.r; if(d.hp != null) u.hp = d.hp; }
      break;
    }
    case 'ATTACK_RESULT': {
      setHP(d.defenderUID, d.defenderHP);
      setHP(d.attackerUID, d.attackerHP);
      break;
    }
    case 'UNIT_DEATH_SYNC':
      if(d.uid != null) delete S.units[d.uid];
      break;
    case 'ALL_DEPLOYED':
      S.activeTeam = d.activeTeam || 'RED';
      if(S.activeTeam === S.team) scheduleTurn();
      break;
    case 'TURN_ADVANCE':
      S.activeTeam = d.activeTeam; S.turnCount = d.turnCount || S.turnCount;
      S.turnToken++;                       // 作廢上一輪還沒做完的動作
      S.acting = false;
      if(S.activeTeam === S.team && S.deployed) scheduleTurn();
      break;
    case 'GAME_OVER':
      log('對局結束'); stop(); break;
    case 'ERROR':
      log('伺服器訊息：', d.msg);
      break;
  }
}

function setHP(uid, hp){
  if(uid == null || hp == null) return;
  const u = S.units[uid]; if(!u) return;
  u.hp = hp;
  if(hp <= 0) delete S.units[uid];
}

// ── 規則輔助 ────────────────────────────────────────────────
function UT(typeID){ return B().unitTypes()[typeID]; }
function ammoMax(typeID){ const c = B().unitConfig()[typeID]; return (c && c.maxAmmo) || 10; }
function rangeOf(typeID){
  const r = UT(typeID).attackRange;
  if(Array.isArray(r)) return [r[0], r[1]];
  return [1, r || 1];
}
function visionOf(typeID){ const t = UT(typeID); return t.vision || t.visualRange || 3; }
function dist(a, b){ return B().cubeDist(a.q, a.r, b.q, b.r); }
function ownUnits(){ return Object.values(S.units).filter(u => u.mine && u.hp > 0); }
function enemyUnits(){ return Object.values(S.units).filter(u => !u.mine && u.team !== S.team && u.hp > 0); }

function calcDmg(a, d, rand){
  // 與主遊戲 executeAttackCommand 同公式（士氣視為滿值）
  const at = UT(a.typeID), dt = UT(d.typeID);
  const eAtk = at.attackPower * 1.1;
  const eDef = dt.defense * 1.1 + B().fortBonus(d);
  return Math.round(Math.max(1, (eAtk - eDef) * rand));
}
function inRangeOf(u, target){
  const rg = rangeOf(u.typeID), d = dist(u, target);
  return d >= rg[0] && d <= rg[1];
}

// 視野：只有「己方任一單位視野範圍內」的敵人才算看得到
function visibleEnemies(){
  const mine = ownUnits();
  const out = [];
  for(const e of enemyUnits()){
    for(const m of mine){
      if(dist(m, e) <= visionOf(m.typeID)){ out.push(e); S.seen[e.uid] = { q:e.q, r:e.r, turn:S.turnCount }; break; }
    }
  }
  return out;
}

// ── 部署 ────────────────────────────────────────────────────
async function deploy(){
  S.deploying = true;
  const b = B();
  for(let i = 0; i < 80 && !b.mapReady(); i++) await sleep(500);
  if(!b.mapReady()){ log('地圖遲遲未就緒，放棄部署'); return; }

  const zone    = b.spawnCells(S.team, false);
  const infZone = b.spawnCells(S.team, true);
  if(!zone.length){ log('找不到出生範圍'); return; }

  const anchor = zone[Math.floor(Math.random() * zone.length)];
  const byAnchor = pool => pool.slice().sort((x, y) => b.cubeDist(x.q, x.r, anchor.q, anchor.r) - b.cubeDist(y.q, y.r, anchor.q, anchor.r));
  const zoneS = byAnchor(zone), infS = byAnchor(infZone.length ? infZone : zone);
  const used = new Set();

  for(const typeID of Object.keys(LOADOUT)){
    for(let i = 0; i < LOADOUT[typeID]; i++){
      const pool = typeID === 'INFANTRY' ? infS : zoneS;
      const cell = pool.find(c => !used.has(c.q + ',' + c.r) && b.passable(c, typeID));
      if(!cell){ log('沒有空格可放', typeID); continue; }
      used.add(cell.q + ',' + cell.r);
      const uid = S.pid + '_' + (S.nextN++);
      const hp  = b.unitHP(typeID);
      S.units[uid] = { uid, typeID, team:S.team, q:cell.q, r:cell.r, hp, mine:true, ammo:ammoMax(typeID) };
      send('UNIT_SPAWN', { uid, typeID, team:S.team, q:cell.q, r:cell.r, hp });
      await sleep(120);
    }
  }
  S.deployed = true; S.deploying = false;
  setTimeout(()=> send('REQUEST_UNITS', {}), 2000);
  setTimeout(()=> { send('REQUEST_UNITS', {}); send('PLAYER_DEPLOYED', {}); }, 5000);
  log('部署完成', ownUnits().length, '支部隊');
}

// ── 回合行動 ────────────────────────────────────────────────
function myTurnValid(tok){ return !S.stopped && tok === S.turnToken && S.activeTeam === S.team; }

function scheduleTurn(){
  if(S.acting || S.stopped) return;
  S.acting = true;
  const tok = ++S.turnToken;
  runTurn(tok).catch(e => log('回合出錯', e)).then(()=>{ if(tok === S.turnToken) S.acting = false; });
}

async function runTurn(tok){
  await sleep(1500);
  const units = ownUnits().sort((a, b) => (UT(a.typeID).isLongRange ? 1 : 0) - (UT(b.typeID).isLongRange ? 1 : 0));
  for(const u of units){
    if(!myTurnValid(tok)) return;
    // 房主斷線 → 暫停，等房主回來（回合由伺服器計時器接手，不會卡死）
    while(!B().hostOnline() && myTurnValid(tok)) await sleep(1500);
    if(!myTurnValid(tok)) return;
    if(!S.units[u.uid] || u.hp <= 0) continue;
    await actUnit(u, tok);
    await sleep(ACT_DELAY);
  }
  if(!myTurnValid(tok)) return;
  for(const u of ownUnits()){ u.ammo = Math.min(ammoMax(u.typeID), (u.ammo || 0) + 1); }   // 簡化版：彈藥每回合 +1
  send('END_TURN', { turnCount:S.turnCount });
}

async function actUnit(u, tok){
  const b  = B();
  const ut = UT(u.typeID);
  const enemies = visibleEnemies();
  const occ = new Set(Object.values(S.units).filter(x => x.uid !== u.uid && x.hp > 0).map(x => x.q + ',' + x.r));

  // 可到達的格子（含原地）。moveRange 由主遊戲規則計算（地形、ZOC、單位限制）
  const cands = [{ q:u.q, r:u.r }];
  let reach; try{ reach = b.moveRange(u); }catch(e){ reach = new Set(); }
  for(const k of reach){
    if(occ.has(k)) continue;
    const [q, r] = k.split(',').map(Number);
    cands.push({ q, r });
  }

  // A) 找最佳「移動後攻擊」方案
  let best = null;
  if((u.ammo == null || u.ammo > 0) && enemies.length){
    const rg = rangeOf(u.typeID);
    for(const c of cands){
      for(const e of enemies){
        const d = b.cubeDist(c.q, c.r, e.q, e.r);
        if(d < rg[0] || d > rg[1]) continue;
        const dmg = calcDmg({ typeID:u.typeID }, e, 1.0);
        let score = dmg * (e.hp <= dmg ? 2.5 : 1) + (100 - e.hp) * 0.05;
        if(!ut.isLongRange){
          const ert = UT(e.typeID).attackRange;
          const er  = Array.isArray(ert) ? ert : [1, ert || 0];
          if(ert && d >= er[0] && d <= er[1]) score -= calcDmg(e, { typeID:u.typeID, q:c.q, r:c.r }, 1.0) * 0.8;
        }
        score -= b.cubeDist(u.q, u.r, c.q, c.r) * 0.1;
        if(!best || score > best.score) best = { score, c, e };
      }
    }
  }

  if(best && best.score <= 0) best = null;     // 打了只會吃虧的攻擊不做，改成前進/待命
  if(best){
    if(best.c.q !== u.q || best.c.r !== u.r) doMove(u, best.c.q, best.c.r);
    await sleep(450);
    if(myTurnValid(tok) && S.units[u.uid]) doAttack(u, best.e);
    return;
  }

  // B) 沒有可打的目標：朝最近的敵人（看得到 > 記憶中的位置 > 敵方出生區）前進
  const target = pickTarget(u, enemies);
  if(!target) return;
  let pick = null, bestD = b.cubeDist(u.q, u.r, target.q, target.r);
  for(const c of cands){
    const d = b.cubeDist(c.q, c.r, target.q, target.r);
    if(d < bestD || (d === bestD && pick && Math.random() < 0.3)){ bestD = d; pick = c; }
  }
  if(pick && (pick.q !== u.q || pick.r !== u.r)) doMove(u, pick.q, pick.r);
}

function pickTarget(u, enemies){
  let best = null, bd = Infinity;
  for(const e of enemies){ const d = dist(u, e); if(d < bd){ bd = d; best = { q:e.q, r:e.r }; } }
  if(best) return best;
  for(const uid of Object.keys(S.seen)){
    const s = S.seen[uid];
    if(S.turnCount - s.turn > SEEN_MEMORY){ delete S.seen[uid]; continue; }
    const d = dist(u, s); if(d < bd){ bd = d; best = { q:s.q, r:s.r }; }
  }
  if(best) return best;
  // 完全沒情報：往敵方出生區中心推進
  const z = B().spawnCells(S.team === 'RED' ? 'BLUE' : 'RED', false);
  if(!z.length) return null;
  let sq = 0, sr = 0; for(const c of z){ sq += c.q; sr += c.r; }
  return { q:Math.round(sq / z.length), r:Math.round(sr / z.length) };
}

function doMove(u, q, r){
  u.q = q; u.r = r; u.moved = true;
  send('UNIT_MOVE', { uid:u.uid, typeID:u.typeID, team:u.team, q, r, hp:u.hp, moved:true, isCrippled:false, stunned:0 });
}

function doAttack(a, e){
  const at = UT(a.typeID), dt = UT(e.typeID);
  const d  = dist(a, e);
  const atkBefore = a.hp, defBefore = e.hp;
  const dmg = calcDmg(a, e, 0.8 + Math.random() * 0.4);
  e.hp = Math.max(0, e.hp - dmg);
  let counter = 0;
  if(!at.isLongRange && e.hp > 0 && dt.attackRange){
    const er = Array.isArray(dt.attackRange) ? dt.attackRange : [1, dt.attackRange];
    if(d >= er[0] && d <= er[1]){
      counter = calcDmg(e, a, 0.8 + Math.random() * 0.4);
      a.hp = Math.max(0, a.hp - counter);
    }
  }
  if(a.ammo != null) a.ammo = Math.max(0, a.ammo - 1);
  send('ATTACK_RESULT', {
    attackerUID:a.uid, defenderUID:e.uid,
    attackerHP:a.hp, defenderHP:e.hp,
    damage:defBefore - e.hp, counterDmg:atkBefore - a.hp,
    attackerQ:a.q, attackerR:a.r, defenderQ:e.q, defenderR:e.r,
    cellPopularity:null, defenderWasAttacked:true,
    attackerIsConcealed:false, attackerAmbushReady:false,
    defenderAmmo:null, defenderSupply:null,
  });
  if(e.hp <= 0){
    send('UNIT_DEATH_SYNC', { uid:e.uid });
    try{ B().creditKill(e.typeID, e.team); }catch(err){}
    delete S.units[e.uid];
  }
  if(a.hp <= 0){
    send('UNIT_DEATH_SYNC', { uid:a.uid });
    delete S.units[a.uid];
  }
}

window.HexAI = { version:AI_VERSION, join, stop, _state:S };
log('AI 模組 v' + AI_VERSION + ' 已載入');
})();
