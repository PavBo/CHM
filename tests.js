const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 4287 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chsl-test-'));
const dbPath = path.join(dataDir, 'db.json');
let server = null;
let serverLog = '';

const sleep = ms => new Promise(r=>setTimeout(r,ms));
function startServer() {
  serverLog = '';
  server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, CHSL_TIME_SCALE: '0.05', CHSL_MIN_FUTURE_MS: '100', CHSL_CANCEL_PRIORITY_MS: '80', CHSL_SOLO_DEMO: '0' }, stdio: ['ignore','pipe','pipe'] });
  server.stdout.on('data',d=>serverLog+=d); server.stderr.on('data',d=>serverLog+=d);
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
async function waitServer(){ for(let i=0;i<60;i++){ try{ const r=await fetch(base+'/api/time',{signal:AbortSignal.timeout(1000)}); if(r.ok)return; }catch{} await sleep(100);} throw new Error('Server did not start: '+serverLog); }
function readDb(){ return JSON.parse(fs.readFileSync(dbPath,'utf8')); }

class Client {
  constructor(){ this.cookie=''; }
  async req(url, opts={}) {
    const headers = { 'Content-Type':'application/json', 'Connection':'close', ...(opts.headers||{}) };
    if (this.cookie) headers.Cookie = this.cookie;
    const r = await fetch(base+url, { ...opts, headers, signal: AbortSignal.timeout(6000) });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const data = await r.json().catch(()=>({}));
    if (!r.ok) throw Object.assign(new Error(data.message||`HTTP ${r.status}`),{status:r.status,data});
    return data;
  }
}

(async()=>{
  try {
    startServer();
    await waitServer();
    const user = new Client(); const admin = new Client();

    const timeBefore = Date.now();
    let d = await user.req('/api/time');
    assert.ok(Math.abs(d.serverTime - timeBefore) < 1500);
    console.log('✓ Server clock endpoint is authoritative');

    const health = await user.req('/api/health');
    assert.equal(health.ok, true); assert.ok(/^1\.0\.0$/.test(health.version));
    console.log('✓ Deployment health endpoint reports the release version');

    d = await user.req('/api/auth/register',{method:'POST',body:JSON.stringify({username:'TestPlayer'})});
    assert.equal(d.user.available,10000); assert.equal(d.user.reserved,0);
    console.log('✓ Registration grants 10,000 Gold Coins');

    const caseA = new Client(); const caseB = new Client();
    await caseA.req('/api/auth/register',{method:'POST',body:JSON.stringify({username:'CasePlayer'})});
    let caseError = null;
    try { await caseB.req('/api/auth/register',{method:'POST',body:JSON.stringify({username:'caseplayer'})}); } catch(e) { caseError=e; }
    assert.equal(caseError?.status,409);
    console.log('✓ Username uniqueness is case-insensitive');

    let active = await user.req('/api/tournaments?scope=active');
    assert.ok(active.tournaments.length>=3);
    const seeded = active.tournaments[0];
    assert.equal(new Set(seeded.participants.map(p=>p.avatarId)).size,seeded.participants.length);
    console.log('✓ Avatar IDs are unique within a tournament');

    d = await user.req(`/api/tournaments/${seeded.id}/join`,{method:'POST',headers:{'Idempotency-Key':'same-join'},body:'{}'});
    const afterFirst = d.user.available;
    d = await user.req(`/api/tournaments/${seeded.id}/join`,{method:'POST',headers:{'Idempotency-Key':'same-join'},body:'{}'});
    assert.equal(d.user.available,afterFirst); assert.equal(d.user.reserved,seeded.fee);
    console.log('✓ Repeated join request reserves the fee once');

    const second = active.tournaments.find(t=>t.id!==seeded.id && t.status==='waiting');
    const beforeParallel = (await user.req('/api/me')).user;
    const parallel = await Promise.all([
      user.req(`/api/tournaments/${second.id}/join`,{method:'POST',headers:{'Idempotency-Key':'tab-A'},body:'{}'}),
      user.req(`/api/tournaments/${second.id}/join`,{method:'POST',headers:{'Idempotency-Key':'tab-B'},body:'{}'})
    ]);
    const afterParallel = (await user.req('/api/me')).user;
    assert.equal(afterParallel.available, beforeParallel.available - second.fee);
    assert.equal(afterParallel.reserved, beforeParallel.reserved + second.fee);
    assert.ok(parallel.some(x=>x.alreadyJoined) || parallel.every(x=>x.tournament.joined));
    console.log('✓ Parallel joins from multiple tabs/devices cannot double-reserve');

    await admin.req('/api/auth/login',{method:'POST',body:JSON.stringify({username:'Admin'})});
    await admin.req(`/api/admin/tournaments/${seeded.id}/cancel`,{method:'POST',body:'{}'});
    await admin.req(`/api/admin/tournaments/${second.id}/cancel`,{method:'POST',body:'{}'});
    d = await user.req('/api/me'); assert.equal(d.user.available,10000); assert.equal(d.user.reserved,0);
    console.log('✓ Admin cancel releases reserved funds');

    const raceTpl = await admin.req('/api/admin/templates',{method:'POST',body:JSON.stringify({name:'Cancel priority',fee:17,minPlayers:1,maxPlayers:5,commissionPercent:25,rowPayouts:[1,1,1]})});
    const raceStartMs = Date.now()+350;
    const raceTour = await admin.req('/api/admin/tournaments',{method:'POST',body:JSON.stringify({templateId:raceTpl.template.id,startAt:new Date(raceStartMs).toISOString()})});
    const beforeRace = (await user.req('/api/me')).user;
    await user.req(`/api/tournaments/${raceTour.tournament.id}/join`,{method:'POST',headers:{'Idempotency-Key':'cancel-priority-join'},body:'{}'});
    await sleep(Math.max(0,raceStartMs-Date.now()+20));
    let lateJoinError=null;
    try { await caseA.req(`/api/tournaments/${raceTour.tournament.id}/join`,{method:'POST',headers:{'Idempotency-Key':'late-during-priority-window'},body:'{}'}); } catch(e) { lateJoinError=e; }
    assert.equal(lateJoinError?.status,409); assert.equal(lateJoinError?.data?.error,'too_late');
    d = await user.req(`/api/tournaments/${raceTour.tournament.id}`);
    assert.equal(d.tournament.status,'waiting'); assert.equal(d.tournament.startPending,true); assert.equal(d.tournament.registrationOpen,false);
    await admin.req(`/api/admin/tournaments/${raceTour.tournament.id}/cancel`,{method:'POST',body:'{}'});
    const afterRace = (await user.req('/api/me')).user;
    const raceDb = readDb().tournaments.find(t=>t.id===raceTour.tournament.id);
    assert.equal(raceDb.status,'canceled'); assert.equal(raceDb.commission,0); assert.equal(raceDb.spins.length,0);
    assert.equal(afterRace.available,beforeRace.available); assert.equal(afterRace.reserved,beforeRace.reserved);
    console.log('✓ Admin cancellation at the start boundary has priority while registration is already closed');

    const fullTpl = await admin.req('/api/admin/templates',{method:'POST',body:JSON.stringify({name:'Capacity test',fee:7,minPlayers:1,maxPlayers:1,commissionPercent:0,rowPayouts:[1,1,1]})});
    const fullTour = await admin.req('/api/admin/tournaments',{method:'POST',body:JSON.stringify({templateId:fullTpl.template.id,startAt:new Date(Date.now()+60000).toISOString()})});
    await user.req(`/api/tournaments/${fullTour.tournament.id}/join`,{method:'POST',headers:{'Idempotency-Key':'capacity-first'},body:'{}'});
    let fullError = null;
    try { await caseA.req(`/api/tournaments/${fullTour.tournament.id}/join`,{method:'POST',headers:{'Idempotency-Key':'capacity-second'},body:'{}'}); } catch(e) { fullError=e; }
    assert.equal(fullError?.status,409); assert.equal(fullError?.data?.error,'tournament_full');
    await admin.req(`/api/admin/tournaments/${fullTour.tournament.id}/cancel`,{method:'POST',body:'{}'});
    console.log('✓ Maximum participant capacity is enforced atomically');

    const minTpl = await admin.req('/api/admin/templates',{method:'POST',body:JSON.stringify({name:'Minimum test',fee:13,minPlayers:2,maxPlayers:5,commissionPercent:10,rowPayouts:[1,1,1]})});
    const minTour = await admin.req('/api/admin/tournaments',{method:'POST',body:JSON.stringify({templateId:minTpl.template.id,startAt:new Date(Date.now()+250).toISOString()})});
    const beforeMin = (await user.req('/api/me')).user;
    await user.req(`/api/tournaments/${minTour.tournament.id}/join`,{method:'POST',headers:{'Idempotency-Key':'minimum-only-one'},body:'{}'});
    await sleep(650);
    d = await user.req(`/api/tournaments/${minTour.tournament.id}`);
    const afterMin = (await user.req('/api/me')).user;
    assert.equal(d.tournament.status,'canceled');
    assert.equal(d.tournament.cancelReason,'minimum_not_reached');
    assert.equal(afterMin.available,beforeMin.available);
    assert.equal(afterMin.reserved,beforeMin.reserved);
    console.log('✓ Missing minimum participants cancels the tournament and releases the fee');

    const hiddenTpl = await admin.req('/api/admin/templates',{method:'POST',body:JSON.stringify({name:'Hidden outcomes',fee:9,minPlayers:1,maxPlayers:5,commissionPercent:0,rowPayouts:[1,1,1]})});
    const hiddenTour = await admin.req('/api/admin/tournaments',{method:'POST',body:JSON.stringify({templateId:hiddenTpl.template.id,startAt:new Date(Date.now()+250).toISOString()})});
    await user.req(`/api/tournaments/${hiddenTour.tournament.id}/join`,{method:'POST',headers:{'Idempotency-Key':'hidden-outcome'},body:'{}'});
    await sleep(380);
    d = await user.req(`/api/tournaments/${hiddenTour.tournament.id}`);
    assert.equal(d.tournament.currentSpin?.phase,'spin');
    assert.ok(d.tournament.currentSpin?.rows.every(r=>r.winners===null));
    assert.equal('payouts' in d.tournament.currentSpin,false);
    await sleep(500);
    console.log('✓ Future spin winners are not exposed to clients before the result phase');

    const exactTpl = await admin.req('/api/admin/templates',{method:'POST',body:JSON.stringify({name:'Exact bank timing',fee:9,minPlayers:1,maxPlayers:5,commissionPercent:0,rowPayouts:[1,1,1]})});
    const exactStart = new Date(Date.now()+250).toISOString();
    const exactTour = await admin.req('/api/admin/tournaments',{method:'POST',body:JSON.stringify({templateId:exactTpl.template.id,startAt:exactStart})});
    await user.req(`/api/tournaments/${exactTour.tournament.id}/join`,{method:'POST',headers:{'Idempotency-Key':'exact-bank'},body:'{}'});
    await sleep(500);
    d = await user.req(`/api/tournaments/${exactTour.tournament.id}`);
    assert.equal(d.tournament.status,'in_progress');
    assert.equal(d.tournament.awarded,9);
    assert.equal(d.tournament.remaining,0);
    assert.ok(['result','pause'].includes(d.tournament.currentSpin?.phase), `expected result/pause after payout settlement, got ${d.tournament.currentSpin?.phase}`);
    const exactDb = readDb().tournaments.find(t=>t.id===exactTour.tournament.id);
    assert.equal(exactDb.spins.length,1); assert.equal(exactDb.spins[0].kind,'ordinary');
    console.log('✓ Ordinary payout settles at the configured result boundary; exact bank creates no final spin');

    const tpl = await admin.req('/api/admin/templates',{method:'POST',body:JSON.stringify({name:'Engine test',fee:11,minPlayers:1,maxPlayers:10,commissionPercent:15,rowPayouts:[1,1,1]})});
    const startAt = new Date(Date.now()+250).toISOString();
    const created = await admin.req('/api/admin/tournaments',{method:'POST',body:JSON.stringify({templateId:tpl.template.id,startAt})});
    await user.req(`/api/tournaments/${created.tournament.id}/join`,{method:'POST',headers:{'Idempotency-Key':'engine-join'},body:'{}'});
    await sleep(1100);
    d = await user.req(`/api/tournaments/${created.tournament.id}`);
    assert.equal(d.tournament.status,'finished');
    assert.equal(d.tournament.totalContributions,11);
    assert.equal(d.tournament.commission,1);
    assert.equal(d.tournament.prizeBank,10);
    assert.equal(d.tournament.awarded,10);
    assert.equal(d.tournament.remaining,0);
    assert.equal(d.tournament.myWinnings,10);
    assert.equal(d.tournament.finalResult?.candidates.length,3);
    assert.deepEqual(d.tournament.finalResult?.winner,d.tournament.finalResult?.candidates[1]);
    const engineDb = readDb().tournaments.find(t=>t.id===created.tournament.id);
    const finalSpin = engineDb.spins.find(s=>s.kind==='final');
    assert.equal(finalSpin.candidates.length,3);
    assert.deepEqual(finalSpin.winner, finalSpin.candidates[1]);
    console.log('✓ Engine: floor commission, line payouts and center-reel final remainder');

    const resultTpl = await admin.req('/api/admin/templates',{method:'POST',body:JSON.stringify({name:'Zero result coverage',fee:1,minPlayers:2,maxPlayers:2,commissionPercent:0,rowPayouts:[1,1,1]})});
    const resultTour = await admin.req('/api/admin/tournaments',{method:'POST',body:JSON.stringify({templateId:resultTpl.template.id,startAt:new Date(Date.now()+250).toISOString()})});
    await user.req(`/api/tournaments/${resultTour.tournament.id}/join`,{method:'POST',headers:{'Idempotency-Key':'results-user-a'},body:'{}'});
    await caseA.req(`/api/tournaments/${resultTour.tournament.id}/join`,{method:'POST',headers:{'Idempotency-Key':'results-user-b'},body:'{}'});
    await sleep(700);
    d = await user.req(`/api/tournaments/${resultTour.tournament.id}`);
    assert.equal(d.tournament.status,'finished');
    assert.equal(d.tournament.results.length,2);
    assert.deepEqual(d.tournament.results.map(x=>x.winnings).sort((a,b)=>b-a),[2,0]);
    assert.equal(d.tournament.results[0].winnings,2);
    assert.equal(d.tournament.results[1].winnings,0);
    console.log('✓ Final results include zero-win participants and are sorted by winnings');

    d = await admin.req('/api/admin/dashboard');
    assert.equal(d.economy.earnedCommission,1);
    assert.equal(d.audit.ok,true);
    console.log('✓ Platform commission is accounted for and the admin integrity audit passes');

    const details = await admin.req(`/api/admin/tournaments/${created.tournament.id}`);
    assert.equal(details.tournament.templateName,'Engine test');
    assert.equal(details.tournament.processedSpinCount,details.tournament.spinCount);
    assert.ok(details.tournament.ledger.some(x=>x.type==='commission_earned' && x.amount===1));
    console.log('✓ Admin can inspect tournament snapshot, participants, spins and ledger');

    console.log('✓ Restart continuity is covered by tests-restart.js');

    const immutable = await admin.req('/api/admin/tournaments',{method:'POST',body:JSON.stringify({templateId:tpl.template.id,startAt:new Date(Date.now()+60000).toISOString()})});
    await admin.req(`/api/admin/templates/${tpl.template.id}`,{method:'PUT',body:JSON.stringify({fee:25,minPlayers:1,maxPlayers:10,commissionPercent:20,rowPayouts:[2,2,2],name:'Engine test edited'})});
    d = await admin.req(`/api/tournaments/${immutable.tournament.id}`);
    assert.equal(d.tournament.fee,11); assert.equal(d.tournament.commissionPercent,15); assert.deepEqual(d.tournament.rowPayouts,[1,1,1]);
    console.log('✓ Created tournaments keep immutable template snapshots');

    const scheduleStart = new Date(Date.now()+90000).toISOString();
    const scheduleEnd = new Date(Date.now()+210000).toISOString();
    const schedule = await admin.req('/api/admin/schedules',{method:'POST',body:JSON.stringify({name:'Test period',templateId:tpl.template.id,count:3,periodStart:scheduleStart,periodEnd:scheduleEnd})});
    assert.equal(schedule.tournaments.length,3);
    const protectedScheduleTournament = schedule.tournaments[0];
    await caseA.req(`/api/tournaments/${protectedScheduleTournament.id}/join`,{method:'POST',headers:{'Idempotency-Key':'schedule-protected'},body:'{}'});
    const protectedStartAt = protectedScheduleTournament.startAt;
    const editedSchedule = await admin.req(`/api/admin/schedules/${schedule.schedule.id}`,{method:'PUT',body:JSON.stringify({name:'Test period edited',templateId:tpl.template.id,count:4,periodStart:scheduleStart,periodEnd:new Date(Date.now()+270000).toISOString()})});
    assert.equal(editedSchedule.schedule.count,4);
    assert.equal(editedSchedule.preserved,1);
    assert.equal(editedSchedule.regenerated,3);
    assert.equal(editedSchedule.schedule.generatedCount,4);
    const afterEditDb = readDb();
    const preservedAfterEdit = afterEditDb.tournaments.find(t=>t.id===protectedScheduleTournament.id);
    assert.ok(preservedAfterEdit);
    assert.equal(preservedAfterEdit.startAt,protectedStartAt);
    let perTournamentEditError=null;
    try { await admin.req(`/api/admin/tournaments/${protectedScheduleTournament.id}`,{method:'PUT',body:JSON.stringify({startAt:new Date(Date.now()+300000).toISOString()})}); } catch(e) { perTournamentEditError=e; }
    assert.equal(perTournamentEditError?.status,404);
    await admin.req(`/api/admin/tournaments/${protectedScheduleTournament.id}/cancel`,{method:'POST',body:'{}'});
    console.log('✓ Schedule can be edited as a whole; committed tournaments stay unchanged and individual generated tournaments cannot be edited');

    const pastSchedule = await admin.req('/api/admin/schedules',{method:'POST',body:JSON.stringify({
      name:'Past admin period',templateId:tpl.template.id,count:2,
      periodStart:new Date(Date.now()-10*60*1000).toISOString(),
      periodEnd:new Date(Date.now()-5*60*1000).toISOString()
    })});
    assert.equal(pastSchedule.tournaments.length,2);
    const pastManual = await admin.req('/api/admin/tournaments',{method:'POST',body:JSON.stringify({templateId:tpl.template.id,startAt:new Date(Date.now()-60*1000).toISOString()})});
    assert.ok(pastManual.tournament.id);
    console.log('✓ Admin date/time inputs have no future-only restriction');

    const soloDemo = await admin.req('/api/admin/test-schedule',{method:'POST',body:'{}'});
    assert.equal(soloDemo.template.fee,10);
    assert.equal(soloDemo.template.minPlayers,1);
    assert.equal(soloDemo.template.commissionPercent,0);
    assert.deepEqual(soloDemo.template.rowPayouts,[1,1,1]);
    assert.equal(soloDemo.intervalMinutes,2);
    assert.equal(soloDemo.durationMinutes,60);
    assert.equal(soloDemo.tournaments.length,31);
    assert.ok(soloDemo.tournaments.every(t=>t.fee===10 && t.minPlayers===1 && t.systemDemoSolo));
    const soloTimes=soloDemo.tournaments.map(t=>new Date(t.startAt).getTime());
    const firstSoloDelay=soloTimes[0]-Date.now();
    assert.ok(firstSoloDelay>=50000 && firstSoloDelay<=75000, `first solo delay ${firstSoloDelay}`);
    assert.ok(soloTimes.slice(1).every((ts,i)=>ts-soloTimes[i]===120000));

    const soloUser = new Client();
    await soloUser.req('/api/auth/register',{method:'POST',body:JSON.stringify({username:'SoloTester'})});
    const soloManual = await admin.req('/api/admin/tournaments',{method:'POST',body:JSON.stringify({templateId:soloDemo.template.id,startAt:new Date(Date.now()+250).toISOString()})});
    await soloUser.req(`/api/tournaments/${soloManual.tournament.id}/join`,{method:'POST',headers:{'Idempotency-Key':'solo-e2e'},body:'{}'});
    let soloState=null;
    for(let i=0;i<50;i++){ soloState=(await soloUser.req(`/api/tournaments/${soloManual.tournament.id}`)).tournament; if(soloState.status==='finished') break; await sleep(80); }
    assert.equal(soloState.status,'finished'); assert.equal(soloState.participantCount,1); assert.equal(soloState.prizeBank,10); assert.equal(soloState.awarded,10);
    const soloBalance=(await soloUser.req('/api/me')).user;
    assert.equal(soloBalance.available,10000); assert.equal(soloBalance.reserved,0);
    console.log('✓ One player can complete the 10 GC solo test flow end-to-end');

    console.log('✓ Admin can generate a one-player 10 GC test schedule every 2 minutes for about one hour');

    const inactiveTpl = await admin.req('/api/admin/templates',{method:'POST',body:JSON.stringify({name:'Deactivate me',fee:6,minPlayers:1,maxPlayers:5,commissionPercent:5,rowPayouts:[1,1,1]})});
    const beforeDeactivate = await admin.req('/api/admin/tournaments',{method:'POST',body:JSON.stringify({templateId:inactiveTpl.template.id,startAt:new Date(Date.now()+120000).toISOString()})});
    await admin.req(`/api/admin/templates/${inactiveTpl.template.id}`,{method:'PUT',body:JSON.stringify({active:false})});
    let inactiveError = null;
    try { await admin.req('/api/admin/tournaments',{method:'POST',body:JSON.stringify({templateId:inactiveTpl.template.id,startAt:new Date(Date.now()+150000).toISOString()})}); } catch(e) { inactiveError=e; }
    assert.equal(inactiveError?.status,404);
    const stillExists = await user.req(`/api/tournaments/${beforeDeactivate.tournament.id}`);
    assert.equal(stillExists.tournament.fee,6);
    await admin.req(`/api/admin/tournaments/${beforeDeactivate.tournament.id}/cancel`,{method:'POST',body:'{}'});
    console.log('✓ Deactivating a template blocks new tournaments without changing existing snapshots');

    const allNumbers = readDb().tournaments.map(t=>t.number);
    assert.equal(new Set(allNumbers).size,allNumbers.length);
    console.log('✓ Tournament public numbers are unique');

    d = await admin.req('/api/admin/audit');
    assert.equal(d.ok,true, d.issues?.join('; '));
    console.log('✓ Final accounting and reservation audit passes');

    let tooManyError = null;
    try { await admin.req('/api/admin/templates',{method:'POST',body:JSON.stringify({name:'Too many avatars',fee:10,minPlayers:1,maxPlayers:97,commissionPercent:10,rowPayouts:[1,1,1]})}); } catch(e) { tooManyError=e; }
    assert.equal(tooManyError?.status,400);
    console.log('✓ Template cannot exceed the 96-avatar unique pool');

    console.log('\nAll CHSL final-candidate core integration tests passed.');
  } catch(e) {
    console.error('\nTEST FAILED:', e.stack||e); process.exitCode=1;
  } finally {
    await stopServer();
    try{fs.rmSync(dataDir,{recursive:true,force:true});}catch{}
  }
})();
