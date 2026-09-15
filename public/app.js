const state = {
  user: null,
  authMode: 'login',
  scope: 'active',
  tournaments: [],
  openTournamentId: null,
  stream: null,
  serverOffset: 0,
  renderTimer: null,
  clockSyncTimer: null,
  streamFallbackTimer: null,
  finalResultTimer: null
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const api = async (url, options = {}) => {
  const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || 'Ошибка запроса'), { status: res.status, data });
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const coins = (n) => `${Math.trunc(Number(n || 0)).toLocaleString('ru-RU')} Gold Coins`;
const dateTime = (iso) => new Intl.DateTimeFormat('ru-RU', { day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit' }).format(new Date(iso));
const statusLabel = (t) => t?.startPending ? 'Запускается' : ({ waiting:'Ожидает старта', in_progress:'В процессе', finished:'Закончился', canceled:'Не состоялся' }[t?.status] || t?.status || '');
const serverNow = () => Date.now() + state.serverOffset;

async function syncServerClock(samples = 3) {
  const offsets = [];
  for (let i = 0; i < samples; i++) {
    const before = Date.now();
    try {
      const data = await api('/api/time');
      const after = Date.now();
      const midpoint = before + (after - before) / 2;
      offsets.push(data.serverTime - midpoint);
    } catch {}
  }
  if (offsets.length) {
    offsets.sort((a,b)=>a-b);
    state.serverOffset = offsets[Math.floor(offsets.length / 2)];
  }
}

function avatarSvg(id) {
  id = Math.max(1, Number(id) || 1);
  const skin = ['#ffd0ad','#eeb28c','#d98d65','#a95e42','#7c422e'][id % 5];
  const hair = `hsl(${(id * 61) % 360} 52% ${26 + (id % 3) * 7}%)`;
  const shirt = `hsl(${(id * 43 + 80) % 360} 72% 48%)`;
  const bg1 = `hsl(${(id * 47) % 360} 78% 56%)`;
  const bg2 = `hsl(${(id * 47 + 72) % 360} 70% 28%)`;
  const hairVariant = id % 4;
  const accessory = id % 6;
  const hairPath = [
    '<path d="M18 33c1-18 39-22 44 1-8-6-15-8-23-7-9 0-14 2-21 6Z"/>',
    '<path d="M16 34c2-18 12-24 25-24 16 0 24 8 25 25-8-7-18-10-27-9-8 0-16 3-23 8Z"/><path d="M18 27 10 18l15 3 4-13 9 11 12-12 3 14 16-4-9 13Z"/>',
    '<path d="M16 36c0-19 11-28 25-28 18 0 26 10 25 30-6-9-13-13-23-14-10-1-19 3-27 12Z"/><circle cx="60" cy="17" r="10"/>',
    '<path d="M15 34c4-20 12-26 25-26 14 0 21 7 25 25-7-5-12-8-18-9l-4 8-5-8c-8 1-15 4-23 10Z"/>'
  ][hairVariant];
  const accessorySvg = [
    '',
    '<path d="M25 41h13M45 41h13" stroke="#181526" stroke-width="3"/><path d="M38 41h7" stroke="#181526" stroke-width="2"/>',
    '<path d="M22 31 12 24l13-2M58 31l10-8-13-1" fill="none" stroke="#ffd94a" stroke-width="3"/>',
    '<circle cx="20" cy="43" r="4" fill="#6ff"/><circle cx="62" cy="43" r="4" fill="#6ff"/>',
    '<path d="M31 53c7 5 14 5 21 0" stroke="#8e2d4e" stroke-width="2.5" fill="none"/>',
    '<path d="M27 17c7-8 23-8 30 0" stroke="#ffd94a" stroke-width="4" fill="none"/><circle cx="42" cy="10" r="4" fill="#ff4ba8"/>'
  ][accessory];
  return `<svg viewBox="0 0 82 82" aria-hidden="true"><defs><linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs><rect width="82" height="82" rx="20" fill="url(#g${id})"/><circle cx="41" cy="42" r="23" fill="${skin}"/><g fill="${hair}">${hairPath}</g><ellipse cx="33" cy="42" rx="2.4" ry="3.2" fill="#191525"/><ellipse cx="50" cy="42" rx="2.4" ry="3.2" fill="#191525"/><path d="M35 54c4 3 9 3 13 0" stroke="#8e4c58" stroke-width="2.5" fill="none" stroke-linecap="round"/>${accessorySvg}<path d="M18 82c2-18 12-24 23-24s22 6 24 24Z" fill="${shirt}"/><path d="M34 60l7 10 8-10" fill="none" stroke="rgba(255,255,255,.65)" stroke-width="3"/></svg>`;
}
function avatarHtml(p, cls = '') {
  const id = Math.max(1, Number(p.avatarId || 1));
  const base = ((id - 1) % 9) + 1;
  const hue = (Math.floor((id - 1) / 9) * 34) % 360;
  return `<div class="avatar-face ${cls}" data-avatar-id="${id}" style="--avatar-hue:${hue}deg"><img class="avatar-art" src="/assets/avatar-${base}.png" alt="" /></div>`;
}

function hashText(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function previewParticipant(t, s, slotIndex) {
  const participants = Array.isArray(t.participants) && t.participants.length ? t.participants : [{ username:'—', avatarId:1 }];
  const tick = Math.max(0, Math.floor((serverNow() - Number(s.serverStartsAt || serverNow())) / 220));
  const idx = hashText(`${t.id}:${s.id}:${slotIndex}:${tick}`) % participants.length;
  return participants[idx];
}

function reelCard(p, extra = '') {
  return `<div class="avatar-card reel-card ${extra}">${avatarHtml(p)}<div class="avatar-name">${esc(p.username)}</div></div>`;
}
function reelSequence(t, s, col, winners = null) {
  const pool = Array.isArray(t.participants) && t.participants.length ? t.participants : [{ username:'—', avatarId:1 }];
  const filler = Array.from({ length:9 }, (_, i) => pool[hashText(`${t.id}:${s.id}:${col}:${i}`) % pool.length]);
  const items = winners ? [...filler, ...winners] : [...filler, ...filler];
  return `<div class="reel-window"><div class="reel-strip ${winners?'is-stopping':'is-running'}" style="--reel:${col}">${items.map(p=>reelCard(p)).join('')}</div></div>`;
}

async function bootstrap() {
  bindUi();
  await syncServerClock();
  const data = await api('/api/me');
  state.serverOffset = data.serverTime - Date.now();
  clearInterval(state.clockSyncTimer);
  state.clockSyncTimer = setInterval(() => syncServerClock().catch(()=>{}), 30000);
  if (data.user) {
    state.user = data.user;
    showApp();
    await loadTournaments();
  } else {
    showAuth();
  }
}

function bindUi() {
  $$('.auth-tabs button').forEach(b => b.addEventListener('click', () => setAuthMode(b.dataset.auth)));
  $('#authForm').addEventListener('submit', submitAuth);
  $('#userMenuBtn').addEventListener('click', () => $('#userDropdown').classList.toggle('hidden'));
  $('#logoutBtn').addEventListener('click', logout);
  $$('.tab').forEach(b => b.addEventListener('click', async () => { state.scope = b.dataset.scope; $$('.tab').forEach(x => x.classList.toggle('active', x === b)); await loadTournaments(); }));
  $('#rulesBtn').addEventListener('click', showRules);
  $('#heroDetailsBtn').addEventListener('click', showRules);
  $('#genericModal').addEventListener('click', e => { if (e.target.id === 'genericModal') closeGeneric(); });
  $('#closeTournament').addEventListener('click', closeTournament);
  $('#tournamentOverlay').addEventListener('click', e => { if (e.target.id === 'tournamentOverlay') closeTournament(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.openTournamentId) refreshOpenTournament().catch(()=>{}); });
  window.addEventListener('online', () => { if (state.openTournamentId) refreshOpenTournament().catch(()=>{}); });
}

function setAuthMode(mode) {
  state.authMode = mode;
  $$('.auth-tabs button').forEach(b => b.classList.toggle('active', b.dataset.auth === mode));
  $('#authSubmit').textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
  $('#authError').classList.add('hidden');
}
function showAuth() { $('#authOverlay').classList.remove('hidden'); $('#mainContent').classList.add('hidden'); $('#userBar').classList.add('hidden'); }
function showApp() {
  $('#authOverlay').classList.add('hidden'); $('#mainContent').classList.remove('hidden'); $('#userBar').classList.remove('hidden');
  renderUser();
}
function renderUser() {
  if (!state.user) return;
  $('#balanceValue').textContent = Math.trunc(state.user.available).toLocaleString('ru-RU');
  $('#usernameValue').textContent = state.user.username;
  $('#adminLink').classList.toggle('hidden', !state.user.isAdmin);
}
async function submitAuth(e) {
  e.preventDefault();
  const username = $('#authUsername').value.trim();
  const err = $('#authError'); err.classList.add('hidden');
  try {
    const data = await api(`/api/auth/${state.authMode}`, { method:'POST', body: JSON.stringify({ username }) });
    state.user = data.user; showApp(); await loadTournaments();
  } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
}
async function logout() {
  await api('/api/auth/logout', { method:'POST', body:'{}' });
  state.user = null; state.tournaments = []; closeTournament(); showAuth(); $('#userDropdown').classList.add('hidden');
}

async function loadTournaments() {
  const data = await api(`/api/tournaments?scope=${encodeURIComponent(state.scope)}`);
  state.tournaments = data.tournaments; renderTournamentRows();
}
function renderTournamentRows() {
  const root = $('#tournamentRows');
  root.innerHTML = state.tournaments.map(t => {
    const full = t.participantCount >= t.maxPlayers;
    const canJoin = t.registrationOpen !== false && t.status === 'waiting' && !t.joined && !full;
    let action = '';
    if (canJoin) action = `<button class="btn btn-gradient row-action" data-join="${t.id}">Участвовать</button>`;
    else if (t.status === 'in_progress') action = `<button class="btn btn-gradient row-action" data-open="${t.id}">Смотреть</button>`;
    else if (t.status === 'finished') action = `<button class="btn btn-secondary row-action" data-open="${t.id}">Результаты</button>`;
    else if (t.startPending && t.joined) action = `<button class="btn btn-secondary row-action" data-open="${t.id}">Открыть</button>`;
    else if (t.joined) action = `<button class="btn btn-secondary row-action" data-open="${t.id}">Вы участвуете</button>`;
    else action = `<button class="btn btn-secondary row-action" disabled>${full ? 'Мест нет' : 'Недоступно'}</button>`;
    const soloBadge = t.systemDemoSolo ? '<em class="solo-test-badge">можно одному</em>' : '';
    return `<div class="tournament-row tournament-grid ${t.systemDemoSolo?'solo-test-row':''}">
      <span>#${t.number}${soloBadge}</span><span>${coins(t.fee)}</span><span>${t.participantCount}/${t.maxPlayers}${t.minPlayers===1?' · мин. 1':''}</span><span>${dateTime(t.startAt)}</span>
      <span class="status ${t.status}"><i class="status-dot"></i>${statusLabel(t)}${t.joined ? ' · <em class="join-badge">вы участвуете</em>' : ''}</span>${action}
    </div>`;
  }).join('');
  $('#emptyState').classList.toggle('hidden', state.tournaments.length > 0);
  const testNotice = $('#testModeNotice');
  if (testNotice) testNotice.classList.toggle('hidden', !state.tournaments.some(t => t.systemDemoSolo));
  root.querySelectorAll('[data-join]').forEach(b => b.addEventListener('click', () => confirmJoin(b.dataset.join)));
  root.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openTournament(b.dataset.open)));
}

function showRules() {
  showGeneric(`<h2>Правила турниров</h2><ol class="rules-list">
    <li>Выберите турнир и подтвердите участие. Взнос резервируется сразу после подтверждения.</li>
    <li>Отменить участие самостоятельно нельзя. Если турнир не состоится или будет отменён администратором, резерв полностью возвращается.</li>
    <li>Турнир стартует автоматически в назначенное время и проходит даже без присутствия участников.</li>
    <li>В каждом обычном спине участвует поле 3×3. Сумма каждой горизонтальной линии начисляется каждому из трёх игроков этой линии.</li>
    <li>Один игрок может выпадать несколько раз в одном спине и выигрывать несколько раз за турнир.</li>
    <li>Когда банка не хватает на следующий полный обычный спин, весь остаток разыгрывается одним финальным спином на центральном барабане.</li>
    <li>Все выигрыши автоматически зачисляются на баланс Gold Coins.</li>
  </ol><div class="modal-actions"><button class="btn btn-gradient" data-close-generic>Понятно</button></div>`);
}
function showGeneric(html) {
  $('#genericModalCard').innerHTML = html;
  $('#genericModal').classList.remove('hidden');
  $('#genericModal').setAttribute('aria-hidden','false');
  $('#genericModalCard').querySelectorAll('[data-close-generic]').forEach(b => b.addEventListener('click', closeGeneric));
}
function closeGeneric() { $('#genericModal').classList.add('hidden'); $('#genericModal').setAttribute('aria-hidden','true'); }
function confirmJoin(tid) {
  const t = state.tournaments.find(x => x.id === tid); if (!t) return;
  showGeneric(`<div class="join-confirm">
    <div class="join-visual" aria-hidden="true"><div class="join-rays"></div><div class="join-wheel"><span>SPIN</span></div><i class="join-star join-star-a">★</i><i class="join-star join-star-b">★</i><i class="join-gem"></i></div>
    <div class="join-panel"><button class="join-close" data-close-generic aria-label="Закрыть">×</button><h2>Участие в турнире</h2>
      <p>Будет зарезервирован взнос <b>${coins(t.fee)}</b> за участие в турнире <b>#${t.number}</b>. После согласия отменить участие нельзя. Даже если вы не придёте на турнир, он состоится, а выигрыш автоматически зачислится на баланс.</p>
      <div class="join-fee"><span>Взнос</span><b>${coins(t.fee)}</b></div>
      <div class="modal-actions join-actions"><button class="btn btn-gradient" id="confirmJoinBtn">Участвовать в турнире</button></div>
    </div></div>`);
  $('#confirmJoinBtn').addEventListener('click', async () => {
    const btn = $('#confirmJoinBtn'); btn.disabled = true;
    try {
      const key = crypto.randomUUID();
      const data = await api(`/api/tournaments/${tid}/join`, { method:'POST', headers:{'Idempotency-Key':key}, body:'{}' });
      state.user = data.user || state.user; renderUser(); closeGeneric(); await loadTournaments(); openTournament(tid);
    } catch(e) { btn.disabled = false; showGeneric(`<h2>Не удалось участвовать</h2><p>${esc(e.message)}</p><div class="modal-actions"><button class="btn btn-gradient" data-close-generic>Закрыть</button></div>`); }
  });
}

async function openTournament(tid) {
  state.openTournamentId = tid;
  $('#tournamentOverlay').classList.remove('hidden'); $('#tournamentOverlay').setAttribute('aria-hidden','false');
  if (state.stream) state.stream.close();
  await syncServerClock();
  const data = await api(`/api/tournaments/${tid}`); renderTournamentView(data.tournament);
  state.stream = new EventSource(`/api/tournaments/${tid}/stream`);
  const stopFallback = () => { if (state.streamFallbackTimer) { clearInterval(state.streamFallbackTimer); state.streamFallbackTimer = null; } };
  const startFallback = () => {
    if (state.streamFallbackTimer || !state.openTournamentId) return;
    state.streamFallbackTimer = setInterval(() => refreshOpenTournament().catch(()=>{}), 2000);
  };
  const handle = e => { try { const d = JSON.parse(e.data); stopFallback(); if (d.serverTime) { const observed = d.serverTime - Date.now(); state.serverOffset = state.serverOffset * .75 + observed * .25; } if (d.tournament) renderTournamentView(d.tournament); else refreshOpenTournament(); } catch {} };
  state.stream.addEventListener('open', stopFallback);
  state.stream.addEventListener('error', startFallback);
  state.stream.addEventListener('tick', handle);
  ['started','finished','canceled','participant_joined','spin_settled'].forEach(name => state.stream.addEventListener(name, handle));
  clearInterval(state.renderTimer); state.renderTimer = setInterval(() => updateLocalTimers(), 200);
}
async function refreshOpenTournament() {
  if (!state.openTournamentId) return;
  const data = await api(`/api/tournaments/${state.openTournamentId}`); renderTournamentView(data.tournament);
  const me = await api('/api/me'); state.user = me.user; renderUser();
}
function closeTournament() {
  state.openTournamentId = null;
  if (state.stream) { state.stream.close(); state.stream = null; }
  clearInterval(state.renderTimer); state.renderTimer = null;
  if (state.streamFallbackTimer) { clearInterval(state.streamFallbackTimer); state.streamFallbackTimer = null; }
  if (state.finalResultTimer) { clearTimeout(state.finalResultTimer); state.finalResultTimer = null; }
  $('#tournamentOverlay').classList.add('hidden'); $('#tournamentOverlay').setAttribute('aria-hidden','true');
  if (state.user) loadTournaments().catch(()=>{});
}
function updateLocalTimers() {
  const el = $('[data-countdown-at]');
  if (el) {
    const ms = Math.max(0, Number(el.dataset.countdownAt) - serverNow());
    el.textContent = formatCountdown(ms);
  }
  const spin = $('[data-spin-end]');
  if (spin) {
    const ms = Math.max(0, Number(spin.dataset.spinEnd) - serverNow());
    spin.textContent = formatShort(ms);
  }
}
const formatCountdown = ms => { const s=Math.ceil(ms/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60), x=s%60; return h>0?`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(x).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(x).padStart(2,'0')}`; };
const formatShort = ms => `00:${String(Math.max(0,Math.ceil(ms/1000))).padStart(2,'0')}`;

function renderTournamentView(t) {
  if (state.openTournamentId !== t.id) return;
  const root = $('#tournamentView');
  if (t.status === 'waiting') return renderWaiting(root, t);
  if (t.status === 'in_progress') return renderLive(root, t);
  if (t.status === 'finished') {
    if (t.finalResult && root.dataset.visualKind === 'final-spin') return renderFinalLanding(root, t);
    return renderResults(root, t);
  }
  if (t.status === 'canceled') return renderCanceled(root, t);
}
function renderWaiting(root,t) {
  if (t.startPending) {
    root.innerHTML = `<div class="tournament-view"><div class="tour-title">Турнир #${t.number}</div>
      <div class="waiting-view"><div class="join-badge">${t.joined?'Вы участвуете':'Просмотр турнира'}</div><h2>Турнир запускается</h2>
      <div class="starting-pulse" aria-hidden="true"></div><p>Регистрация уже закрыта. Сервер фиксирует старт и синхронизирует первый спин для всех зрителей.</p>
      <p>${t.participantCount} из ${t.maxPlayers} участников · взнос ${coins(t.fee)}</p></div></div>`;
    return;
  }
  root.innerHTML = `<div class="tournament-view"><div class="tour-title">Турнир #${t.number}</div>
    <div class="waiting-view"><div class="join-badge">${t.joined?'Вы участвуете':'Просмотр турнира'}</div><h2>До начала турнира</h2>
    <div class="countdown" data-countdown-at="${new Date(t.startAt).getTime()}">${formatCountdown(new Date(t.startAt).getTime()-serverNow())}</div>
    <p>${t.participantCount} из ${t.maxPlayers} участников · взнос ${coins(t.fee)}</p><p>Турнир запустится автоматически.</p></div></div>`;
}
function statsHtml(t) {
  const me = t.participants.find(p=>p.userId===state.user?.id);
  return `<div class="stats-panel">
    <div class="player-summary"><div class="player-identity">${me?avatarHtml(me,'mini-avatar'):''}<span><small class="muted">${me?'Ваш выигрыш за турнир':'Турнир'}</small><br><b>${me?`${esc(me.username)} · ${coins(t.myWinnings)}`:`#${t.number}`}</b></span></div><span>Игроки: <b>${t.participantCount}</b> &nbsp; Взнос: <b>${coins(t.fee)}</b></span></div>
    <div class="stats-main"><div class="stat-box"><small>Общий банк</small><strong>${coins(t.prizeBank)}</strong></div><div class="stat-box"><small>Разыграно</small><strong>${coins(t.awarded)}</strong></div><div class="stat-box"><small>Осталось</small><strong>${coins(t.remaining)}</strong></div></div>
  </div>`;
}
function spinPhaseText(s) {
  if (s.kind === 'final') return 'Финальный спин';
  if (s.phase === 'result') return 'Результат';
  if (s.phase === 'pause') return 'Следующий спин';
  return 'Крутится';
}
function phaseRemaining(s) {
  return Math.max(0, Number(s.phaseRemainingMs ?? s.remainingMs ?? 0));
}
function phaseEndTimestamp(s) {
  return Number(s.serverPhaseEndsAt || (serverNow() + phaseRemaining(s)));
}
function renderLive(root,t) {
  const s = t.currentSpin;
  if (!s) { root.innerHTML=`<div class="tournament-view"><div class="tour-title">Турнир #${t.number}</div>${statsHtml(t)}<p class="tournament-note">Подготовка следующего спина…</p></div>`; return; }
  if (s.kind === 'final') return renderFinal(root,t,s);
  const visualKey = `${s.id}:${s.phase === 'spin' ? 'spin' : 'settled'}`;
  if (root.dataset.visualKey === visualKey) return;
  const left = phaseRemaining(s);
  const columns = [0,1,2].map(col => {
    const winners = s.phase === 'spin' ? null : [0,1,2].map(row => s.rows[row].winners[col]);
    return reelSequence(t, s, col, winners);
  }).join('');
  root.innerHTML = `<div class="tournament-view"><div class="tour-title">Турнир #${t.number}</div>${statsHtml(t)}
    <div class="reel-area"><div class="payout-column">${s.rows.map(r=>`<div class="payout-label">${coins(r.amount).replace(' Gold Coins',' GC')}</div>`).join('')}</div>
      <div class="reels reel-machine ${s.phase!=='spin'?'show-result':''}">${columns}</div>
    </div>
    <div class="spin-footer phase-${esc(s.phase||'spin')}"><small>${spinPhaseText(s)}</small><b data-spin-end="${phaseEndTimestamp(s)}">${formatShort(left)}</b></div></div>`;
  root.dataset.visualKey = visualKey;
  root.dataset.visualKind = 'ordinary';
}
function renderFinal(root,t,s) {
  const visualKey = `${s.id}:final-spin`;
  if (root.dataset.visualKey === visualKey) return;
  const left = phaseRemaining(s);
  const placeholders = '<div class="final-placeholder"></div>'.repeat(3);
  root.innerHTML=`<div class="tournament-view final-tournament-view"><div class="tour-title">Турнир #${t.number} · Финальный розыгрыш</div>${statsHtml(t)}
    <div class="final-stage final-stage-figma is-spinning">
      <div class="final-side-column" aria-hidden="true">${placeholders}</div>
      <div class="final-center-column">
        <div class="final-prize-line"><small>Остаток</small><strong>${coins(s.totalPayout)}</strong></div>
        <div class="final-reel-window">${reelSequence(t,s,1).replace('reel-window','reel-window final-running-reel')}</div>
      </div>
      <div class="final-side-column" aria-hidden="true">${placeholders}</div>
    </div>
    <div class="final-caption">Определяем победителя финального розыгрыша</div>
    <div class="spin-footer phase-final"><small>Финальный спин</small><b data-spin-end="${phaseEndTimestamp(s)}">${formatShort(left)}</b></div></div>`;
  root.dataset.visualKey = visualKey;
  root.dataset.visualKind = 'final-spin';
}
function renderFinalLanding(root,t) {
  const s = t.finalResult;
  const placeholders = '<div class="final-placeholder"></div>'.repeat(3);
  root.innerHTML=`<div class="tournament-view final-tournament-view"><div class="tour-title">Турнир #${t.number} · Финальный розыгрыш</div>${statsHtml(t)}
    <div class="final-stage final-stage-figma is-revealed"><div class="final-side-column" aria-hidden="true">${placeholders}</div><div class="final-center-column">
      <div class="final-prize-line"><small>Остаток</small><strong>${coins(s.totalPayout)}</strong></div>
      <div class="final-reel-window final-landing-reel">${reelSequence(t,s,1,s.candidates).replace('reel-window','reel-window final-result-window')}</div>
    </div><div class="final-side-column" aria-hidden="true">${placeholders}</div></div>
    <div class="final-caption">Весь остаток получает центральный игрок</div><div class="spin-footer phase-final is-complete"><small>Результат</small><b>00:02</b></div></div>`;
  root.dataset.visualKind = 'final-result';
  state.finalResultTimer = setTimeout(() => { state.finalResultTimer = null; if (state.openTournamentId === t.id) renderResults(root,t); }, 2600);
}
function renderResults(root,t) {
  const rows=t.results||[];
  root.innerHTML=`<div class="result-board"><div class="tour-title result-tour-title">Турнир #${t.number}</div>
    <div class="result-content"><h2>Турнирная таблица № ${t.number}</h2>
      <div class="result-head"><span>Пользователь</span><span>Выигрыш</span></div>
      <div class="result-table">${rows.map(r=>`<div class="result-row ${r.userId===state.user?.id?'is-me':''}"><div class="result-user"><b>${esc(r.username)}</b></div><div class="result-win">${coins(r.winnings)}</div></div>`).join('')}</div>
      <p class="result-footnote">В таблице показаны все участники, включая игроков с нулевым выигрышем.</p>
    </div></div>`;
}
function renderCanceled(root,t) {
  root.innerHTML=`<div class="tournament-view"><div class="tour-title">Турнир #${t.number}</div><div class="waiting-view"><h2>Турнир не состоялся</h2><p>${t.cancelReason==='minimum_not_reached'?'Не набрано минимальное количество участников.':'Турнир отменён администратором.'}</p><p>Зарезервированные Gold Coins возвращены участникам.</p></div></div>`;
}

bootstrap().catch(e => { console.error(e); alert(`Ошибка запуска: ${e.message}`); });
