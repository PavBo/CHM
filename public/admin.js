const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const api=async(url,o={})=>{const r=await fetch(url,{...o,headers:{'Content-Type':'application/json',...(o.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||'Ошибка');return d};
const dt=iso=>iso?new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short'}).format(new Date(iso)):'—';
const gc=n=>`${Math.trunc(Number(n||0)).toLocaleString('ru-RU')} GC`;
let templates=[];
let schedules=[];
let editingScheduleId=null;

async function init(){
  const me=await api('/api/me');
  if(!me.user?.isAdmin){location.href='/';return;}
  $('#adminUser').textContent=`Admin: ${me.user.username}`;
  setDefaultDates();bind();await loadAll();
}
function localValue(d){return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)}
function setDefaultDates(){
  const d=new Date(Date.now()+10*60*1000);d.setMinutes(Math.ceil(d.getMinutes()/5)*5,0,0);$('#startAt').value=localValue(d);
  const ps=new Date(Date.now()+30*60*1000);ps.setMinutes(Math.ceil(ps.getMinutes()/5)*5,0,0);const pe=new Date(ps.getTime()+4*60*60*1000);$('#periodStart').value=localValue(ps);$('#periodEnd').value=localValue(pe);
}
function bind(){
  $('#templateForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const body=Object.fromEntries(f);body.fee=+body.fee;body.minPlayers=+body.minPlayers;body.maxPlayers=+body.maxPlayers;body.commissionPercent=+body.commissionPercent;body.rowPayouts=String(body.rowPayouts).split(',').map(x=>+x.trim());try{await api('/api/admin/templates',{method:'POST',body:JSON.stringify(body)});msg('#templateMsg','Шаблон создан',true);e.currentTarget.reset();await loadTemplates();}catch(e){msg('#templateMsg',e.message,false)}});
  $('#scheduleForm').addEventListener('submit',saveSchedule);
  $('#cancelScheduleEdit').addEventListener('click',resetScheduleForm);
  $('#createSoloTestSchedule').addEventListener('click',createSoloTestSchedule);
  $('#tournamentForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const body={templateId:f.get('templateId'),startAt:new Date(f.get('startAt')).toISOString()};try{await api('/api/admin/tournaments',{method:'POST',body:JSON.stringify(body)});msg('#tournamentMsg','Турнир создан',true);setDefaultDates();await loadAll()}catch(e){msg('#tournamentMsg',e.message,false)}});
  $('#reloadAdmin').addEventListener('click',loadAll);
  $('#runAudit').addEventListener('click',loadDashboard);
  $('#adminDetailModal').addEventListener('click',e=>{if(e.target.id==='adminDetailModal')closeDetail()});
  $('#closeAdminDetail').addEventListener('click',closeDetail);
}
function msg(sel,text,ok){const el=$(sel);el.className=ok?'ok':'bad';el.textContent=text;}
async function loadAll(){await loadTemplates();await Promise.all([loadDashboard(),loadSchedules(),loadTournaments()]);}

async function loadDashboard(){
  const d=await api('/api/admin/dashboard');
  const cards=[
    ['Пользователи',d.users.registered],
    ['Активные турниры',d.tournaments.waiting+d.tournaments.in_progress],
    ['Комиссия платформы',gc(d.economy.earnedCommission)],
    ['Зарезервировано',gc(d.balances.reserved)]
  ];
  $('#dashboardCards').innerHTML=cards.map(([label,value])=>`<div class="admin-metric"><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`).join('');
  $('#auditState').innerHTML=d.audit.ok?'<span class="audit-ok">Целостность данных: нарушений не найдено</span>':`<span class="audit-bad">Обнаружено проблем: ${d.audit.issues.length}</span><ul>${d.audit.issues.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`;
}
async function loadTemplates(){
  const d=await api('/api/admin/templates');templates=d.templates;
  const opts=templates.filter(x=>x.active).map(t=>`<option value="${t.id}">${esc(t.name)} — ${t.fee} GC / ${t.commissionPercent}%</option>`).join('');
  $('#templateSelect').innerHTML=opts;$('#scheduleTemplateSelect').innerHTML=opts;renderTemplateList();
  const disabled=!opts;$('#templateSelect').disabled=disabled;$('#scheduleTemplateSelect').disabled=disabled;
}
function renderTemplateList(){
  const root=$('#templateList');
  root.innerHTML=templates.map(t=>`<form class="template-edit ${t.active?'':'template-inactive'}" data-template="${t.id}">
    <label>Название<input name="name" value="${esc(t.name)}"></label>
    <label>Взнос<input name="fee" type="number" min="1" value="${t.fee}"></label>
    <label>Мин.<input name="minPlayers" type="number" min="1" value="${t.minPlayers}"></label>
    <label>Макс.<input name="maxPlayers" type="number" min="1" max="96" value="${t.maxPlayers}"></label>
    <label>Комиссия %<input name="commissionPercent" type="number" min="0" max="100" value="${t.commissionPercent}"></label>
    <label>Линии<input name="rowPayouts" value="${t.rowPayouts.join(',')}"></label>
    <label class="template-active"><span>Активен</span><input name="active" type="checkbox" ${t.active?'checked':''}></label>
    <button class="btn btn-secondary" type="submit">Сохранить</button>
  </form>`).join('');
  root.querySelectorAll('[data-template]').forEach(form=>form.addEventListener('submit',saveTemplate));
}
async function saveTemplate(e){
  e.preventDefault();const form=e.currentTarget;const f=new FormData(form);
  const body={name:f.get('name'),fee:+f.get('fee'),minPlayers:+f.get('minPlayers'),maxPlayers:+f.get('maxPlayers'),commissionPercent:+f.get('commissionPercent'),rowPayouts:String(f.get('rowPayouts')).split(',').map(x=>+x.trim()),active:form.elements.active.checked};
  const btn=form.querySelector('button');btn.disabled=true;
  try{await api(`/api/admin/templates/${form.dataset.template}`,{method:'PUT',body:JSON.stringify(body)});btn.textContent='Сохранено';setTimeout(()=>btn.textContent='Сохранить',1000);await Promise.all([loadTemplates(),loadDashboard()])}catch(e){alert(e.message)}finally{btn.disabled=false}
}
async function loadSchedules(){
  const d=await api('/api/admin/schedules'); schedules=d.schedules;
  $('#scheduleList').innerHTML=schedules.slice().reverse().map(s=>{const t=templates.find(x=>x.id===s.templateId);return `<div class="schedule-row">
    <b>${esc(s.name)}</b><span>${esc(t?.name||s.templateId)}</span><span>${dt(s.periodStart)} — ${dt(s.periodEnd)}</span>
    <span><b>${s.count}</b> турниров · ревизия ${s.revision||1}<br><small>зафиксировано: ${s.protectedCount||0}, можно пересоздать: ${s.editableFutureCount||0}</small></span>
    <button class="btn btn-secondary" data-edit-schedule="${s.id}">Редактировать</button></div>`}).join('')||'<p class="muted">Периоды ещё не настроены.</p>';
  document.querySelectorAll('[data-edit-schedule]').forEach(b=>b.addEventListener('click',()=>editSchedule(b.dataset.editSchedule)));
}
function ensureScheduleTemplateOption(templateId){
  const select=$('#scheduleTemplateSelect');
  if([...select.options].some(o=>o.value===templateId)) return;
  const t=templates.find(x=>x.id===templateId); if(!t) return;
  const o=document.createElement('option');o.value=t.id;o.textContent=`${t.name} — неактивен`;select.appendChild(o);
}
function editSchedule(id){
  const s=schedules.find(x=>x.id===id); if(!s)return;
  editingScheduleId=id;ensureScheduleTemplateOption(s.templateId);
  const form=$('#scheduleForm');form.elements.name.value=s.name;form.elements.templateId.value=s.templateId;form.elements.count.value=s.count;
  form.elements.periodStart.value=localValue(new Date(s.periodStart));form.elements.periodEnd.value=localValue(new Date(s.periodEnd));
  $('#scheduleSubmit').textContent='Сохранить расписание';$('#cancelScheduleEdit').classList.remove('hidden');
  msg('#scheduleMsg','Редактируется всё расписание целиком. Отдельные сгенерированные турниры вручную не изменяются.',true);
  form.scrollIntoView({behavior:'smooth',block:'center'});
}
function resetScheduleForm(){
  editingScheduleId=null;const form=$('#scheduleForm');form.reset();setDefaultDates();
  $('#scheduleSubmit').textContent='Создать расписание';$('#cancelScheduleEdit').classList.add('hidden');$('#scheduleMsg').textContent='';
  loadTemplates().catch(()=>{});
}
async function saveSchedule(e){
  e.preventDefault();const f=new FormData(e.currentTarget);const body={name:f.get('name'),templateId:f.get('templateId'),count:+f.get('count'),periodStart:new Date(f.get('periodStart')).toISOString(),periodEnd:new Date(f.get('periodEnd')).toISOString()};
  try{
    if(editingScheduleId){const d=await api(`/api/admin/schedules/${editingScheduleId}`,{method:'PUT',body:JSON.stringify(body)});msg('#scheduleMsg',`Расписание обновлено. Пересоздано: ${d.regenerated}; сохранено без изменений: ${d.preserved}.`,true);editingScheduleId=null;$('#scheduleSubmit').textContent='Создать расписание';$('#cancelScheduleEdit').classList.add('hidden');}
    else{const d=await api('/api/admin/schedules',{method:'POST',body:JSON.stringify(body)});msg('#scheduleMsg',`Период создан. Сгенерировано турниров: ${d.tournaments.length}`,true);}
    await loadAll();
  }catch(e){msg('#scheduleMsg',e.message,false)}
}

async function createSoloTestSchedule(){
  const btn=$('#createSoloTestSchedule');
  btn.disabled=true; const old=btn.textContent; btn.textContent='Создаём…';
  try{
    const d=await api('/api/admin/test-schedule',{method:'POST',body:'{}'});
    msg('#scheduleMsg',`Тестовый период создан: ${d.tournaments.length} турнир(ов), каждые ${d.intervalMinutes} мин., на ${d.durationMinutes} мин. Взнос 10 GC, минимум 1 игрок.`,true);
    await loadAll();
  }catch(e){msg('#scheduleMsg',e.message,false)}
  finally{btn.disabled=false;btn.textContent=old}
}

async function loadTournaments(){
  const scopes=await Promise.all(['active','past'].map(s=>api(`/api/tournaments?scope=${s}`)));
  const list=[...scopes[0].tournaments,...scopes[1].tournaments].sort((a,b)=>new Date(b.startAt)-new Date(a.startAt)).slice(0,60);
  $('#adminTournaments').innerHTML=list.map(t=>`<div class="admin-row">
    <button class="admin-tour-link" data-detail="${t.id}">#${t.number}</button>
    <span>${dt(t.startAt)}<br><small>${statusRu(t)}</small></span>
    <span>${t.participantCount}/${t.maxPlayers} игроков</span>
    <span>${t.fee} GC · ${t.commissionPercent}%</span>
    ${t.status==='waiting'?`<button class="btn btn-secondary" data-cancel="${t.id}">Отменить</button>`:'<button class="btn btn-secondary" data-detail="'+t.id+'">Подробнее</button>'}
  </div>`).join('')||'<p class="muted">Турниров пока нет.</p>';
  document.querySelectorAll('[data-detail]').forEach(b=>b.addEventListener('click',()=>openDetail(b.dataset.detail)));
  document.querySelectorAll('[data-cancel]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('Отменить турнир и вернуть все зарезервированные средства?'))return;try{await api(`/api/admin/tournaments/${b.dataset.cancel}/cancel`,{method:'POST',body:'{}'});await loadAll()}catch(e){alert(e.message)}}));
}
async function openDetail(id){
  const d=await api(`/api/admin/tournaments/${id}`);const t=d.tournament;
  const participants=t.participants.map(p=>`<div class="detail-participant"><span>${esc(p.username)}</span><span>аватар ${p.avatarId}</span><b>${gc(p.winnings)}</b></div>`).join('')||'<p class="muted">Участников нет.</p>';
  $('#adminDetailBody').innerHTML=`<div class="detail-head"><div><small>Турнир</small><h2>#${t.number}</h2></div><span class="detail-status">${statusRu(t)}</span></div>
    <div class="detail-grid"><div><small>Шаблон</small><b>${esc(t.templateName||t.templateId)}</b></div><div><small>Старт</small><b>${dt(t.startAt)}</b></div><div><small>Взнос</small><b>${gc(t.fee)}</b></div><div><small>Комиссия</small><b>${t.commissionPercent}% / ${gc(t.commission)}</b></div><div><small>Призовой банк</small><b>${gc(t.prizeBank)}</b></div><div><small>Разыграно</small><b>${gc(t.awarded)}</b></div><div><small>Стоимость спина</small><b>${gc(t.ordinarySpinCost)}</b></div><div><small>Спины</small><b>${t.processedSpinCount}/${t.spinCount}</b></div></div>
    <h3>Участники (${t.participantCount})</h3><div class="detail-participants">${participants}</div>`;
  $('#adminDetailModal').classList.remove('hidden');
}
function closeDetail(){$('#adminDetailModal').classList.add('hidden')}
function statusRu(t){if(typeof t==='string')return({waiting:'Ожидает старта',in_progress:'В процессе',finished:'Закончился',canceled:'Не состоялся'})[t]||t;return t?.startPending?'Запускается':(({waiting:'Ожидает старта',in_progress:'В процессе',finished:'Закончился',canceled:'Не состоялся'})[t?.status]||t?.status||'')}
init().catch(e=>{alert(e.message);location.href='/'});
