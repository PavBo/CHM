const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 4687 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chsl-restart-test-'));
const dbPath = path.join(dataDir, 'db.json');
let server = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, CHSL_TIME_SCALE: '0.2', CHSL_MIN_FUTURE_MS: '100', CHSL_CANCEL_PRIORITY_MS: '40', CHSL_SOLO_DEMO: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}
async function stopServer() {
  if (!server) return;
  const child = server;
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([new Promise(r => child.once('exit', r)), sleep(1200)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([new Promise(r => child.once('exit', r)), sleep(500)]);
  }
  server = null;
}
async function waitServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(base + '/api/time', { headers: { Connection: 'close' }, signal: AbortSignal.timeout(600) });
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('Server did not start');
}
function readDb() { return JSON.parse(fs.readFileSync(dbPath, 'utf8')); }
class Client {
  constructor(){ this.cookie=''; }
  async req(url, opts={}) {
    const headers = { 'Content-Type':'application/json', 'Connection':'close', ...(opts.headers||{}) };
    if (this.cookie) headers.Cookie = this.cookie;
    const r = await fetch(base + url, { ...opts, headers, signal: AbortSignal.timeout(5000) });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const data = await r.json().catch(()=>({}));
    if (!r.ok) throw Object.assign(new Error(data.message || `HTTP ${r.status}`), { status:r.status, data });
    return data;
  }
}

(async()=>{
  try {
    startServer(); await waitServer();
    const user = new Client(); const admin = new Client();
    await user.req('/api/auth/register',{method:'POST',body:JSON.stringify({username:'RestartUser'})});
    await admin.req('/api/auth/login',{method:'POST',body:JSON.stringify({username:'Admin'})});
    const tpl = await admin.req('/api/admin/templates',{method:'POST',body:JSON.stringify({name:'Restart continuity',fee:19,minPlayers:1,maxPlayers:10,commissionPercent:15,rowPayouts:[1,1,1]})});
    const created = await admin.req('/api/admin/tournaments',{method:'POST',body:JSON.stringify({templateId:tpl.template.id,startAt:new Date(Date.now()+1000).toISOString()})});
    await user.req(`/api/tournaments/${created.tournament.id}/join`,{method:'POST',headers:{'Idempotency-Key':'restart-join'},body:'{}'});

    await stopServer();
    let db = readDb();
    db.tournaments.find(t=>t.id===created.tournament.id).startAt = new Date(Date.now()-10).toISOString();
    fs.writeFileSync(dbPath, JSON.stringify(db,null,2));

    startServer(); await waitServer(); await sleep(80); await stopServer();
    db = readDb();
    const persisted = db.tournaments.find(t=>t.id===created.tournament.id);
    assert.equal(persisted.status,'in_progress');
    assert.equal(persisted.processedSpinIds.length,0);
    const sequence = JSON.stringify(persisted.spins);
    const commissionBeforeRestart = db.platform.earnedCommission;
    assert.equal(commissionBeforeRestart,2);

    persisted.startedAt = new Date(Date.now()-2000).toISOString();
    const persistedStartedAt = persisted.startedAt;
    fs.writeFileSync(dbPath, JSON.stringify(db,null,2));

    startServer(); await waitServer(); await sleep(120);
    const resumed = await user.req(`/api/tournaments/${created.tournament.id}`);
    assert.equal(resumed.tournament.startedAt,persistedStartedAt);
    const after = readDb().tournaments.find(t=>t.id===created.tournament.id);
    assert.equal(JSON.stringify(after.spins),sequence);
    assert.ok(after.processedSpinIds.length>=1);
    assert.equal(readDb().platform.earnedCommission,commissionBeforeRestart);
    console.log('✓ Restart continuity preserves RNG/timing and does not double-book platform commission');
  } catch(e) {
    console.error('RESTART TEST FAILED:', e.stack || e);
    process.exitCode = 1;
  } finally {
    await stopServer();
    try { fs.rmSync(dataDir,{recursive:true,force:true}); } catch {}
  }
})();
