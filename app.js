// Simplí Solutions Pipeline Portal - app logic
// Config tokens below are replaced at build time by build.js from env vars.
const SUPABASE_URL = '__SUPABASE_URL__';
const SUPABASE_ANON_KEY = '__SUPABASE_ANON_KEY__';
const AUTH0_DOMAIN = '__AUTH0_DOMAIN__';
const AUTH0_CLIENT_ID = '__AUTH0_CLIENT_ID__';

const STAGES = ['Awaiting PO', 'Verbal Confirmed', 'Negotiation', 'Survey', 'Quote'];
const STAGE_PROB = { 'Awaiting PO': 85, 'Verbal Confirmed': 70, 'Negotiation': 50, 'Survey': 30, 'Quote': 20 };
const STAGE_STYLE = {
  'Awaiting PO': { bg: 'var(--green-bg)', fg: 'var(--green)' },
  'Verbal Confirmed': { bg: 'var(--sf-blue-light)', fg: 'var(--sf-blue)' },
  'Negotiation': { bg: 'var(--amber-bg)', fg: 'var(--amber)' },
  'Survey': { bg: 'var(--bg)', fg: 'var(--fg3)' },
  'Quote': { bg: 'var(--bg)', fg: 'var(--fg3)' },
};
const PLAN_PRICE = { Starter: '€99 / month', Growth: '€299 / month', Scale: '€599 / month' };
const OWNER_PALETTE = ['#0176D3', '#6B3FA0', '#0891B2', '#DD7A01', '#2E844A', '#BA0517', '#1D4ED8', '#9333EA'];
const COMMENT_TYPE_CLASS = { Call: 'ac', Email: 'ae', Note: 'an', Alert: 'as' };

let auth0Client = null;
let supabase = null;
let currentUser = null;
let CURRENT_CLIENT_ID = null;

let DEALS = [];
let TASKS = [];
let DEALS_BY_ID = {};

let activeDealId = null;
let activityType = 'Call';
let ownerFilter = '';
let attentionOnly = false;
let searchQuery = '';
let pipelineView = 'kanban';
let dragDealId = null;
let assistantHistory = [];

// ---------- helpers ----------

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtEUR(v) {
  v = Number(v) || 0;
  if (Math.abs(v) >= 1000000) return '€' + (v / 1000000).toFixed(2) + 'M';
  if (Math.abs(v) >= 1000) return '€' + (v / 1000).toFixed(1) + 'k';
  return '€' + Math.round(v).toLocaleString('en-IE');
}

function fmtEURFull(v) {
  return '€' + Number(v || 0).toLocaleString('en-IE', { maximumFractionDigits: 0 });
}

function fmtDateShort(d) {
  return new Date(d).toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' });
}

function fmtDateTime(d) {
  return new Date(d).toLocaleString('en-IE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function startOfToday() {
  return new Date(new Date().toDateString());
}

function sameMonth(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function monthLabel(d) {
  return d.toLocaleDateString('en-IE', { month: 'short', year: 'numeric' });
}

function monthRangeLabel() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() + 6, 1);
  return `${monthLabel(now)} – ${monthLabel(end)}`;
}

function daysInStage(deal) {
  return Math.floor((Date.now() - new Date(deal.stage_changed_at).getTime()) / 86400000);
}

function ownerColor(name) {
  if (!name) return '#706E6B';
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % OWNER_PALETTE.length;
  return OWNER_PALETTE[h];
}

function ownerInitials(name) {
  if (!name) return '—';
  return name.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}

// ---------- view switching ----------

function sv(id, el) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('.nav-item,.sn-item').forEach((n) => n.classList.remove('active'));
  document.getElementById('view-' + id).classList.add('active');
  if (el) el.classList.add('active');
}

// ---------- auth ----------

async function login() {
  await auth0Client.loginWithRedirect();
}

async function logout() {
  await auth0Client.logout({ logoutParams: { returnTo: window.location.origin } });
}

async function getIdToken() {
  const claims = await auth0Client.getIdTokenClaims();
  return claims ? claims.__raw : null;
}

async function initAuth() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !AUTH0_DOMAIN || !AUTH0_CLIENT_ID) {
    showLoginError(
      'App not configured: Supabase/Auth0 settings are missing. Run "node build.js" with a populated .env file (see .env.example), or set the environment variables in your Vercel project.'
    );
    return;
  }

  auth0Client = await auth0.createAuth0Client({
    domain: AUTH0_DOMAIN,
    clientId: AUTH0_CLIENT_ID,
    authorizationParams: { redirect_uri: window.location.origin },
  });

  if (location.search.includes('code=') && location.search.includes('state=')) {
    try {
      await auth0Client.handleRedirectCallback();
    } catch (err) {
      showLoginError('Login failed: ' + err.message);
    }
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  const authenticated = await auth0Client.isAuthenticated();
  if (!authenticated) {
    return;
  }

  currentUser = await auth0Client.getUser();
  const claims = await auth0Client.getIdTokenClaims();
  CURRENT_CLIENT_ID = claims ? claims.client_id : null;

  if (!CURRENT_CLIENT_ID) {
    showLoginError(
      'Your account is not linked to a client yet. Ask your administrator to set the "client_id" app_metadata for your Auth0 user.'
    );
    return;
  }

  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    accessToken: getIdToken,
  });

  document.getElementById('login-gate').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  await bootstrapApp();
}

function showLoginError(message) {
  const err = document.getElementById('login-err');
  err.textContent = message;
  err.classList.remove('hidden');
  document.getElementById('login-btn').disabled = true;
}

// ---------- bootstrap & data loading ----------

async function bootstrapApp() {
  await loadClientInfo();
  await Promise.all([loadDeals(), loadTasks()]);
  populateOwnerFilter();
  renderAll();
}

async function loadClientInfo() {
  const { data, error } = await supabase.from('clients').select('name,plan').eq('id', CURRENT_CLIENT_ID).single();
  if (error || !data) {
    console.error('Failed to load client info', error);
    return;
  }
  document.getElementById('client-chip').textContent = data.name;
  document.getElementById('top-av').textContent = ownerInitials(data.name);
  document.getElementById('plan-name').textContent = data.plan || 'Growth';
  document.getElementById('plan-price').textContent = PLAN_PRICE[data.plan] || PLAN_PRICE.Growth;
}

async function loadDeals() {
  const { data, error } = await supabase.from('deals').select('*').order('created_at', { ascending: true });
  if (error) {
    console.error('Failed to load deals', error);
    DEALS = [];
    DEALS_BY_ID = {};
    return;
  }
  DEALS = data;
  DEALS_BY_ID = Object.fromEntries(DEALS.map((d) => [d.id, d]));
}

async function loadTasks() {
  const { data, error } = await supabase.from('tasks').select('*').order('due_date', { ascending: true, nullsFirst: false });
  if (error) {
    console.error('Failed to load tasks', error);
    TASKS = [];
    return;
  }
  TASKS = data;
}

async function loadComments(dealId) {
  const { data, error } = await supabase.from('comments').select('*').eq('deal_id', dealId).order('created_at', { ascending: false });
  if (error) {
    console.error('Failed to load comments', error);
    return [];
  }
  return data;
}

function renderAll() {
  renderKPIs();
  renderTeam();
  renderPipeline();
  renderTasks();
  renderDealList();
  renderForecast();
}

// ---------- filters ----------

function visibleDeals() {
  return DEALS.filter((d) => {
    if (ownerFilter && d.owner !== ownerFilter) return false;
    if (attentionOnly) {
      const accent = dealAccent(d);
      if (accent !== 'r' && accent !== 'l' && accent !== 'w') return false;
    }
    if (searchQuery) {
      const haystack = `${d.opportunity} ${d.company}`.toLowerCase();
      if (!haystack.includes(searchQuery)) return false;
    }
    return true;
  });
}

function populateOwnerFilter() {
  const sel = document.getElementById('owner-filter');
  const owners = [...new Set(DEALS.map((d) => d.owner).filter(Boolean))].sort();
  const current = sel.value;
  sel.innerHTML = '<option value="">All owners</option>' + owners.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
  if (owners.includes(current)) sel.value = current;
}

function applyFilters() {
  ownerFilter = document.getElementById('owner-filter').value;
  renderPipeline();
  renderTasks();
}

function toggleAttentionFilter() {
  attentionOnly = !attentionOnly;
  document.getElementById('attention-filter-btn').classList.toggle('active-filter', attentionOnly);
  renderPipeline();
}

// ---------- KPIs & team ----------

function renderKPIs() {
  const totalValue = DEALS.reduce((s, d) => s + Number(d.value), 0);
  const totalWeighted = DEALS.reduce((s, d) => s + Number(d.weighted), 0);
  const awaiting = DEALS.filter((d) => d.stage === 'Awaiting PO');
  const awaitingValue = awaiting.reduce((s, d) => s + Number(d.value), 0);
  const avgProb = awaiting.length ? Math.round(awaiting.reduce((s, d) => s + Number(d.win_prob), 0) / awaiting.length) : 0;
  const overdueTasks = TASKS.filter((t) => t.status === 'open' && t.due_date && new Date(t.due_date) < startOfToday());

  document.getElementById('kpi-total-pipeline').textContent = fmtEUR(totalValue);
  document.getElementById('kpi-total-count').textContent = `${DEALS.length} active opportunities`;
  document.getElementById('kpi-weighted').textContent = fmtEUR(totalWeighted);
  document.getElementById('kpi-awaiting-value').textContent = fmtEUR(awaitingValue);
  document.getElementById('kpi-awaiting-meta').innerHTML = `<i class="ti ti-check" style="font-size:10px;" aria-hidden="true"></i> ${awaiting.length} deals · ${avgProb}% win prob`;
  document.getElementById('kpi-overdue').textContent = overdueTasks.length;
}

function renderTeam() {
  const container = document.getElementById('team-list');
  container.innerHTML = '';
  const counts = {};
  for (const d of DEALS) {
    const owner = d.owner || 'Unassigned';
    counts[owner] = (counts[owner] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  for (const [owner, count] of entries) {
    const row = document.createElement('div');
    row.className = 'ow-row';
    row.innerHTML = `<div class="ow-av" style="background:${ownerColor(owner)};">${ownerInitials(owner)}</div><span class="ow-name">${escapeHtml(owner)}</span><span class="ow-n">${count}</span>`;
    row.addEventListener('click', () => {
      document.getElementById('owner-filter').value = owner === 'Unassigned' ? '' : owner;
      applyFilters();
      sv('pipeline', document.querySelectorAll('.nav-item')[0]);
    });
    container.appendChild(row);
  }
}

// ---------- pipeline ----------

function dealAccent(deal) {
  const days = daysInStage(deal);
  const today = startOfToday();
  if (deal.stage === 'Negotiation' && days > 90) return 'l';
  if (deal.next_action) {
    const diff = Math.ceil((new Date(deal.next_action) - today) / 86400000);
    if (diff < 0) return 'r';
    if (diff <= 7) return 'h';
  }
  if (days > 60) return 'w';
  return 'n';
}

function dealAgeBadge(deal) {
  const days = daysInStage(deal);
  const today = startOfToday();
  if (deal.next_action) {
    const diff = Math.ceil((new Date(deal.next_action) - today) / 86400000);
    if (diff < 0) return { cls: 'o', icon: 'alert-circle', text: `${Math.abs(diff)}d overdue` };
    if (diff === 0) return { cls: 'g', icon: 'calendar', text: 'Today' };
    if (diff <= 7) return { cls: 'g', icon: 'calendar', text: `${diff}d` };
  }
  return { cls: days > 60 ? 'o' : '', icon: 'clock', text: `${days}d` };
}

function renderPipeline() {
  document.getElementById('pipeline-count').textContent = `${DEALS.length} records`;
  document.getElementById('nav-pipeline-count').textContent = DEALS.length;

  if (pipelineView === 'kanban') {
    renderPipelineBoard();
  } else {
    renderPipelineList();
  }
}

function renderPipelineBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  const deals = visibleDeals();
  for (const stage of STAGES) {
    const dealsInStage = deals.filter((d) => d.stage === stage);
    const total = dealsInStage.reduce((s, d) => s + Number(d.value), 0);
    const col = document.createElement('div');
    col.className = 'col';
    col.innerHTML = `<div class="col-hd"><span class="col-t">${stage}</span><div class="col-m"><span class="col-c">${dealsInStage.length}</span><span class="col-v">${fmtEUR(total)}</span></div></div>
      <div class="col-body" data-stage="${stage}"></div>`;
    board.appendChild(col);
    const body = col.querySelector('.col-body');
    body.addEventListener('dragover', onColDragOver);
    body.addEventListener('dragleave', onColDragLeave);
    body.addEventListener('drop', onColDrop);
    for (const deal of dealsInStage) {
      body.appendChild(renderDealCard(deal));
    }
    if (dealsInStage.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align:center;font-size:11px;color:var(--fg3);padding:10px 4px;';
      empty.textContent = 'No deals';
      body.appendChild(empty);
    }
  }
}

function renderDealCard(deal) {
  const el = document.createElement('div');
  el.className = `deal ${dealAccent(deal)}`;
  el.draggable = true;
  el.dataset.id = deal.id;
  const badge = dealAgeBadge(deal);
  el.innerHTML = `<div class="dc">${escapeHtml(deal.company)}</div><div class="dn">${escapeHtml(deal.opportunity)}</div><div class="dv">${fmtEURFull(deal.value)}</div>
    <div class="df"><span class="da ${badge.cls}"><i class="ti ti-${badge.icon}" style="font-size:10px;" aria-hidden="true"></i> ${badge.text}</span><div class="ob" style="background:${ownerColor(deal.owner)};">${ownerInitials(deal.owner)}</div></div>`;
  el.addEventListener('dragstart', onDealDragStart);
  el.addEventListener('dragend', onDealDragEnd);
  el.addEventListener('click', () => {
    sv('comments', document.querySelectorAll('.nav-item')[2]);
    selectDeal(deal.id);
  });
  return el;
}

function renderPipelineList() {
  const tbody = document.getElementById('pipeline-list-body');
  tbody.innerHTML = '';
  const deals = [...visibleDeals()].sort((a, b) => Number(b.value) - Number(a.value));
  for (const deal of deals) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.innerHTML = `<td style="font-weight:600;color:var(--fg);">${escapeHtml(deal.opportunity)}</td>
      <td>${escapeHtml(deal.company)}</td>
      <td>${escapeHtml(deal.stage)}</td>
      <td style="text-align:right;font-weight:600;">${fmtEURFull(deal.value)}</td>
      <td style="text-align:right;">${Number(deal.win_prob)}%</td>
      <td style="text-align:right;color:var(--sf-blue);font-weight:600;">${fmtEURFull(deal.weighted)}</td>
      <td><div style="display:flex;align-items:center;gap:5px;"><div class="ob" style="background:${ownerColor(deal.owner)};width:20px;height:20px;font-size:8px;">${ownerInitials(deal.owner)}</div>${escapeHtml(deal.owner || 'Unassigned')}</div></td>
      <td>${daysInStage(deal)}d</td>`;
    tr.addEventListener('click', () => {
      sv('comments', document.querySelectorAll('.nav-item')[2]);
      selectDeal(deal.id);
    });
    tbody.appendChild(tr);
  }
}

function setPipelineView(mode, btn) {
  pipelineView = mode;
  document.querySelectorAll('.vt-b').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('board-wrap').classList.toggle('hidden', mode !== 'kanban');
  document.getElementById('pipeline-list').classList.toggle('hidden', mode !== 'list');
  renderPipeline();
}

// ---------- drag & drop ----------

function onDealDragStart(e) {
  dragDealId = e.currentTarget.dataset.id;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function onDealDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  dragDealId = null;
}

function onColDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('drag-over');
}

function onColDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

async function onColDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const newStage = e.currentTarget.dataset.stage;
  if (!dragDealId) return;
  const deal = DEALS_BY_ID[dragDealId];
  if (!deal || deal.stage === newStage) return;

  const now = new Date().toISOString();
  const { error } = await supabase.from('deals').update({ stage: newStage, stage_changed_at: now }).eq('id', dragDealId);
  if (error) {
    alert('Failed to move deal: ' + error.message);
    return;
  }
  deal.stage = newStage;
  deal.stage_changed_at = now;
  renderPipeline();
  renderKPIs();
  renderForecast();
}

// ---------- tasks ----------

function renderTasks() {
  const tbody = document.getElementById('tasks-body');
  tbody.innerHTML = '';

  const today = startOfToday();
  const inWeek = new Date(today.getTime() + 7 * 86400000);

  const tasks = TASKS.filter((t) => {
    if (!ownerFilter) return true;
    if (t.owner === ownerFilter) return true;
    const deal = DEALS_BY_ID[t.deal_id];
    return deal && deal.owner === ownerFilter;
  });

  const open = tasks.filter((t) => t.status === 'open');
  const overdue = open.filter((t) => t.due_date && new Date(t.due_date) < today);
  const dueToday = open.filter((t) => t.due_date && new Date(t.due_date).getTime() === today.getTime());
  const thisWeek = open.filter((t) => t.due_date && new Date(t.due_date) > today && new Date(t.due_date) <= inWeek);
  const later = open.filter((t) => !overdue.includes(t) && !dueToday.includes(t) && !thisWeek.includes(t));
  const done = tasks.filter((t) => t.status === 'done');

  const groups = [
    { label: `Overdue (${overdue.length})`, color: 'var(--red)', items: overdue, badge: (t) => ({ cls: 'do', text: `${Math.floor((today - new Date(t.due_date)) / 86400000)}d overdue` }) },
    { label: `Due today (${dueToday.length})`, color: 'var(--amber)', items: dueToday, badge: () => ({ cls: 'dt', text: 'Today' }) },
    { label: `This week (${thisWeek.length})`, color: 'var(--sf-blue)', items: thisWeek, badge: (t) => ({ cls: 'ds', text: fmtDateShort(t.due_date) }) },
    { label: `Later (${later.length})`, color: 'var(--fg3)', items: later, badge: (t) => ({ cls: 'ds', text: t.due_date ? fmtDateShort(t.due_date) : 'No due date' }) },
    { label: `Completed (${done.length})`, color: 'var(--green)', items: done, badge: () => ({ cls: 'ds', text: 'Done' }) },
  ];

  for (const g of groups) {
    if (g.items.length === 0) continue;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6"><div class="sdiv"><span class="sdot" style="background:${g.color}"></span> ${g.label}</div></td>`;
    tbody.appendChild(tr);
    for (const t of g.items) {
      tbody.appendChild(renderTaskRow(t, g.badge(t)));
    }
  }

  const totalOverdue = TASKS.filter((t) => t.status === 'open' && t.due_date && new Date(t.due_date) < today).length;
  document.getElementById('tasks-count').textContent = `${TASKS.length} tasks · ${totalOverdue} overdue`;
  document.getElementById('nav-tasks-count').textContent = totalOverdue;
  document.getElementById('subnav-tasks-badge').textContent = totalOverdue;
}

function renderTaskRow(task, badge) {
  const deal = DEALS_BY_ID[task.deal_id];
  const tr = document.createElement('tr');
  if (task.status === 'done') tr.style.opacity = '0.4';
  const priorityClass = task.priority === 'Critical' ? 'pc' : task.priority === 'High' ? 'ph' : 'pn';
  tr.innerHTML = `<td><div class="tc ${task.status === 'done' ? 'done' : ''}" data-id="${task.id}">${task.status === 'done' ? '<i class="ti ti-check" style="font-size:10px;color:#fff;" aria-hidden="true"></i>' : ''}</div></td>
    <td style="font-size:12px;font-weight:500;color:var(--fg);">${escapeHtml(task.title)}</td>
    <td style="color:var(--fg3);">${deal ? `${escapeHtml(deal.opportunity)} · ${fmtEUR(deal.value)}` : '—'}</td>
    <td><div style="display:flex;align-items:center;gap:5px;"><div class="ob" style="background:${ownerColor(task.owner)};width:20px;height:20px;font-size:8px;">${ownerInitials(task.owner)}</div>${escapeHtml(task.owner || 'Unassigned')}</div></td>
    <td><span class="pb ${priorityClass}">${escapeHtml(task.priority)}</span></td>
    <td><span class="db ${badge.cls}">${badge.text}</span></td>`;
  tr.querySelector('.tc').addEventListener('click', () => toggleTask(task.id));
  return tr;
}

async function toggleTask(id) {
  const task = TASKS.find((t) => t.id === id);
  if (!task) return;
  const newStatus = task.status === 'done' ? 'open' : 'done';
  const { error } = await supabase.from('tasks').update({ status: newStatus }).eq('id', id);
  if (error) {
    alert('Failed to update task: ' + error.message);
    return;
  }
  task.status = newStatus;
  renderTasks();
  renderKPIs();
}

// ---------- comments / activity ----------

function renderDealList() {
  const list = document.getElementById('deal-list');
  list.innerHTML = '';
  const sorted = [...DEALS].sort((a, b) => Number(b.value) - Number(a.value));
  for (const deal of sorted) {
    const item = document.createElement('div');
    item.className = 'dli' + (deal.id === activeDealId ? ' active' : '');
    item.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:start;"><div class="dli-n">${escapeHtml(deal.opportunity)}</div><div class="dli-v">${fmtEUR(deal.value)}</div></div><div class="dli-m">${escapeHtml(deal.stage)} · ${escapeHtml(deal.owner || 'Unassigned')}</div>`;
    item.addEventListener('click', () => selectDeal(deal.id));
    list.appendChild(item);
  }
  if (sorted.length === 0) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--fg3);font-size:12px;">No deals yet.</div>';
  }
}

async function selectDeal(id) {
  activeDealId = id;
  renderDealList();
  const deal = DEALS_BY_ID[id];
  if (!deal) return;

  const style = STAGE_STYLE[deal.stage] || STAGE_STYLE.Quote;
  document.getElementById('ap-n').textContent = deal.opportunity;
  document.getElementById('ap-s').textContent = deal.stage;
  document.getElementById('ap-s').style.background = style.bg;
  document.getElementById('ap-s').style.color = style.fg;
  document.getElementById('ap-v').textContent = fmtEURFull(deal.value);
  document.getElementById('ap-o').textContent = deal.owner || 'Unassigned';

  const days = daysInStage(deal);
  const ageEl = document.getElementById('ap-a');
  ageEl.textContent = `${days} day${days === 1 ? '' : 's'} in stage`;
  ageEl.style.color = days > 90 ? 'var(--red)' : 'var(--fg3)';

  const body = document.getElementById('ap-body');
  body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--fg3);font-size:12px;">Loading…</div>';
  const comments = await loadComments(id);
  body.innerHTML = '';
  if (comments.length === 0) {
    body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--fg3);font-size:12px;">No activity yet.</div>';
    return;
  }
  for (const c of comments) {
    body.appendChild(renderCommentItem(c));
  }
}

function renderCommentItem(c) {
  const el = document.createElement('div');
  el.className = 'ai';
  el.innerHTML = `<div class="aav" style="background:${ownerColor(c.author)};">${ownerInitials(c.author)}</div><div class="acon"><div class="atop"><span class="aauth">${escapeHtml(c.author)}</span><span class="atime">${fmtDateTime(c.created_at)}</span><span class="atype ${COMMENT_TYPE_CLASS[c.type] || 'an'}">${escapeHtml(c.type)}</span></div><div class="atext">${escapeHtml(c.body)}</div></div>`;
  return el;
}

function setActivityType(btn, type) {
  document.querySelectorAll('.tb2').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  activityType = type;
}

async function postComment() {
  const inp = document.getElementById('ai-inp');
  const text = inp.value.trim();
  if (!text || !activeDealId) return;
  const author = currentUser?.name || currentUser?.email || 'User';
  const { data, error } = await supabase
    .from('comments')
    .insert({ deal_id: activeDealId, author, type: activityType, body: text })
    .select()
    .single();
  if (error) {
    alert('Failed to post comment: ' + error.message);
    return;
  }
  const body = document.getElementById('ap-body');
  const empty = body.querySelector('div');
  if (body.children.length === 1 && empty && empty.textContent.includes('No activity')) body.innerHTML = '';
  body.prepend(renderCommentItem(data));
  inp.value = '';
}

// ---------- forecast ----------

function renderForecast() {
  const totalValue = DEALS.reduce((s, d) => s + Number(d.value), 0);
  const totalWeighted = DEALS.reduce((s, d) => s + Number(d.weighted), 0);
  const nearCertain = DEALS.filter((d) => Number(d.win_prob) >= 80).reduce((s, d) => s + Number(d.value), 0);
  const overdueTasks = TASKS.filter((t) => t.status === 'open' && t.due_date && new Date(t.due_date) < startOfToday()).length;

  document.getElementById('fc-total').textContent = fmtEUR(totalValue);
  document.getElementById('fc-weighted').textContent = fmtEUR(totalWeighted);
  document.getElementById('fc-near').textContent = fmtEUR(nearCertain);
  document.getElementById('fc-overdue').textContent = overdueTasks;
  document.getElementById('fc-meta').textContent = `${monthRangeLabel()} · ${DEALS.length} opportunities`;

  renderMonthlyForecast();
  renderForecastByStage(totalWeighted);
  renderForecastByOwner();
}

function renderMonthlyForecast() {
  const tbody = document.getElementById('forecast-monthly-body');
  tbody.innerHTML = '';
  const now = new Date();
  const months = [];
  for (let i = 0; i < 7; i++) months.push(new Date(now.getFullYear(), now.getMonth() + i, 1));

  const rows = months.map((m) => {
    const matched = DEALS.filter((d) => d.close_month && sameMonth(new Date(d.close_month), m));
    const value = matched.reduce((s, d) => s + Number(d.value), 0);
    const weighted = matched.reduce((s, d) => s + Number(d.weighted), 0);
    const prob = value > 0 ? Math.round((weighted / value) * 100) : 0;
    return { m, value, weighted, prob };
  });

  const maxExpected = Math.max(1, ...rows.map((r) => r.weighted));

  for (const r of rows) {
    const pct = Math.round((r.weighted / maxExpected) * 100);
    const barClass = r.prob >= 60 ? 'bh' : r.prob >= 35 ? 'bm' : 'bl';
    const probClass = r.prob >= 60 ? 'up' : r.prob >= 35 ? 'neu' : 'down';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="mn">${monthLabel(r.m)}</td><td class="bt"><div class="btr"><div class="bf ${barClass}" style="width:${pct}%"></div></div></td><td class="amt">${fmtEUR(r.weighted)}</td><td class="prb ${probClass}">${r.prob}%</td>`;
    tbody.appendChild(tr);
  }
}

function renderForecastByStage(totalWeighted) {
  const container = document.getElementById('forecast-stage-rows');
  container.innerHTML = '';
  for (const stage of STAGES) {
    const items = DEALS.filter((d) => d.stage === stage);
    const value = items.reduce((s, d) => s + Number(d.value), 0);
    const weighted = items.reduce((s, d) => s + Number(d.weighted), 0);
    const style = STAGE_STYLE[stage];
    const row = document.createElement('div');
    row.className = 'sr';
    row.innerHTML = `<div class="sn2">${stage} <span class="sc">${items.length}</span></div><span class="sprb" style="background:${style.bg};color:${style.fg};">${STAGE_PROB[stage]}%</span><div class="spi">${fmtEURFull(value)}</div><div class="swt">${fmtEURFull(weighted)}</div>`;
    container.appendChild(row);
  }
  document.getElementById('forecast-total-weighted').textContent = fmtEURFull(totalWeighted);
}

function renderForecastByOwner() {
  const container = document.getElementById('forecast-owner-rows');
  container.innerHTML = '';
  const totals = {};
  for (const d of DEALS) {
    const owner = d.owner || 'Unassigned';
    totals[owner] ||= { value: 0, weighted: 0, count: 0 };
    totals[owner].value += Number(d.value);
    totals[owner].weighted += Number(d.weighted);
    totals[owner].count += 1;
  }
  const entries = Object.entries(totals).sort((a, b) => b[1].value - a[1].value);
  const maxValue = Math.max(1, ...entries.map(([, t]) => t.value));
  for (const [owner, t] of entries) {
    const pct = Math.round((t.value / maxValue) * 100);
    const row = document.createElement('div');
    row.className = 'ofr';
    row.innerHTML = `<div class="ofav" style="background:${ownerColor(owner)};">${ownerInitials(owner)}</div><div class="ofi"><div class="ofn">${escapeHtml(owner)}</div><div class="ofo">${t.count} opportunit${t.count === 1 ? 'y' : 'ies'}</div><div class="ofbw"><div class="ofb" style="width:${pct}%"></div></div></div><div style="text-align:right;"><div class="ofp">${fmtEUR(t.value)}</div><div class="ofw">${fmtEUR(t.weighted)} wtd</div></div>`;
    container.appendChild(row);
  }
}

// ---------- modals: new deal / new task ----------

function openModal(name) {
  if (name === 'task') populateTaskDealOptions();
  document.getElementById(`${name}-modal-backdrop`).classList.remove('hidden');
}

function closeModal(name) {
  document.getElementById(`${name}-modal-backdrop`).classList.add('hidden');
  document.getElementById(`${name}-form`).reset();
}

function populateTaskDealOptions() {
  const sel = document.querySelector('#task-form select[name="deal_id"]');
  const sorted = [...DEALS].sort((a, b) => a.opportunity.localeCompare(b.opportunity));
  sel.innerHTML = '<option value="">(none)</option>' + sorted.map((d) => `<option value="${d.id}">${escapeHtml(d.opportunity)} — ${fmtEUR(d.value)}</option>`).join('');
}

async function submitDealForm() {
  const form = document.getElementById('deal-form');
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  const fd = new FormData(form);
  const payload = {
    client_id: CURRENT_CLIENT_ID,
    opportunity: fd.get('opportunity'),
    company: fd.get('company'),
    stage: fd.get('stage'),
    value: Number(fd.get('value')) || 0,
    win_prob: Number(fd.get('win_prob')) || 0,
    owner: fd.get('owner') || null,
    source: fd.get('source') || null,
    next_action: fd.get('next_action') || null,
    close_month: fd.get('close_month') ? `${fd.get('close_month')}-01` : null,
    notes: fd.get('notes') || null,
  };
  const { data, error } = await supabase.from('deals').insert(payload).select().single();
  if (error) {
    alert('Failed to create deal: ' + error.message);
    return;
  }
  DEALS.push(data);
  DEALS_BY_ID[data.id] = data;
  closeModal('deal');
  populateOwnerFilter();
  renderAll();
}

async function submitTaskForm() {
  const form = document.getElementById('task-form');
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  const fd = new FormData(form);
  const payload = {
    client_id: CURRENT_CLIENT_ID,
    title: fd.get('title'),
    deal_id: fd.get('deal_id') || null,
    owner: fd.get('owner') || null,
    due_date: fd.get('due_date') || null,
    priority: fd.get('priority') || 'Normal',
    status: 'open',
  };
  const { data, error } = await supabase.from('tasks').insert(payload).select().single();
  if (error) {
    alert('Failed to create task: ' + error.message);
    return;
  }
  TASKS.push(data);
  closeModal('task');
  renderTasks();
  renderKPIs();
}

// ---------- AI assistant ----------

function chatBubble(author, text, isUser) {
  const el = document.createElement('div');
  el.className = 'ai';
  el.innerHTML = `<div class="aav" style="background:${isUser ? ownerColor(author) : 'var(--sf-blue)'};">${isUser ? ownerInitials(author) : 'AI'}</div><div class="acon"><div class="atop"><span class="aauth">${escapeHtml(author)}</span></div><div class="atext"></div></div>`;
  el.querySelector('.atext').textContent = text;
  return el;
}

async function sendAssistantMessage() {
  const inp = document.getElementById('assistant-inp');
  const text = inp.value.trim();
  if (!text) return;
  const body = document.getElementById('assistant-body');

  const author = currentUser?.name || currentUser?.email || 'You';
  body.appendChild(chatBubble(author, text, true));
  inp.value = '';

  const thinking = chatBubble('Assistant', 'Thinking…', false);
  body.appendChild(thinking);
  body.scrollTop = body.scrollHeight;

  try {
    const idToken = await getIdToken();
    const res = await fetch('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ message: text, history: assistantHistory, author }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Request failed');

    thinking.querySelector('.atext').textContent = json.reply;
    assistantHistory = json.history || assistantHistory;

    if (json.actions && json.actions.length > 0) {
      await Promise.all([loadDeals(), loadTasks()]);
      populateOwnerFilter();
      renderAll();
      if (activeDealId) selectDeal(activeDealId);
    }
  } catch (err) {
    thinking.querySelector('.atext').textContent = 'Sorry, something went wrong: ' + err.message;
  }
  body.scrollTop = body.scrollHeight;
}

// ---------- init ----------

document.getElementById('search-box').addEventListener('input', (e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  renderPipeline();
});

initAuth();
