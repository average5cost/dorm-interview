// ============ State ============
let currentView = 'list';
let currentUser = null; // { member_id, name }
let interviews = [];
let members = [];
let timelineWeekStart = null;
let lastDataHash = '';

// ============ Init ============
document.addEventListener('DOMContentLoaded', () => {
  initTimelineWeek();
  loadMembers().then(() => {
    restoreLogin();
  });
  bindEvents();
});

function localDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function initTimelineWeek() {
  const now = new Date();
  // Get Monday of current week
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday start
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  timelineWeekStart = localDateStr(monday);
}

// ============ Event Bindings ============
function bindEvents() {
  // Navigation
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Add button
  document.getElementById('btnAdd').addEventListener('click', () => openForm());

  // Form
  document.getElementById('interviewForm').addEventListener('submit', handleFormSubmit);

  // Modal close buttons
  document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', () => closeModal(el.dataset.close));
  });
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && overlay.id !== 'modalLogin') closeModal(overlay.id);
    });
  });

  // Filter
  document.getElementById('filterDate').addEventListener('change', loadInterviews);
  document.getElementById('btnClearFilter').addEventListener('click', () => {
    document.getElementById('filterDate').value = '';
    loadInterviews();
  });

  // Login
  document.getElementById('btnLogin').addEventListener('click', handleLogin);
  document.getElementById('loginPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
  });

  // Members
  document.getElementById('btnMembers').addEventListener('click', openMembers);
  document.getElementById('btnSaveMembers').addEventListener('click', saveMembers);

  // Status select (delegated from detail modal)
  document.getElementById('detailContent').addEventListener('change', async (e) => {
    if (e.target.classList.contains('status-select')) {
      const memberId = e.target.dataset.member;
      const date = e.target.dataset.date;
      const status = e.target.value;
      await api(`/api/member-status/${memberId}`, {
        method: 'PUT',
        body: JSON.stringify({ date, status })
      });
      // Refresh detail to update
      loadInterviews();
    }
  });

  // Timeline navigation
  document.getElementById('btnPrevWeek').addEventListener('click', () => {
    const [y, m, day] = timelineWeekStart.split('-').map(Number);
    const d = new Date(y, m - 1, day - 7);
    timelineWeekStart = localDateStr(d);
    loadTimeline();
  });
  document.getElementById('btnNextWeek').addEventListener('click', () => {
    const [y, m, day] = timelineWeekStart.split('-').map(Number);
    const d = new Date(y, m - 1, day + 7);
    timelineWeekStart = localDateStr(d);
    loadTimeline();
  });
}

// ============ API Calls ============
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  return res.json();
}

async function loadMembers() {
  members = await api('/api/members');
  // Populate form select
  const fs = document.getElementById('formMember');
  if (fs) {
    fs.innerHTML = '<option value="">请选择</option>';
    members.forEach(m => {
      fs.innerHTML += `<option value="${m.id}">${m.name}</option>`;
    });
  }
  // Populate login select
  const ls = document.getElementById('loginMember');
  if (ls) {
    ls.innerHTML = '';
    members.forEach(m => {
      ls.innerHTML += `<option value="${m.id}">${m.name}</option>`;
    });
  }
}

// ============ Login ============
function restoreLogin() {
  const saved = localStorage.getItem('dorm_user');
  if (saved) {
    try {
      currentUser = JSON.parse(saved);
      if (members.find(m => m.id === currentUser.member_id)) {
        onLoginSuccess();
        return;
      }
    } catch(e) {}
  }
  document.getElementById('modalLogin').classList.add('active');
  document.getElementById('loginPassword').focus();
}

function onLoginSuccess() {
  document.getElementById('modalLogin').classList.remove('active');
  updateHeaderUser();
  // Show clear button for admin
  if (currentUser && currentUser.member_id === 5) {
    document.getElementById('msgClear').style.display = 'inline-block';
  }
  loadInterviews();
  initMessagePanel();
  startPolling();
}

function updateHeaderUser() {
  if (!currentUser) return;
  const idx = members.findIndex(m => m.id === currentUser.member_id);
  const colors = ['#4f46e5', '#0891b2', '#ea580c', '#16a34a'];
  const dotColor = colors[idx] || '#4f46e5';

  const hr = document.querySelector('.header-right');
  const existing = document.getElementById('headerUser');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.id = 'headerUser';
  div.className = 'header-user';
  div.innerHTML = `
    <span class="user-dot" style="background:${dotColor}"></span>
    ${esc(currentUser.name)}
    <button class="btn-logout" id="btnLogout">退出</button>
  `;
  hr.insertBefore(div, hr.firstChild);

  div.querySelector('#btnLogout').addEventListener('click', () => {
    localStorage.removeItem('dorm_user');
    location.reload();
  });
}

async function handleLogin() {
  const memberId = parseInt(document.getElementById('loginMember').value);
  const password = document.getElementById('loginPassword').value;
  const res = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ member_id: memberId, password })
  });
  if (res.error) {
    document.getElementById('loginError').textContent = res.error;
    document.getElementById('loginError').style.display = 'block';
  } else {
    currentUser = { member_id: res.member_id, name: res.name };
    localStorage.setItem('dorm_user', JSON.stringify(currentUser));
    onLoginSuccess();
  }
}

async function loadInterviews() {
  const dateFilter = document.getElementById('filterDate').value;
  const params = dateFilter ? `?date=${dateFilter}` : '';
  interviews = await api(`/api/interviews${params}`);
  renderInterviewList();
}

async function loadInterviewDetail(id) {
  const data = await api(`/api/interviews/${id}`);
  return data;
}

async function loadTimeline() {
  const data = await api(`/api/schedule?week_start=${timelineWeekStart}`);
  renderTimeline(data.days);
}

// ============ Render ============
function renderInterviewList() {
  const container = document.getElementById('interviewList');

  if (interviews.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">📭</div>
        <p>还没有面试记录</p>
        <p style="margin-top:8px">点击右上角「+ 添加面试」开始记录</p>
      </div>`;
    return;
  }

  container.innerHTML = interviews.map(iv => {
    const date = new Date(iv.date + 'T00:00:00');
    const dayNum = date.getDate();
    const monthNum = date.getMonth() + 1;
    const weekdays = ['周日','周一','周二','周三','周四','周五','周六'];
    const weekday = weekdays[date.getDay()];
    const memberIdx = members.findIndex(m => m.id === iv.member_id);
    const memberClass = `member-${memberIdx + 1}`;

    return `
    <div class="interview-card" onclick="openDetail(${iv.id})">
      <div class="card-date">
        <div class="day">${dayNum}</div>
        <div class="month">${monthNum}月</div>
        <div class="weekday">${weekday}</div>
      </div>
      <div class="card-info">
        <h3>${esc(iv.company)} - ${esc(iv.position)}</h3>
        <div class="meta">
          <span>🕐 ${iv.start_time}-${iv.end_time}</span>
        </div>
      </div>
      <span class="card-member ${memberClass}">${esc(iv.member_name)}</span>
      <div class="card-actions" onclick="event.stopPropagation()">
        <button class="btn btn-sm" onclick="openForm(${iv.id})">✏️</button>
        <button class="btn btn-sm btn-danger" onclick="deleteInterview(${iv.id}, '${esc(iv.company)}')">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function renderTimeline(days) {
  const container = document.getElementById('timeline');
  const weekLabel = document.getElementById('weekLabel');

  // Week label
  const [sy, sm, sd] = timelineWeekStart.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(sy, sm - 1, sd + 6);
  weekLabel.textContent = `${formatDate(start)} ~ ${formatDate(end)}`;

  // Time slots from 8:00 to 22:00
  const hours = [];
  for (let h = 8; h <= 22; h++) {
    hours.push(`${String(h).padStart(2, '0')}:00`);
  }

  const memberColors = ['member-1', 'member-2', 'member-3', 'member-4'];

  let html = '<table class="timeline-table"><thead><tr><th></th>';
  days.forEach(d => {
    const dateParts = d.date.split('-');
    html += `<th><span class="date-num">${parseInt(dateParts[2])}</span><span class="date-day">${d.day_name}</span></th>`;
  });
  html += '</tr></thead><tbody>';

  hours.forEach(hour => {
    html += '<tr>';
    html += `<td class="time-label">${hour}</td>`;

    days.forEach(d => {
      const nextHour = `${String(parseInt(hour.split(':')[0]) + 1).padStart(2, '0')}:00`;
      const hourMin = timeToMinutes(hour);
      const nextHourMin = timeToMinutes(nextHour);
      const totalSlotMin = nextHourMin - hourMin;

      // Collect interviews in this hour slot
      const slotInterviews = d.interviews.filter(iv => iv.start_time < nextHour && iv.end_time > hour);

      // Assign columns for overlapping interviews
      const columns = []; // each element is an interview or null
      slotInterviews.forEach(iv => {
        let col = 0;
        while (col < columns.length && columns[col] !== null) col++;
        columns[col] = iv;
      });

      const colCount = columns.length || 1;
      html += '<td>';

      slotInterviews.forEach(iv => {
        const memberIdx = members.findIndex(m => m.id === iv.member_id);
        const colorClass = memberColors[memberIdx] || 'member-1';
        const startMin = timeToMinutes(iv.start_time);
        const endMin = timeToMinutes(iv.end_time);

        const slotStart = Math.max(startMin, hourMin);
        const slotEnd = Math.min(endMin, nextHourMin);
        const topPct = ((slotStart - hourMin) / totalSlotMin) * 100;
        const heightPct = ((slotEnd - slotStart) / totalSlotMin) * 100;
        const leftPct = (columns.indexOf(iv) / colCount) * 100;
        const widthPct = (100 / colCount) - 2;

        html += `<div class="timeline-slot ${colorClass}"
          style="top:${topPct}%;height:${heightPct}%;left:${leftPct}%;width:${widthPct}%;"
          onclick="event.stopPropagation();openDetail(${iv.id})"
          title="${esc(iv.company)} - ${esc(iv.position)} (${iv.start_time}-${iv.end_time})">
          ${esc(iv.member_name)} ${esc(iv.company)}
        </div>`;
      });
      html += '</td>';
    });

    html += '</tr>';
  });

  html += '</tbody></table>';
  container.innerHTML = html;
}

// ============ View Switching ============
function switchView(view) {
  currentView = view;

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`[data-view="${view}"]`).classList.add('active');

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');

  if (view === 'timeline') {
    loadTimeline();
  } else {
    loadInterviews();
  }
}

// ============ Form ============
async function openForm(editId) {
  const modal = document.getElementById('modalForm');
  const title = document.getElementById('modalFormTitle');

  if (editId) {
    title.textContent = '编辑面试';
    await loadMembers();
    const iv = interviews.find(i => i.id === editId) || await api(`/api/interviews/${editId}`).then(d => d.interview);
    document.getElementById('formId').value = iv.id;
    document.getElementById('formMember').value = iv.member_id;
    document.getElementById('formCompany').value = iv.company;
    document.getElementById('formPosition').value = iv.position;
    document.getElementById('formDate').value = iv.date;
    document.getElementById('formStartTime').value = iv.start_time;
    document.getElementById('formEndTime').value = iv.end_time;
    document.getElementById('formNotes').value = iv.notes || '';
  } else {
    title.textContent = '添加面试';
    document.getElementById('interviewForm').reset();
    document.getElementById('formId').value = '';
    // Set date to today by default
    document.getElementById('formDate').value = new Date().toISOString().split('T')[0];
  }

  modal.classList.add('active');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

async function handleFormSubmit(e) {
  e.preventDefault();

  const id = document.getElementById('formId').value;
  const data = {
    member_id: parseInt(document.getElementById('formMember').value),
    company: document.getElementById('formCompany').value.trim(),
    position: document.getElementById('formPosition').value.trim(),
    date: document.getElementById('formDate').value,
    start_time: document.getElementById('formStartTime').value,
    end_time: document.getElementById('formEndTime').value,
    notes: document.getElementById('formNotes').value.trim()
  };

  if (data.start_time >= data.end_time) {
    alert('结束时间必须晚于开始时间！');
    return;
  }

  if (id) {
    await api(`/api/interviews/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  } else {
    await api('/api/interviews', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  closeModal('modalForm');
  loadInterviews();
  if (currentView === 'timeline') loadTimeline();
}

// ============ Detail ============
async function openDetail(id) {
  const data = await loadInterviewDetail(id);
  const iv = data.interview;
  const memberIdx = members.findIndex(m => m.id === iv.member_id);
  const memberClass = `member-${memberIdx + 1}`;

  const content = document.getElementById('detailContent');
  content.innerHTML = `
    <div class="detail-grid">
      <span class="detail-label">面试人</span>
      <span class="detail-value"><span class="card-member ${memberClass}">${esc(iv.member_name)}</span></span>

      <span class="detail-label">公司</span>
      <span class="detail-value">${esc(iv.company)}</span>

      <span class="detail-label">岗位</span>
      <span class="detail-value">${esc(iv.position)}</span>

      <span class="detail-label">日期</span>
      <span class="detail-value">${iv.date}</span>

      <span class="detail-label">时间</span>
      <span class="detail-value">${iv.start_time} ~ ${iv.end_time}</span>

      ${iv.notes ? `
      <span class="detail-label">备注</span>
      <span class="detail-value">${esc(iv.notes)}</span>` : ''}
    </div>

    <div class="detail-section">
      <h3>🏠 该时段宿舍人员情况</h3>
      <div class="member-tags" style="flex-direction:column;gap:10px">
        ${data.interviewing_members.map((m, i) => {
          const idx = members.findIndex(mb => mb.id === m.id);
          const label = data.interviewing_members.length > 1 ? `在宿舍${i+1}面试` : '面试中';
          return `<span class="member-tag tag-busy">🔴 ${esc(m.name)} — ${label}</span>`;
        }).join('')}
        ${data.free_members.map(m => {
          const idx = members.findIndex(mb => mb.id === m.id);
          const cls = `member-${idx + 1}`;
          const status = data.member_statuses[m.id] || '在宿舍';
          const statusOptions = ['在宿舍', '离校了', '在实验室', '在宿舍帮忙'];
          const optionsHtml = statusOptions.map(s => `<option value="${s}" ${s===status?'selected':''}>${s}</option>`).join('');
          return `<div style="display:flex;align-items:center;gap:8px">
            <span class="card-member member-${idx+1}" style="min-width:50px;text-align:center">${esc(m.name)}</span>
            <select class="status-select" data-member="${m.id}" data-date="${iv.date}" style="padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:0.85rem">
              ${optionsHtml}
            </select>
          </div>`;
        }).join('')}
      </div>
    </div>

    ${data.overlapping_interviews.length > 0 ? `
    <div class="detail-section">
      <h3>⚠️ 同时段其他面试</h3>
      ${data.overlapping_interviews.map(oi => `
        <div style="padding:8px 0;border-bottom:1px solid var(--border)">
          <strong>${esc(oi.member_name)}</strong> — ${esc(oi.company)} ${esc(oi.position)} (${oi.start_time}-${oi.end_time})
        </div>
      `).join('')}
    </div>` : ''}

    <div class="detail-actions">
      <button class="btn" onclick="closeModal('modalDetail');openForm(${iv.id})">✏️ 编辑</button>
      <button class="btn btn-danger" onclick="deleteInterview(${iv.id}, '${esc(iv.company)}');closeModal('modalDetail')">🗑 删除</button>
      <button class="btn btn-cancel" data-close="modalDetail" onclick="closeModal('modalDetail')">关闭</button>
    </div>
  `;

  document.getElementById('modalDetail').classList.add('active');
}

// ============ Delete ============
async function deleteInterview(id, company) {
  if (!confirm(`确认删除「${company}」的面试记录？`)) return;
  await api(`/api/interviews/${id}`, { method: 'DELETE' });
  loadInterviews();
  if (currentView === 'timeline') loadTimeline();
}

// ============ Members ============
function openMembers() {
  const list = document.getElementById('memberEditList');
  const colors = ['#4f46e5', '#0891b2', '#ea580c', '#16a34a'];
  list.innerHTML = members.map((m, i) => `
    <div class="member-edit-item" style="flex-wrap:wrap">
      <span class="member-edit-dot" style="background:${colors[i]}"></span>
      <input type="text" class="member-name-input" data-id="${m.id}" value="${esc(m.name)}" style="flex:1;min-width:100px" placeholder="姓名">
      <input type="password" class="member-password-input" data-id="${m.id}" value="" style="width:100px;padding:6px;border:1px solid var(--border);border-radius:6px;font-size:0.85rem" placeholder="新密码">
      <span style="font-size:0.7rem;color:var(--text-muted)">留空不修改密码</span>
    </div>
  `).join('');
  document.getElementById('modalMembers').classList.add('active');
}

async function saveMembers() {
  const nameInputs = document.querySelectorAll('.member-name-input');
  const pwdInputs = document.querySelectorAll('.member-password-input');
  for (const input of nameInputs) {
    const id = input.dataset.id;
    const name = input.value.trim();
    const pwdInput = document.querySelector(`.member-password-input[data-id="${id}"]`);
    const password = pwdInput ? pwdInput.value.trim() : '';
    const body = {};
    if (name && name !== members.find(m => m.id === parseInt(id)).name) body.name = name;
    if (password) body.password = password;
    if (Object.keys(body).length > 0) {
      await api(`/api/members/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    }
  }
  await loadMembers();
  loadInterviews();
  if (currentView === 'timeline') loadTimeline();
  closeModal('modalMembers');
}

// ============ Polling ============
function startPolling() {
  setInterval(async () => {
    try {
      const dateFilter = document.getElementById('filterDate').value;
      const params = dateFilter ? `?date=${dateFilter}` : '';
      const data = await api(`/api/interviews${params}`);

      // Simple hash to detect changes
      const hash = JSON.stringify(data);

      if (hash !== lastDataHash) {
        lastDataHash = hash;
        interviews = data;

        if (currentView === 'timeline') {
          loadTimeline();
        } else {
          renderInterviewList();
        }

        // Flash indicator
        const indicator = document.getElementById('pollIndicator');
        if (indicator) {
          indicator.textContent = '✅ 已更新';
          indicator.classList.add('updated');
          setTimeout(() => {
            indicator.textContent = '🔄 实时';
            indicator.classList.remove('updated');
          }, 2000);
        }

        // Show toast notification
        showToast('有室友更新了面试信息，页面已自动刷新');
      }

      // Poll messages
      const newMsgs = await api('/api/messages');
      if (newMsgs.length !== messages.length) {
        messages = newMsgs;
        lastMsgId = newMsgs.length > 0 ? newMsgs[newMsgs.length-1].id : 0;
        renderMessages();
      }
    } catch (e) {
      // Server might be down, ignore
    }
  }, 5000);
}

// ============ Messages ============
let messages = [];
let lastMsgId = 0;
let msgOpen = false;
let msgReadCount = 0;

function initMessagePanel() {
  document.getElementById('msgToggle').addEventListener('click', () => {
    msgOpen = !msgOpen;
    const panel = document.getElementById('msgPanel');
    if (msgOpen) {
      panel.classList.add('open');
      msgReadCount = messages.length;
      updateMsgBadge();
      document.getElementById('msgInput').focus();
    } else {
      panel.classList.remove('open');
    }
  });

  document.getElementById('msgSend').addEventListener('click', sendMessage);
  document.getElementById('msgInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
  document.getElementById('msgClear').addEventListener('click', async () => {
    if (!confirm('确认清空所有留言？')) return;
    await api('/api/messages', {
      method: 'DELETE',
      body: JSON.stringify({ admin_id: currentUser.member_id })
    });
    messages = [];
    renderMessages();
  });

  loadMessages();
}

async function loadMessages() {
  const data = await api('/api/messages');
  if (data.length > 0 && data[data.length-1].id === lastMsgId && messages.length > 0) return;
  messages = data;
  lastMsgId = data.length > 0 ? data[data.length-1].id : 0;
  renderMessages();
}

function renderMessages() {
  const list = document.getElementById('msgList');
  if (!list) return;

  if (messages.length === 0) {
    list.innerHTML = '<div class="msg-empty">暂无留言，来抢沙发吧~</div>';
    return;
  }

  const myId = currentUser ? currentUser.member_id : -1;
  list.innerHTML = messages.map(msg => {
    const isMine = myId === msg.member_id;
    const cls = isMine ? 'msg-mine' : 'msg-other';
    const time = msg.created_at ? msg.created_at.slice(11, 16) : '';
    return `
      <div class="msg-bubble ${cls}">
        ${isMine ? '' : `<div class="msg-sender">${esc(msg.member_name)}</div>`}
        <div>${esc(msg.content)}</div>
        <div class="msg-time">${time}</div>
      </div>`;
  }).join('');

  list.scrollTop = list.scrollHeight;
  updateMsgBadge();
}

function updateMsgBadge() {
  const badge = document.getElementById('msgBadge');
  const unread = msgOpen ? 0 : messages.length - msgReadCount;
  if (unread > 0) {
    badge.textContent = unread;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

async function sendMessage() {
  const input = document.getElementById('msgInput');
  const content = input.value.trim();
  if (!content || !currentUser) return;

  await api('/api/messages', {
    method: 'POST',
    body: JSON.stringify({ member_id: currentUser.member_id, content })
  });
  input.value = '';
  await loadMessages();
}

// ============ Toast ============
let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// ============ Helpers ============
function esc(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function formatDate(d) {
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
