const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4173);
const APP_VERSION = require('./package.json').version;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

const nowIso = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const normalizeUsername = (value) => String(value || '').trim().toLocaleLowerCase('ru-RU');
const validUsername = (value) => /^[\p{L}\p{N}]{3,20}$/u.test(String(value || '').trim());
const safeInt = (v, fallback = 0) => Number.isInteger(Number(v)) ? Number(v) : fallback;
const AVATAR_POOL_SIZE = 96;
const TIME_SCALE_RAW = Number(process.env.CHSL_TIME_SCALE || 1);
const TIME_SCALE = Number.isFinite(TIME_SCALE_RAW) && TIME_SCALE_RAW > 0 ? TIME_SCALE_RAW : 1;
const scaledMs = value => Math.max(10, Math.round(value * TIME_SCALE));
const MIN_FUTURE_START_MS_RAW = Number(process.env.CHSL_MIN_FUTURE_MS || 5000);
const MIN_FUTURE_START_MS = Number.isFinite(MIN_FUTURE_START_MS_RAW) && MIN_FUTURE_START_MS_RAW >= 0 ? MIN_FUTURE_START_MS_RAW : 5000;
const CANCEL_PRIORITY_WINDOW_MS_RAW = Number(process.env.CHSL_CANCEL_PRIORITY_MS || 1000);
const CANCEL_PRIORITY_WINDOW_MS = Number.isFinite(CANCEL_PRIORITY_WINDOW_MS_RAW) && CANCEL_PRIORITY_WINDOW_MS_RAW >= 0 ? CANCEL_PRIORITY_WINDOW_MS_RAW : 1000;
const SOLO_DEMO_ENABLED = process.env.CHSL_SOLO_DEMO !== '0';
const SOLO_DEMO_TEMPLATE_ID = 'tpl_solo_demo';
const SOLO_DEMO_INTERVAL_MS = 2 * 60 * 1000;
const SOLO_DEMO_DURATION_MS = 60 * 60 * 1000;
const SOLO_DEMO_LEAD_MS = 60 * 1000;

function defaultDb() {
  const created = nowIso();
  const admin = {
    id: 'user_admin', username: 'Admin', usernameKey: 'admin',
    available: 10000, reserved: 0, isAdmin: true, createdAt: created
  };
  const bots = Array.from({ length: 18 }, (_, i) => ({
    id: `bot_${i + 1}`,
    username: `Player${String(i + 1).padStart(2, '0')}`,
    usernameKey: `player${String(i + 1).padStart(2, '0')}`,
    available: 10000,
    reserved: 0,
    isAdmin: false,
    isBot: true,
    createdAt: created
  }));
  return {
    version: 6,
    users: [admin, ...bots],
    platform: { earnedCommission: 0 },
    sessions: {},
    schedules: [],
    templates: [
      { id: 'tpl_fast', name: 'Быстрый турнир', fee: 10, minPlayers: 4, maxPlayers: 40, commissionPercent: 15, rowPayouts: [1, 2, 3], active: true, createdAt: created },
      { id: 'tpl_main', name: 'Основной турнир', fee: 20, minPlayers: 6, maxPlayers: 40, commissionPercent: 15, rowPayouts: [2, 3, 5], active: true, createdAt: created },
      { id: 'tpl_high', name: 'Большой банк', fee: 50, minPlayers: 8, maxPlayers: 40, commissionPercent: 12, rowPayouts: [5, 8, 12], active: true, createdAt: created }
    ],
    tournaments: [],
    ledger: [],
    idempotency: {},
    createdAt: created
  };
}

let db;
function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    db = defaultDb();
    seedTournaments();
    if (SOLO_DEMO_ENABLED) ensureSoloDemoSchedule({ force: true, source: 'startup' });
    saveDb();
  } else {
    db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!Array.isArray(db.schedules)) db.schedules = [];
    if (!db.idempotency || typeof db.idempotency !== 'object') db.idempotency = {};
    if (!db.platform || typeof db.platform !== 'object') {
      db.platform = { earnedCommission: db.tournaments.filter(t => ['in_progress', 'finished'].includes(t.status)).reduce((sum, t) => sum + safeInt(t.commission), 0) };
    }
    for (const schedule of db.schedules) {
      if (!Number.isInteger(schedule.revision)) schedule.revision = 1;
      if (!Array.isArray(schedule.generatedTournamentIds)) schedule.generatedTournamentIds = [];
    }
    if (!Number.isInteger(db.version) || db.version < 6) db.version = 6;
    // Running tournaments keep their precomputed spin sequence in db.json.
    // On restart engineTick resumes from the persisted server startedAt timestamp.
    ensureActiveSchedule();
    if (SOLO_DEMO_ENABLED && ensureSoloDemoSchedule({ source: 'startup' }).changed) saveDb();
  }
}
function saveDb() {
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function snapshotTemplate(template) {
  return {
    templateId: template.id,
    templateName: template.name,
    fee: template.fee,
    minPlayers: template.minPlayers,
    maxPlayers: template.maxPlayers,
    commissionPercent: template.commissionPercent,
    rowPayouts: [...template.rowPayouts]
  };
}
function nextTournamentNumber() {
  const used = new Set(db.tournaments.map(t => Number(t.number)));
  for (let attempts = 0; attempts < 10000; attempts++) {
    const n = crypto.randomInt(100000, 1000000);
    if (!used.has(n)) return n;
  }
  let n = 100000;
  while (used.has(n)) n++;
  return n;
}
function createTournamentFromTemplate(template, startAt, extra = {}) {
  const tournament = {
    id: id('t'),
    number: nextTournamentNumber(),
    status: 'waiting',
    ...snapshotTemplate(template),
    startAt: new Date(startAt).toISOString(),
    participants: [],
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    canceledAt: null,
    cancelReason: null,
    totalContributions: 0,
    commission: 0,
    prizeBank: 0,
    awarded: 0,
    remaining: 0,
    spins: [],
    processedSpinIds: [],
    results: {},
    ...extra
  };
  db.tournaments.push(tournament);
  return tournament;
}

function scheduleSlots(periodStart, periodEnd, count) {
  const start = new Date(periodStart).getTime();
  const end = new Date(periodEnd).getTime();
  const span = end - start;
  return Array.from({ length: count }, (_, i) => count === 1 ? start : start + Math.round(span * i / (count - 1)));
}
function publicSchedule(schedule) {
  const linked = db.tournaments.filter(t => t.scheduleId === schedule.id);
  const mutable = linked.filter(t => t.status === 'waiting' && t.participants.length === 0);
  return {
    ...schedule,
    generatedTournamentIds: linked.map(t => t.id),
    generatedCount: linked.length,
    protectedCount: linked.length - mutable.length,
    editableFutureCount: mutable.length
  };
}
function regenerateSchedule(schedule, template, config) {
  const linked = db.tournaments.filter(t => t.scheduleId === schedule.id);
  // Schedule editing is an admin operation without a time restriction. Empty tournaments
  // that have not committed their start yet may be regenerated even if their timestamp
  // is current or already in the past. Started tournaments and tournaments with
  // participants remain immutable snapshots.
  const removable = linked.filter(t => t.status === 'waiting' && t.participants.length === 0);
  const protectedTournaments = linked.filter(t => !removable.includes(t));
  const periodStartMs = new Date(config.periodStart).getTime();
  const periodEndMs = new Date(config.periodEnd).getTime();

  if (protectedTournaments.length > config.count) {
    const err = new Error('Нельзя уменьшить количество ниже числа уже зафиксированных турниров');
    err.code = 'schedule_committed_count';
    throw err;
  }
  if (protectedTournaments.some(t => {
    const ts = new Date(t.startAt).getTime();
    return ts < periodStartMs || ts > periodEndMs;
  })) {
    const err = new Error('Новый период не может исключать уже начатые турниры или турниры с участниками');
    err.code = 'schedule_committed_period';
    throw err;
  }

  const removableIds = new Set(removable.map(t => t.id));
  db.tournaments = db.tournaments.filter(t => !removableIds.has(t.id));

  const slots = scheduleSlots(config.periodStart, config.periodEnd, config.count);
  const occupied = new Set();
  for (const tournament of protectedTournaments.slice().sort((a, b) => new Date(a.startAt) - new Date(b.startAt))) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    const ts = new Date(tournament.startAt).getTime();
    for (let i = 0; i < slots.length; i++) {
      if (occupied.has(i)) continue;
      const distance = Math.abs(slots[i] - ts);
      if (distance < bestDistance) { bestDistance = distance; bestIndex = i; }
    }
    if (bestIndex >= 0) occupied.add(bestIndex);
  }

  const created = [];
  for (let i = 0; i < slots.length; i++) {
    if (occupied.has(i)) continue;
    const tournament = createTournamentFromTemplate(template, slots[i], { scheduleId: schedule.id, scheduleRevision: (schedule.revision || 1) + 1 });
    created.push(tournament);
  }

  Object.assign(schedule, {
    name: config.name,
    templateId: template.id,
    periodStart: new Date(config.periodStart).toISOString(),
    periodEnd: new Date(config.periodEnd).toISOString(),
    count: config.count,
    revision: (schedule.revision || 1) + 1,
    updatedAt: nowIso()
  });
  schedule.generatedTournamentIds = db.tournaments.filter(t => t.scheduleId === schedule.id).map(t => t.id);
  return { created, protectedTournaments, removedCount: removable.length };
}
function avatarIdFor(tournament) {
  const used = new Set(tournament.participants.map(p => p.avatarId));
  for (let i = 1; i <= AVATAR_POOL_SIZE; i++) if (!used.has(i)) return i;
  throw new Error('Avatar pool exhausted for tournament');
}
function reserveForBot(bot, tournament) {
  if (tournament.participants.some(p => p.userId === bot.id)) return;
  if (tournament.participants.length >= tournament.maxPlayers) return;
  if (bot.available < tournament.fee) return;
  bot.available -= tournament.fee;
  bot.reserved += tournament.fee;
  tournament.participants.push({ userId: bot.id, username: bot.username, avatarId: avatarIdFor(tournament), joinedAt: nowIso(), reservedFee: tournament.fee });
  db.ledger.push({ id: id('tx'), userId: bot.id, tournamentId: tournament.id, type: 'fee_reserved', amount: tournament.fee, createdAt: nowIso(), demo: true });
}
function ensureSoloDemoTemplate() {
  let template = db.templates.find(t => t.id === SOLO_DEMO_TEMPLATE_ID);
  const desired = {
    name: 'Тестовый одиночный турнир',
    fee: 10,
    minPlayers: 1,
    maxPlayers: 40,
    commissionPercent: 0,
    rowPayouts: [1, 1, 1],
    active: true
  };
  if (!template) {
    template = { id: SOLO_DEMO_TEMPLATE_ID, ...desired, createdAt: nowIso(), systemDemo: true };
    db.templates.push(template);
  } else {
    Object.assign(template, desired, { systemDemo: true, updatedAt: nowIso() });
  }
  return template;
}

function nextSoloDemoStart(now = Date.now()) {
  // Keep the first solo-test tournament close enough for a manual QA pass: about
  // one minute from schedule creation, then continue at the agreed two-minute cadence.
  const target = now + SOLO_DEMO_LEAD_MS;
  return Math.ceil(target / 10000) * 10000;
}

function ensureSoloDemoSchedule({ force = false, source = 'auto' } = {}) {
  const now = Date.now();
  const template = ensureSoloDemoTemplate();
  const futureDemo = db.tournaments
    .filter(t => t.systemDemoSolo && t.status === 'waiting' && new Date(t.startAt).getTime() > now)
    .sort((a,b) => new Date(a.startAt) - new Date(b.startAt));
  const lastFuture = futureDemo.length ? new Date(futureDemo[futureDemo.length - 1].startAt).getTime() : 0;
  if (!force && futureDemo.length >= 3 && lastFuture >= now + 15 * 60 * 1000) {
    return { changed: false, template, schedule: db.schedules.find(s => s.systemDemoSolo && !s.archivedAt) || null, tournaments: futureDemo };
  }

  // Empty waiting demo tournaments may be safely replaced. Joined/started tournaments remain immutable.
  const removableIds = new Set(db.tournaments
    .filter(t => t.systemDemoSolo && t.status === 'waiting' && t.participants.length === 0)
    .map(t => t.id));
  if (force || lastFuture < now + 15 * 60 * 1000) {
    db.tournaments = db.tournaments.filter(t => !removableIds.has(t.id));
    for (const schedule of db.schedules.filter(s => s.systemDemoSolo && !s.archivedAt)) schedule.archivedAt = nowIso();
  }

  const protectedFuture = db.tournaments
    .filter(t => t.systemDemoSolo && t.status === 'waiting' && t.participants.length > 0 && new Date(t.startAt).getTime() > now)
    .sort((a,b) => new Date(a.startAt) - new Date(b.startAt));
  const protectedLast = protectedFuture.length ? new Date(protectedFuture[protectedFuture.length - 1].startAt).getTime() : 0;
  const periodStartMs = Math.max(nextSoloDemoStart(now), protectedLast ? protectedLast + SOLO_DEMO_INTERVAL_MS : 0);
  const periodEndMs = periodStartMs + SOLO_DEMO_DURATION_MS;
  const count = Math.floor(SOLO_DEMO_DURATION_MS / SOLO_DEMO_INTERVAL_MS) + 1; // every 2 minutes for ~1 hour
  const schedule = {
    id: id('sch'),
    name: 'Тестовый период — одиночные турниры',
    templateId: template.id,
    periodStart: new Date(periodStartMs).toISOString(),
    periodEnd: new Date(periodEndMs).toISOString(),
    count,
    revision: 1,
    createdAt: nowIso(),
    generatedTournamentIds: [],
    systemDemoSolo: true,
    source
  };
  const tournaments = [];
  for (let i = 0; i < count; i++) {
    const at = periodStartMs + i * SOLO_DEMO_INTERVAL_MS;
    const tournament = createTournamentFromTemplate(template, at, {
      scheduleId: schedule.id,
      scheduleRevision: 1,
      systemDemoSolo: true
    });
    schedule.generatedTournamentIds.push(tournament.id);
    tournaments.push(tournament);
  }
  db.schedules.push(schedule);
  return { changed: true, template, schedule, tournaments };
}

function seedTournaments() {
  const t0 = Date.now();
  const templates = db.templates;
  const starts = [90, 240, 420, 720, 1080, 1500];
  starts.forEach((sec, idx) => {
    const template = templates[idx % templates.length];
    const t = createTournamentFromTemplate(template, t0 + sec * 1000);
    const botCount = Math.min(template.maxPlayers - 2, template.minPlayers + 4 + idx);
    db.users.filter(u => u.isBot).slice(0, botCount).forEach(bot => reserveForBot(bot, t));
  });
}
function ensureActiveSchedule() {
  const now = Date.now();
  const future = db.tournaments.filter(t => t.status === 'waiting' && new Date(t.startAt).getTime() > now).length;
  if (future >= 3) return;
  const base = now + 120000;
  for (let i = 0; i < 4; i++) {
    const publicTemplates = db.templates.filter(t => t.active && !t.systemDemo);
    const template = publicTemplates[i % publicTemplates.length];
    if (!template) break;
    const t = createTournamentFromTemplate(template, base + i * 240000);
    db.users.filter(u => u.isBot).slice(0, template.minPlayers + 3).forEach(bot => reserveForBot(bot, t));
  }
  saveDb();
}

function participantUser(t, userId) {
  return t.participants.find(p => p.userId === userId);
}
function randomParticipant(t) {
  return t.participants[crypto.randomInt(0, t.participants.length)];
}

function startTournament(t) {
  if (t.status !== 'waiting') return;
  if (t.participants.length < t.minPlayers) {
    cancelTournament(t, 'minimum_not_reached');
    return;
  }
  t.status = 'in_progress';
  // The canonical timeline begins at the scheduled server timestamp, not at the
  // moment an engine tick happens to notice it. If the process was temporarily
  // offline at start time, the engine can fast-forward the persisted tournament
  // to the correct current phase on recovery.
  t.startedAt = t.startAt;
  t.totalContributions = t.fee * t.participants.length;
  t.commission = Math.floor(t.totalContributions * t.commissionPercent / 100);
  t.prizeBank = t.totalContributions - t.commission;
  t.remaining = t.prizeBank;
  db.platform.earnedCommission += t.commission;
  db.ledger.push({ id: id('tx'), userId: null, tournamentId: t.id, type: 'commission_earned', amount: t.commission, createdAt: nowIso() });
  t.awarded = 0;
  t.results = Object.fromEntries(t.participants.map(p => [p.userId, 0]));

  for (const p of t.participants) {
    const u = db.users.find(x => x.id === p.userId);
    if (u) {
      u.reserved = Math.max(0, u.reserved - t.fee);
      db.ledger.push({ id: id('tx'), userId: u.id, tournamentId: t.id, type: 'fee_spent', amount: t.fee, createdAt: nowIso() });
    }
  }

  const ordinaryCost = 3 * t.rowPayouts.reduce((a, b) => a + b, 0);
  let remaining = t.prizeBank;
  let offsetMs = 0;
  let index = 0;
  while (remaining >= ordinaryCost && ordinaryCost > 0) {
    const rows = t.rowPayouts.map((amount, rowIndex) => ({
      rowIndex,
      amount,
      winners: [randomParticipant(t), randomParticipant(t), randomParticipant(t)].map(p => ({ userId: p.userId, username: p.username, avatarId: p.avatarId }))
    }));
    const payouts = [];
    rows.forEach(r => r.winners.forEach(w => payouts.push({ userId: w.userId, amount: r.amount })));
    t.spins.push({
      id: id('spin'), index, kind: 'ordinary', startsAtMs: offsetMs,
      spinMs: scaledMs(4000), resultMs: scaledMs(2000), pauseMs: scaledMs(1000),
      durationMs: scaledMs(7000), settleAtMs: offsetMs + scaledMs(4000), resultEndsAtMs: offsetMs + scaledMs(6000),
      rows, payouts, totalPayout: ordinaryCost
    });
    remaining -= ordinaryCost;
    offsetMs += scaledMs(7000);
    index++;
  }
  if (remaining > 0) {
    // Final draw uses only the center reel: three independently selected participants
    // are shown vertically and the middle participant wins the whole remainder.
    const candidates = [randomParticipant(t), randomParticipant(t), randomParticipant(t)]
      .map(p => ({ userId: p.userId, username: p.username, avatarId: p.avatarId }));
    const winner = candidates[1];
    t.spins.push({
      id: id('spin'), index, kind: 'final', startsAtMs: offsetMs,
      spinMs: scaledMs(5000), resultMs: 0, pauseMs: 0,
      durationMs: scaledMs(5000), settleAtMs: offsetMs + scaledMs(5000), resultEndsAtMs: offsetMs + scaledMs(5000),
      candidates, winner,
      payouts: [{ userId: winner.userId, amount: remaining }], totalPayout: remaining
    });
  }
  notifyTournament(t.id, 'started', publicTournament(t));
  saveDb();
}
function processSpin(t, spin) {
  if (t.processedSpinIds.includes(spin.id)) return;
  for (const payout of spin.payouts) {
    t.results[payout.userId] = (t.results[payout.userId] || 0) + payout.amount;
    const u = db.users.find(x => x.id === payout.userId);
    if (u) {
      u.available += payout.amount;
      db.ledger.push({ id: id('tx'), userId: u.id, tournamentId: t.id, spinId: spin.id, type: 'win', amount: payout.amount, createdAt: nowIso() });
    }
  }
  t.awarded += spin.totalPayout;
  t.remaining = Math.max(0, t.prizeBank - t.awarded);
  t.processedSpinIds.push(spin.id);
  notifyTournament(t.id, 'spin_settled', { spinId: spin.id, awarded: t.awarded, remaining: t.remaining });
}
function finishTournament(t) {
  if (t.status !== 'in_progress') return;
  t.status = 'finished';
  t.finishedAt = nowIso();
  t.remaining = 0;
  notifyTournament(t.id, 'finished', publicTournament(t));
  saveDb();
}
function cancelTournament(t, reason = 'admin') {
  if (!['waiting'].includes(t.status)) return false;
  t.status = 'canceled';
  t.cancelReason = reason;
  t.canceledAt = nowIso();
  for (const p of t.participants) {
    const u = db.users.find(x => x.id === p.userId);
    if (u) {
      u.reserved = Math.max(0, u.reserved - t.fee);
      u.available += t.fee;
      db.ledger.push({ id: id('tx'), userId: u.id, tournamentId: t.id, type: 'fee_released', amount: t.fee, createdAt: nowIso() });
    }
  }
  notifyTournament(t.id, 'canceled', publicTournament(t));
  saveDb();
  return true;
}

const sseClients = new Map();
function notifyTournament(tournamentId, event, payload) {
  const clients = sseClients.get(tournamentId);
  if (!clients) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.res.write(msg);
}

function engineTick() {
  const now = Date.now();
  let dirty = false;
  for (const t of db.tournaments) {
    // Registration closes exactly at startAt, but committing the start is delayed
    // for a short deterministic window so an admin cancellation received at the
    // same boundary always wins over the automatic start. The tournament timeline
    // still uses the original startAt, so after commit the engine catches up to the
    // correct phase rather than shifting the tournament later.
    if (t.status === 'waiting' && new Date(t.startAt).getTime() + CANCEL_PRIORITY_WINDOW_MS <= now) {
      startTournament(t); dirty = true;
    }
    if (t.status === 'in_progress') {
      const elapsed = now - new Date(t.startedAt).getTime();
      for (const spin of t.spins) {
        const settleAt = Number.isFinite(spin.settleAtMs) ? spin.settleAtMs : spin.startsAtMs + spin.durationMs;
        if (elapsed >= settleAt && !t.processedSpinIds.includes(spin.id)) {
          processSpin(t, spin); dirty = true;
        }
      }
      const totalDuration = t.spins.reduce((m, s) => Math.max(m, s.startsAtMs + s.durationMs), 0);
      if (elapsed >= totalDuration && t.processedSpinIds.length === t.spins.length) {
        finishTournament(t); dirty = true;
      }
    }
  }
  if (dirty) saveDb();
}
setInterval(engineTick, scaledMs(500)).unref();
setInterval(() => {
  ensureActiveSchedule();
  if (SOLO_DEMO_ENABLED && ensureSoloDemoSchedule({ source: 'rolling' }).changed) saveDb();
  for (const [tid, clients] of sseClients) {
    const t = db.tournaments.find(x => x.id === tid);
    if (!t) continue;
    for (const client of clients) {
      const data = `event: tick\ndata: ${JSON.stringify({ serverTime: Date.now(), tournament: publicTournament(t, client.userId) })}\n\n`;
      client.res.write(data);
    }
  }
}, 1000).unref();

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, available: u.available, reserved: u.reserved, isAdmin: !!u.isAdmin };
}
function currentSpinInfo(t) {
  if (t.status !== 'in_progress' || !t.startedAt) return null;
  const elapsed = Date.now() - new Date(t.startedAt).getTime();
  const spin = t.spins.find(s => elapsed >= s.startsAtMs && elapsed < s.startsAtMs + s.durationMs) || null;
  if (!spin) return null;
  const localElapsed = Math.max(0, elapsed - spin.startsAtMs);
  const spinMs = Number.isFinite(spin.spinMs) ? spin.spinMs : Math.min(4000, spin.durationMs);
  const resultMs = Number.isFinite(spin.resultMs) ? spin.resultMs : Math.max(0, spin.durationMs - spinMs);
  let phase = 'spin';
  let phaseEndsAtMs = spin.startsAtMs + spinMs;
  if (localElapsed >= spinMs) {
    if (localElapsed < spinMs + resultMs) {
      phase = 'result';
      phaseEndsAtMs = spin.startsAtMs + spinMs + resultMs;
    } else {
      phase = 'pause';
      phaseEndsAtMs = spin.startsAtMs + spin.durationMs;
    }
  }
  if (spin.kind === 'final') {
    phase = localElapsed < spinMs ? 'spin' : 'result';
    phaseEndsAtMs = spin.startsAtMs + spin.durationMs;
  }
  const base = {
    id: spin.id,
    index: spin.index,
    kind: spin.kind,
    startsAtMs: spin.startsAtMs,
    spinMs: spin.spinMs,
    resultMs: spin.resultMs,
    pauseMs: spin.pauseMs,
    durationMs: spin.durationMs,
    totalPayout: spin.totalPayout,
    phase,
    elapsedMs: localElapsed,
    remainingMs: Math.max(0, spin.startsAtMs + spin.durationMs - elapsed),
    phaseRemainingMs: Math.max(0, phaseEndsAtMs - elapsed),
    serverStartsAt: new Date(t.startedAt).getTime() + spin.startsAtMs,
    serverEndsAt: new Date(t.startedAt).getTime() + spin.startsAtMs + spin.durationMs,
    serverPhaseEndsAt: new Date(t.startedAt).getTime() + phaseEndsAtMs
  };
  if (spin.kind === 'ordinary') {
    base.rows = spin.rows.map(r => ({
      rowIndex: r.rowIndex,
      amount: r.amount,
      winners: phase === 'spin' ? null : r.winners
    }));
  } else if (spin.kind === 'final' && phase !== 'spin') {
    base.candidates = spin.candidates;
    base.winner = spin.winner;
  }
  return base;
}
function publicTournament(t, userId = null) {
  const startAtMs = new Date(t.startAt).getTime();
  const startPending = t.status === 'waiting' && Date.now() >= startAtMs;
  return {
    id: t.id, number: t.number, status: t.status, startPending, registrationOpen: t.status === 'waiting' && !startPending, fee: t.fee, minPlayers: t.minPlayers, maxPlayers: t.maxPlayers, templateName: t.templateName, systemDemoSolo: !!t.systemDemoSolo,
    commissionPercent: t.commissionPercent, rowPayouts: t.rowPayouts, startAt: t.startAt, startedAt: t.startedAt, finishedAt: t.finishedAt,
    participantCount: t.participants.length, participants: t.participants.map(p => ({ userId: p.userId, username: p.username, avatarId: p.avatarId })),
    joined: userId ? !!participantUser(t, userId) : false,
    myWinnings: userId ? ((t.results && t.results[userId]) || 0) : 0,
    totalContributions: t.totalContributions, commission: t.commission, prizeBank: t.prizeBank, awarded: t.awarded, remaining: t.remaining,
    currentSpin: currentSpinInfo(t),
    cancelReason: t.cancelReason,
    results: ['finished'].includes(t.status) ? resultsFor(t) : undefined
  };
}
function resultsFor(t) {
  return t.participants.map(p => ({
    userId: p.userId, username: p.username, avatarId: p.avatarId, winnings: t.results?.[p.userId] || 0
  })).sort((a, b) => b.winnings - a.winnings || a.username.localeCompare(b.username));
}


function adminTournamentDetails(t) {
  return {
    ...publicTournament(t, 'user_admin'),
    templateId: t.templateId,
    templateName: t.templateName,
    scheduleId: t.scheduleId || null,
    createdAt: t.createdAt,
    canceledAt: t.canceledAt,
    ordinarySpinCost: 3 * t.rowPayouts.reduce((a, b) => a + b, 0),
    spinCount: t.spins.length,
    processedSpinCount: t.processedSpinIds.length,
    participants: t.participants.map(p => ({ ...p, winnings: t.results?.[p.userId] || 0 })),
    ledger: db.ledger.filter(x => x.tournamentId === t.id).map(x => ({ ...x }))
  };
}
function auditState() {
  const issues = [];
  const expectedReserved = new Map(db.users.map(u => [u.id, 0]));
  for (const t of db.tournaments.filter(t => t.status === 'waiting')) {
    for (const p of t.participants) expectedReserved.set(p.userId, (expectedReserved.get(p.userId) || 0) + t.fee);
  }
  for (const u of db.users) {
    if (!Number.isInteger(u.available) || u.available < 0) issues.push(`Некорректный доступный баланс: ${u.username}`);
    if (!Number.isInteger(u.reserved) || u.reserved < 0) issues.push(`Некорректный резерв: ${u.username}`);
    const expected = expectedReserved.get(u.id) || 0;
    if (u.reserved !== expected) issues.push(`Резерв ${u.username}: фактически ${u.reserved}, ожидается ${expected}`);
  }
  const numbers = new Set();
  for (const t of db.tournaments) {
    if (numbers.has(t.number)) issues.push(`Дублирующийся номер турнира #${t.number}`);
    numbers.add(t.number);
    if (t.participants.length > t.maxPlayers) issues.push(`Переполнение турнира #${t.number}`);
    if (new Set(t.participants.map(p => p.avatarId)).size !== t.participants.length) issues.push(`Повтор аватара в турнире #${t.number}`);
    if (['in_progress', 'finished'].includes(t.status)) {
      if (t.prizeBank !== t.totalContributions - t.commission) issues.push(`Экономика банка нарушена в #${t.number}`);
      if (t.awarded + t.remaining !== t.prizeBank) issues.push(`Распределение банка нарушено в #${t.number}`);
      if (t.processedSpinIds.length > t.spins.length) issues.push(`Некорректный счетчик спинов в #${t.number}`);
    }
  }
  const expectedCommission = db.tournaments.filter(t => ['in_progress', 'finished'].includes(t.status)).reduce((sum, t) => sum + safeInt(t.commission), 0);
  if (safeInt(db.platform?.earnedCommission) !== expectedCommission) issues.push(`Комиссия платформы: фактически ${safeInt(db.platform?.earnedCommission)}, ожидается ${expectedCommission}`);
  return { ok: issues.length === 0, issues, checkedAt: nowIso() };
}
function adminDashboard() {
  const realUsers = db.users.filter(u => !u.isBot);
  const statuses = Object.fromEntries(['waiting','in_progress','finished','canceled'].map(status => [status, db.tournaments.filter(t => t.status === status).length]));
  return {
    users: { registered: realUsers.length, bots: db.users.filter(u => u.isBot).length },
    tournaments: statuses,
    balances: {
      available: realUsers.reduce((sum, u) => sum + safeInt(u.available), 0),
      reserved: realUsers.reduce((sum, u) => sum + safeInt(u.reserved), 0)
    },
    economy: {
      earnedCommission: safeInt(db.platform?.earnedCommission),
      totalContributions: db.tournaments.filter(t => ['in_progress','finished'].includes(t.status)).reduce((sum, t) => sum + safeInt(t.totalContributions), 0),
      totalAwarded: db.tournaments.reduce((sum, t) => sum + safeInt(t.awarded), 0)
    },
    audit: auditState()
  };
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}
function authUser(req) {
  const sid = parseCookies(req).chsl_session;
  const uid = sid && db.sessions[sid];
  return db.users.find(u => u.id === uid) || null;
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
function fail(res, status, message, code = 'error') { json(res, status, { error: code, message }); }
function requireUser(req, res) {
  const u = authUser(req); if (!u) fail(res, 401, 'Требуется вход', 'unauthorized'); return u;
}
function requireAdmin(req, res) {
  const u = requireUser(req, res); if (!u) return null; if (!u.isAdmin) { fail(res, 403, 'Требуются права администратора', 'forbidden'); return null; } return u;
}

async function handleApi(req, res, url) {
  const method = req.method;
  if (method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, version: APP_VERSION, serverTime: Date.now(), soloDemoEnabled: SOLO_DEMO_ENABLED });
  if (method === 'GET' && url.pathname === '/api/time') return json(res, 200, { serverTime: Date.now() });
  if (method === 'GET' && url.pathname === '/api/me') return json(res, 200, { user: publicUser(authUser(req)), serverTime: Date.now() });

  if (method === 'POST' && ['/api/auth/register', '/api/auth/login'].includes(url.pathname)) {
    let body; try { body = await readJson(req); } catch { return fail(res, 400, 'Некорректный JSON'); }
    const username = String(body.username || '').trim();
    if (!validUsername(username)) return fail(res, 400, 'Username: 3–20 символов, только буквы и цифры', 'invalid_username');
    const key = normalizeUsername(username);
    let user = db.users.find(u => u.usernameKey === key);
    if (url.pathname.endsWith('/register')) {
      if (user) return fail(res, 409, 'Такой username уже существует', 'username_taken');
      if (key === 'admin') return fail(res, 409, 'Имя Admin зарезервировано', 'username_taken');
      user = { id: id('user'), username, usernameKey: key, available: 10000, reserved: 0, isAdmin: false, createdAt: nowIso() };
      db.users.push(user);
      db.ledger.push({ id: id('tx'), userId: user.id, type: 'registration_bonus', amount: 10000, createdAt: nowIso() });
    } else {
      if (!user) return fail(res, 404, 'Пользователь не найден', 'user_not_found');
    }
    const sid = crypto.randomBytes(24).toString('hex');
    db.sessions[sid] = user.id; saveDb();
    return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': `chsl_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` });
  }
  if (method === 'POST' && url.pathname === '/api/auth/logout') {
    const sid = parseCookies(req).chsl_session; if (sid) delete db.sessions[sid]; saveDb();
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'chsl_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }

  if (method === 'GET' && url.pathname === '/api/tournaments') {
    const user = requireUser(req, res); if (!user) return;
    const scope = url.searchParams.get('scope') || 'active';
    let list = db.tournaments.slice();
    if (scope === 'active') list = list.filter(t => ['waiting', 'in_progress'].includes(t.status));
    else if (scope === 'mine') list = list.filter(t => participantUser(t, user.id));
    else if (scope === 'past') list = list.filter(t => ['finished', 'canceled'].includes(t.status));
    list.sort((a, b) => scope === 'past' ? new Date(b.finishedAt || b.canceledAt || b.startAt) - new Date(a.finishedAt || a.canceledAt || a.startAt) : new Date(a.startAt) - new Date(b.startAt));
    return json(res, 200, { tournaments: list.map(t => publicTournament(t, user.id)), serverTime: Date.now() });
  }

  const match = url.pathname.match(/^\/api\/tournaments\/([^/]+)(?:\/(join|results|stream))?$/);
  if (match) {
    const user = requireUser(req, res); if (!user) return;
    const t = db.tournaments.find(x => x.id === match[1]);
    if (!t) return fail(res, 404, 'Турнир не найден', 'not_found');
    const action = match[2];
    if (method === 'GET' && !action) return json(res, 200, { tournament: publicTournament(t, user.id), serverTime: Date.now() });
    if (method === 'GET' && action === 'results') return json(res, 200, { results: resultsFor(t), tournament: publicTournament(t, user.id) });
    if (method === 'GET' && action === 'stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: tick\ndata: ${JSON.stringify({ serverTime: Date.now(), tournament: publicTournament(t, user.id) })}\n\n`);
      if (!sseClients.has(t.id)) sseClients.set(t.id, new Set());
      const client = { res, userId: user.id };
      sseClients.get(t.id).add(client);
      req.on('close', () => sseClients.get(t.id)?.delete(client));
      return;
    }
    if (method === 'POST' && action === 'join') {
      const idemKey = req.headers['idempotency-key'] || '';
      const idemId = `${user.id}:${t.id}:${idemKey}`;
      if (idemKey && db.idempotency[idemId]) return json(res, 200, db.idempotency[idemId]);
      if (t.status !== 'waiting') return fail(res, 409, 'Регистрация в этот турнир уже закрыта', 'tournament_not_waiting');
      if (Date.now() >= new Date(t.startAt).getTime()) return fail(res, 409, 'Турнир уже начинается', 'too_late');
      if (participantUser(t, user.id)) return json(res, 200, { tournament: publicTournament(t, user.id), user: publicUser(user), alreadyJoined: true });
      if (t.participants.length >= t.maxPlayers) return fail(res, 409, 'Все места заняты', 'tournament_full');
      if (user.available < t.fee) return fail(res, 409, 'Недостаточно Gold Coins', 'insufficient_balance');
      user.available -= t.fee; user.reserved += t.fee;
      t.participants.push({ userId: user.id, username: user.username, avatarId: avatarIdFor(t), joinedAt: nowIso(), reservedFee: t.fee });
      db.ledger.push({ id: id('tx'), userId: user.id, tournamentId: t.id, type: 'fee_reserved', amount: t.fee, createdAt: nowIso() });
      const payload = { tournament: publicTournament(t, user.id), user: publicUser(user) };
      if (idemKey) db.idempotency[idemId] = payload;
      saveDb(); notifyTournament(t.id, 'participant_joined', publicTournament(t));
      return json(res, 200, payload);
    }
  }

  if (url.pathname.startsWith('/api/admin/')) {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (method === 'GET' && url.pathname === '/api/admin/dashboard') return json(res, 200, adminDashboard());
    if (method === 'GET' && url.pathname === '/api/admin/audit') return json(res, 200, auditState());
    if (method === 'GET' && url.pathname === '/api/admin/templates') return json(res, 200, { templates: db.templates });
    if (method === 'POST' && url.pathname === '/api/admin/templates') {
      let b; try { b = await readJson(req); } catch { return fail(res, 400, 'Некорректный JSON'); }
      const rowPayouts = Array.isArray(b.rowPayouts) ? b.rowPayouts.map(Number) : [];
      const template = {
        id: id('tpl'), name: String(b.name || 'Шаблон').trim().slice(0, 60), fee: safeInt(b.fee), minPlayers: safeInt(b.minPlayers), maxPlayers: safeInt(b.maxPlayers),
        commissionPercent: safeInt(b.commissionPercent), rowPayouts, active: true, createdAt: nowIso()
      };
      if (template.fee <= 0 || template.minPlayers <= 0 || template.maxPlayers < template.minPlayers || template.maxPlayers > AVATAR_POOL_SIZE || template.commissionPercent < 0 || template.commissionPercent > 100 || rowPayouts.length !== 3 || rowPayouts.some(x => !Number.isInteger(x) || x <= 0)) return fail(res, 400, 'Проверьте параметры шаблона', 'invalid_template');
      db.templates.push(template); saveDb(); return json(res, 201, { template });
    }
    const templateMatch = url.pathname.match(/^\/api\/admin\/templates\/([^/]+)$/);
    if (method === 'PUT' && templateMatch) {
      let b; try { b = await readJson(req); } catch { return fail(res, 400, 'Некорректный JSON'); }
      const template = db.templates.find(x => x.id === templateMatch[1]);
      if (!template) return fail(res, 404, 'Шаблон не найден');
      const rowPayouts = Array.isArray(b.rowPayouts) ? b.rowPayouts.map(Number) : template.rowPayouts;
      const next = {
        name: String(b.name ?? template.name).trim().slice(0, 60),
        fee: safeInt(b.fee ?? template.fee),
        minPlayers: safeInt(b.minPlayers ?? template.minPlayers),
        maxPlayers: safeInt(b.maxPlayers ?? template.maxPlayers),
        commissionPercent: safeInt(b.commissionPercent ?? template.commissionPercent),
        rowPayouts,
        active: b.active === undefined ? template.active : !!b.active
      };
      if (!next.name || next.fee <= 0 || next.minPlayers <= 0 || next.maxPlayers < next.minPlayers || next.maxPlayers > AVATAR_POOL_SIZE || next.commissionPercent < 0 || next.commissionPercent > 100 || next.rowPayouts.length !== 3 || next.rowPayouts.some(x => !Number.isInteger(x) || x <= 0)) return fail(res, 400, 'Проверьте параметры шаблона', 'invalid_template');
      Object.assign(template, next, { updatedAt: nowIso() });
      saveDb();
      return json(res, 200, { template });
    }
    if (method === 'GET' && url.pathname === '/api/admin/schedules') return json(res, 200, { schedules: db.schedules.map(publicSchedule) });
    if (method === 'POST' && url.pathname === '/api/admin/test-schedule') {
      const created = ensureSoloDemoSchedule({ force: true, source: 'admin' });
      saveDb();
      return json(res, 201, {
        template: created.template,
        schedule: publicSchedule(created.schedule),
        tournaments: created.tournaments.map(t => publicTournament(t, admin.id)),
        intervalMinutes: SOLO_DEMO_INTERVAL_MS / 60000,
        durationMinutes: SOLO_DEMO_DURATION_MS / 60000
      });
    }
    if (method === 'POST' && url.pathname === '/api/admin/schedules') {
      let b; try { b = await readJson(req); } catch { return fail(res, 400, 'Некорректный JSON'); }
      const template = db.templates.find(x => x.id === b.templateId && x.active);
      if (!template) return fail(res, 404, 'Шаблон не найден');
      const periodStart = new Date(b.periodStart);
      const periodEnd = new Date(b.periodEnd);
      const count = safeInt(b.count);
      if (!Number.isFinite(periodStart.getTime()) || !Number.isFinite(periodEnd.getTime()) || periodEnd.getTime() <= periodStart.getTime() || count < 1 || count > 200) return fail(res, 400, 'Проверьте период и количество турниров', 'invalid_schedule');
      const schedule = { id: id('sch'), name: String(b.name || template.name).trim().slice(0, 60), templateId: template.id, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), count, revision: 1, createdAt: nowIso(), generatedTournamentIds: [] };
      for (const at of scheduleSlots(periodStart, periodEnd, count)) {
        const tournament = createTournamentFromTemplate(template, at, { scheduleId: schedule.id, scheduleRevision: 1 });
        schedule.generatedTournamentIds.push(tournament.id);
      }
      db.schedules.push(schedule);
      saveDb();
      return json(res, 201, { schedule: publicSchedule(schedule), tournaments: schedule.generatedTournamentIds.map(tid => publicTournament(db.tournaments.find(t => t.id === tid), admin.id)) });
    }
    const scheduleMatch = url.pathname.match(/^\/api\/admin\/schedules\/([^/]+)$/);
    if (method === 'PUT' && scheduleMatch) {
      let b; try { b = await readJson(req); } catch { return fail(res, 400, 'Некорректный JSON'); }
      const schedule = db.schedules.find(x => x.id === scheduleMatch[1]);
      if (!schedule) return fail(res, 404, 'Расписание не найдено');
      const template = db.templates.find(x => x.id === b.templateId && x.active);
      if (!template) return fail(res, 404, 'Активный шаблон не найден');
      const periodStart = new Date(b.periodStart);
      const periodEnd = new Date(b.periodEnd);
      const count = safeInt(b.count);
      const name = String(b.name || template.name).trim().slice(0, 60);
      if (!name || !Number.isFinite(periodStart.getTime()) || !Number.isFinite(periodEnd.getTime()) || periodEnd.getTime() <= periodStart.getTime() || count < 1 || count > 200) return fail(res, 400, 'Проверьте период и количество турниров', 'invalid_schedule');
      try {
        const changed = regenerateSchedule(schedule, template, { name, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), count });
        saveDb();
        return json(res, 200, { schedule: publicSchedule(schedule), regenerated: changed.created.length, preserved: changed.protectedTournaments.length, removed: changed.removedCount });
      } catch (e) {
        if (e.code === 'schedule_committed_count' || e.code === 'schedule_committed_period') return fail(res, 409, e.message, e.code);
        throw e;
      }
    }
    if (method === 'POST' && url.pathname === '/api/admin/tournaments') {
      let b; try { b = await readJson(req); } catch { return fail(res, 400, 'Некорректный JSON'); }
      const template = db.templates.find(x => x.id === b.templateId && x.active);
      if (!template) return fail(res, 404, 'Шаблон не найден');
      const startAt = new Date(b.startAt);
      if (!Number.isFinite(startAt.getTime())) return fail(res, 400, 'Некорректное время старта');
      const t = createTournamentFromTemplate(template, startAt); saveDb(); return json(res, 201, { tournament: publicTournament(t, admin.id) });
    }
    const adminTournamentMatch = url.pathname.match(/^\/api\/admin\/tournaments\/([^/]+)$/);
    if (method === 'GET' && adminTournamentMatch) {
      const t = db.tournaments.find(x => x.id === adminTournamentMatch[1]);
      if (!t) return fail(res, 404, 'Турнир не найден');
      return json(res, 200, { tournament: adminTournamentDetails(t) });
    }
    const cancelMatch = url.pathname.match(/^\/api\/admin\/tournaments\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancelMatch) {
      const t = db.tournaments.find(x => x.id === cancelMatch[1]); if (!t) return fail(res, 404, 'Турнир не найден');
      if (!cancelTournament(t, 'admin')) return fail(res, 409, 'Можно отменить только турнир, ожидающий старта');
      return json(res, 200, { tournament: publicTournament(t, admin.id) });
    }
  }

  return fail(res, 404, 'API endpoint не найден', 'not_found');
}

function serveStatic(req, res, url) {
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  if (filePath === '/admin') filePath = '/admin.html';
  filePath = path.normalize(filePath).replace(/^([.][.][/\\])+/, '');
  const full = path.join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found');
  }
  const ext = path.extname(full).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

loadDb();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) fail(res, 500, 'Внутренняя ошибка сервера', 'server_error'); else res.end();
  }
});
server.listen(PORT, () => console.log(`ЧСЛ запущено: http://localhost:${PORT}`));
