'use strict';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const dash = value => esc(value || '—');
const fmt = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short'
});
const fmtTime = value => value ? fmt.format(value) : '—';
const filterForm = $('#report-filters');
const loginForm = $('#login-form');
const savedUsernameKey = 'work-report.admin.saved-username';
const metricLabels = [
  ['total', '전체 기록'], ['visits', '방문'], ['revisits', '재방문'],
  ['updates', '단순 업데이트'], ['consents', '동의서 신규 징구']
];
const views = {
  reports: ['통합 보고서', '전체 상담사의 방문 활동과 보고 내용을 한곳에서 확인하세요.'],
  stats: ['활동 통계', '조회 조건에 맞는 상담사별·구역별·활동일별 실적을 비교하세요.'],
  counselors: ['상담사 관리', '업무보고를 작성할 상담사의 계정을 만들고 확인하세요.']
};
const pageSize = 25;
let report = null;
let activeView = 'reports';
let page = 0;
let editingCounselor = '';
let areaChangePending = false;

function status(id, message = '', error = false) {
  const element = $(id);
  element.textContent = message;
  element.dataset.error = String(error);
}

async function request(url, data) {
  const response = await fetch(url, data === undefined ? {} : {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Work-Report': '1'},
    body: JSON.stringify(data)
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || '요청을 처리하지 못했습니다.');
    error.status = response.status;
    throw error;
  }
  return response;
}

function showLogin(message = '') {
  report = null;
  if ($('#detail').open) $('#detail').close();
  if ($('#assignment-dialog').open) $('#assignment-dialog').close();
  $('#admin-view').hidden = true;
  $('#login-view').hidden = false;
  $('#manager').textContent = '';
  for (const id of ['#report-table', '#stats-counselor', '#stats-area', '#stats-day', '#consent-chart',
    '#activity-chart', '#account-table', '#area-list', '#account-areas', '#assignment-options', '#detail-body']) {
    $(id).replaceChildren();
  }
  $('#create-form').reset();
  $('#area-form').reset();
  restoreLoginForm();
  status('#account-status');
  status('#area-status');
  status('#login-status', message, Boolean(message));
}

function handleError(id, error) {
  if (error.status === 401 || error.status === 403) showLogin(error.message);
  else status(id, error.message, true);
}

function setView(view) {
  activeView = view;
  for (const button of document.querySelectorAll('[data-view]')) {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  const filteredToday = report && report.filters.start === report.today && report.filters.end === report.today;
  $('#page-title').textContent = view === 'reports' && filteredToday ? '오늘의 통합 보고서' : views[view][0];
  $('#page-description').textContent = views[view][1];
  $('#breadcrumb').textContent = views[view][0];
  for (const key of Object.keys(views)) $('#' + key).hidden = key !== view;
  filterForm.hidden = view === 'counselors';
  $('#metrics').hidden = view === 'counselors';
  $('#report-status').hidden = view === 'counselors';
}

function table(headers, body, classes = '') {
  return '<table class="' + classes + '"><thead><tr>' + headers.map(label =>
    '<th scope="col">' + esc(label) + '</th>'
  ).join('') + '</tr></thead><tbody>' + body + '</tbody></table>';
}

function empty(message) {
  return '<p class="empty">' + esc(message) + '</p>';
}

function showTable(container, html, label) {
  container.innerHTML = html;
  if (container.querySelector('table')) {
    container.tabIndex = 0;
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', label);
  } else {
    container.removeAttribute('tabindex');
    container.removeAttribute('role');
    container.removeAttribute('aria-label');
  }
}

function docs(entry) {
  return [
    entry.consent && '동의서',
    entry.privacy && '개인정보 관련 서류',
    entry.identity && '신분증 관련 자료',
    entry.other && (entry.otherDocument || '기타')
  ].filter(Boolean).join(', ');
}

function row(entry, index, printing = false) {
  const notes = entry.notes || [];
  const summary = notes.at(-1)?.text;
  const fullText = [
    ...notes.map(item => item.text),
    ...(entry.changesItems || []).map(item => '변동: ' + item.text),
    entry.follow && '후속 조치: ' + entry.follow + (entry.followDate ? ' (' + entry.followDate + ')' : '')
  ].filter(Boolean).join('\n');
  return '<tr><td><strong>' + esc(entry.date) + '</strong><small>' + esc(fmtTime(entry.createdAt)) + '</small></td>' +
    '<td><strong>' + esc(entry.counselor) + '</strong><small>' + esc(entry.areaName) + '</small></td>' +
    '<td><strong>' + esc(entry.address) + ' ' + esc(entry.unit) + '</strong><small>' + esc(entry.owner) + '</small></td>' +
    '<td><span class="tag" data-type="' + esc(entry.type) + '">' + esc(entry.type) + '</span><small>' + dash(entry.resultOther || entry.result) + '</small></td>' +
    '<td>' + dash(docs(entry)) + '</td><td><span class="' + (printing ? 'print-note' : 'note-preview') + '">' + dash(printing ? fullText : summary) + '</span></td>' +
    (printing ? '' : '<td class="detail-col"><button class="outline" data-index="' + index + '" aria-label="' + esc(entry.address) + ' 활동 보고 상세">상세</button></td>') + '</tr>';
}

function renderReports() {
  const entries = report.entries;
  const pages = Math.max(1, Math.ceil(entries.length / pageSize));
  $('#pager').hidden = pages <= 1;
  $('#prev').disabled = page === 0;
  $('#next').disabled = page >= pages - 1;
  $('#page-number').textContent = (page + 1) + ' / ' + pages;
  const target = $('#report-table');
  if (!entries.length) {
    showTable(target, empty('조회 조건에 맞는 활동 보고가 없습니다.'), '');
    return;
  }
  const header = ['활동일', '상담사 / 구역', '권리지번 / 소유자', '유형 / 결과', '징구 서류', '상담 내용'];
  const start = page * pageSize;
  const visible = entries.slice(start, start + pageSize).map((entry, i) => row(entry, start + i)).join('');
  const heading = header.map(label => '<th scope="col">' + esc(label) + '</th>').join('');
  showTable(target, '<table class="report-table"><thead><tr>' + heading +
    '<th scope="col" class="detail-col">보기</th></tr></thead><tbody class="screen-rows">' + visible +
    '</tbody></table>', '통합 활동 내역 표');
}

function renderStats(selector, heading, list) {
  const labels = [...metricLabels.slice(0, 2), ['first', '최초 방문'], ...metricLabels.slice(2)];
  const rows = list.map(item => '<tr><th scope="row">' + esc(item.name) + (item.archived ? ' <small>(삭제됨)</small>' : '') +
    (item.username ? '<small> · ' + esc(item.username) + '</small>' : '') + '</th>' +
    labels.map(([key]) => '<td class="number">' + esc(item[key]) + '</td>').join('') + '</tr>').join('');
  showTable($(selector), rows ? table([heading, ...labels.map(([, label]) => label)], rows)
    : empty('해당 기간의 집계가 없습니다.'), heading + ' 집계 표');
}

function renderCharts(data) {
  const consentMax = data.byArea.reduce((max, row) => Math.max(max, row.consents), 1);
  const dayMax = data.byDay.reduce((max, row) => Math.max(max, row.visits + row.updates), 1);
  const bar = (value, max, kind = '') => '<span class="chart-bar ' + kind +
    '" style="width:' + (value / max * 100) + '%"></span>';
  const chartRow = (label, value, bars) => '<li><span class="chart-label">' + esc(label) +
    '</span><span class="chart-value">' + esc(value) +
    '</span><div class="chart-track" aria-hidden="true">' + bars + '</div></li>';
  const areas = [...data.byArea].sort((a, b) => b.consents - a.consents);
  $('#consent-chart').innerHTML = areas.length
    ? '<ul class="chart-list">' + areas.map(row => chartRow(
      row.name + (row.archived ? ' (삭제됨)' : ''), row.consents + '건',
      bar(row.consents, consentMax))).join('') + '</ul>'
    : empty('조회할 구역이 없습니다.');
  const days = [...data.byDay].reverse();
  $('#activity-chart').innerHTML = days.length
    ? '<div class="chart-legend"><span>방문</span><span>단순 업데이트</span></div><ul class="chart-list">' +
      days.map(row => chartRow(row.name, '방문 ' + row.visits + '건 · 업데이트 ' + row.updates + '건',
        bar(row.visits, dayMax) + bar(row.updates, dayMax, 'update'))).join('') + '</ul>'
    : empty('해당 기간에 기록된 활동이 없습니다.');
}

function areaCheckboxes(areas, selected) {
  return Object.entries(areas).map(([key, label]) => '<label><input type="checkbox" name="areas" value="' +
    esc(key) + '"' + (selected.has(key) ? ' checked' : '') + '> ' + esc(label) + '</label>').join('')
    || '<p class="muted">사용 중인 구역이 없습니다.</p>';
}

function renderAreaManagement(data) {
  const areaFields = $('#account-areas');
  const unchecked = new Set([...areaFields.querySelectorAll('input:not(:checked)')].map(input => input.value));
  const selected = new Set(Object.keys(data.activeAreas).filter(key => !unchecked.has(key)));
  areaFields.innerHTML = areaCheckboxes(data.activeAreas, selected);
  $('#area-list').innerHTML = Object.entries(data.activeAreas).map(([key, name]) =>
    '<li><span>' + esc(name) + '</span><button type="button" class="outline" data-delete-area="' + esc(key) +
    '" aria-label="' + esc(name) + ' 삭제">삭제</button></li>').join('')
    || '<li>사용 중인 구역이 없습니다.</li>';
  const users = data.counselors.map(user => '<tr><th scope="row">' + esc(user.name) + '</th><td>' +
    esc(user.username) + '</td><td>' + esc(user.areas.map(key => data.activeAreas[key]).join(', ') || '미배정') +
    '</td><td><button type="button" class="outline assignment-button" data-assign="' + esc(user.username) +
    '" aria-label="' + esc(user.name) + ' 담당 구역 변경">변경</button></td></tr>').join('');
  $('#account-caption').textContent = '총 ' + data.counselors.length + '명';
  showTable($('#account-table'), users ? table(['이름', '아이디', '담당 구역', '배정'], users)
    : empty('등록된 상담사가 없습니다.'), '상담사 계정 목록');
}

function options(select, choices, value) {
  const all = select.options[0].cloneNode(true);
  select.replaceChildren(all, ...choices.map(([key, label]) => new Option(label, key)));
  select.value = value;
}

function applyReport(data) {
  report = data;
  page = 0;
  const {start, end, counselor, area} = data.filters;
  const filter = filterForm.elements;
  filter.start.value = start;
  filter.end.value = end;
  options(filter.counselor, data.counselors.map(user => [user.username, user.name + ' (' + user.username + ')']), counselor);
  options(filter.area, Object.entries(data.areas).map(([key, name]) =>
    [key, name + (Object.hasOwn(data.activeAreas, key) ? '' : ' (삭제됨)')]), area);
  $('#today-label').textContent = '오늘 ' + data.today;
  $('#manager').textContent = data.name;
  $('#metrics').innerHTML = metricLabels.map(([key, label]) => '<div class="metric"><span>' +
    esc(label) + '</span><strong>' + esc(data.metrics[key]) + '</strong><small>건</small></div>').join('');
  const period = start === end ? start : start + ' ~ ' + end;
  const selected = [data.counselors.find(user => user.username === counselor)?.name || counselor, data.areas[area]].filter(Boolean);
  const caption = [period, ...selected, '총 ' + data.entries.length + '건'].join(' · ');
  $('#report-caption').textContent = caption;
  $('#stats-caption').textContent = caption + ' | 방문에는 최초 방문과 재방문이 포함되며, 단순 업데이트는 별도 집계합니다.';
  renderReports();
  renderStats('#stats-counselor', '상담사', data.byCounselor);
  renderStats('#stats-area', '활동 구역', data.byArea);
  renderStats('#stats-day', '활동일', data.byDay);
  renderCharts(data);
  renderAreaManagement(data);
  $('#admin-view').hidden = false;
  $('#login-view').hidden = true;
  setView(activeView);
}

function showDetails(entry) {
  const fields = [
    ['활동일', entry.date], ['저장 일시', fmtTime(entry.createdAt)], ['상담사', entry.counselor + ' (' + entry.username + ')'],
    ['활동 구역', entry.areaName], ['권리지번 / 동·호수', [entry.address, entry.unit].filter(Boolean).join(' ')],
    ['소유자명', entry.owner], ['집전화', entry.homePhone], ['휴대전화', entry.mobilePhone],
    ['주소', [entry.postcode, entry.residentAddress, entry.addressDetail].filter(Boolean).join(' ')],
    ['활동 유형', entry.type], ['방문 결과', [entry.result, entry.resultOther].filter(Boolean).join(' · ')],
    ['개발성향', entry.preference], ['징구 서류', docs(entry)],
    ['후속 조치 / 예정일', [entry.follow, entry.followDate].filter(Boolean).join(' · ')]
  ];
  const items = (label, list = []) => '<section class="detail-notes"><h3>' + label + '</h3>' +
    (list.length ? '<ul>' + list.map(item => '<li><small>' + esc(fmtTime(item.at)) +
      '</small><p>' + esc(item.text) + '</p></li>').join('') + '</ul>' : '<p>—</p>') + '</section>';
  const photos = entry.attachments.map((name, photo) => {
    const path = '/api/admin/photo?' + new URLSearchParams({counselor: entry.username, report: entry.requestId, photo});
    return '<figure><a href="' + esc(path) + '" target="_blank" rel="noopener"><img loading="lazy" src="' +
      esc(path) + '" alt="' + esc(name) + ' 크게 보기"></a><figcaption>' + esc(name) + '</figcaption></figure>';
  }).join('');
  $('#detail-body').innerHTML = '<dl class="detail-grid">' + fields.map(([label, value]) =>
    '<div><dt>' + esc(label) + '</dt><dd>' + dash(value) + '</dd></div>').join('') + '</dl>' +
    items('상담 내용', entry.notes) + items('변동사항', entry.changesItems) +
    '<section class="detail-notes"><h3>첨부파일</h3>' + (photos ? '<div class="photo-grid">' + photos + '</div>' : '<p>—</p>') + '</section>';
  $('#detail').showModal();
}

async function loadReport(params = {}) {
  const query = new URLSearchParams(params).toString();
  const response = await request('/api/admin/reports' + (query ? '?' + query : ''));
  applyReport(await response.json());
}

function restoreLoginForm() {
  loginForm.reset();
  try {
    const username = localStorage.getItem(savedUsernameKey);
    if (username) {
      loginForm.elements.username.value = username;
      loginForm.elements.saveUsername.checked = true;
    }
  } catch {
    // Sign-in still works when browser storage is unavailable.
  }
}

function saveUsername(username) {
  try {
    if (username) localStorage.setItem(savedUsernameKey, username);
    else localStorage.removeItem(savedUsernameKey);
  } catch {
    // Browser storage is optional for sign-in.
  }
}

loginForm.elements.saveUsername.addEventListener('change', event => {
  if (!event.target.checked) saveUsername('');
});

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const {username, password, remember, saveUsername: saveOption} = loginForm.elements;
  const data = {username: username.value.trim(), password: password.value, remember: remember.checked};
  const shouldSaveUsername = saveOption.checked;
  const button = loginForm.querySelector('button');
  button.disabled = true;
  status('#login-status', '로그인 중…');
  try {
    await request('/api/admin/login', data);
    saveUsername(shouldSaveUsername && saveOption.checked ? data.username : '');
    restoreLoginForm();
    activeView = 'reports';
    await loadReport();
    status('#login-status');
  } catch (error) {
    status('#login-status', error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  try {
    await request('/api/logout', {});
    showLogin();
  } catch (error) {
    if (activeView === 'counselors') status('#account-status', error.message, true);
    else status('#report-status', error.message, true);
  }
});

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => setView(button.dataset.view));
}

async function search(params) {
  const buttons = [...filterForm.querySelectorAll('button'), $('#export'), $('#print'), $('#logout')];
  buttons.forEach(button => { button.disabled = true; });
  status('#report-status', '보고서를 불러오는 중…');
  try {
    await loadReport(params);
    status('#report-status');
  } catch (error) {
    handleError('#report-status', error);
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

filterForm.addEventListener('submit', event => {
  event.preventDefault();
  search(Object.fromEntries(new FormData(filterForm)));
});
$('#reset-today').addEventListener('click', () => search());
$('#prev').addEventListener('click', () => { page -= 1; renderReports(); });
$('#next').addEventListener('click', () => { page += 1; renderReports(); });
$('#report-table').addEventListener('click', event => {
  const button = event.target.closest('[data-index]');
  if (button && report) showDetails(report.entries[Number(button.dataset.index)]);
});
$('#detail').addEventListener('close', () => $('#detail-body').replaceChildren());

$('#export').addEventListener('click', async event => {
  const button = event.currentTarget;
  const {filters} = report;
  button.disabled = true;
  status('#report-status', '엑셀 파일을 만드는 중…');
  try {
    const response = await request('/api/admin/export?' + new URLSearchParams(filters));
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = '업무보고_' + filters.start + '_' + filters.end + '.xlsx';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status('#report-status');
  } catch (error) {
    handleError('#report-status', error);
  } finally {
    button.disabled = false;
  }
});

function preparePrint() {
  const list = $('#report-table table');
  if (!list || !report || list.querySelector('.print-rows')) return;
  const body = document.createElement('tbody');
  body.className = 'print-rows';
  body.innerHTML = report.entries.map(entry => row(entry, 0, true)).join('');
  list.append(body);
}
window.addEventListener('beforeprint', preparePrint);
window.addEventListener('afterprint', () => $('.print-rows')?.remove());
$('#print').addEventListener('click', () => { preparePrint(); window.print(); });

async function changeAreas(path, data, button, feedback, onSuccess) {
  if (areaChangePending || !report) return;
  areaChangePending = true;
  const filters = report.filters;
  button.disabled = true;
  status(feedback, '저장 중…');
  try {
    await request(path, data);
    try {
      await loadReport(filters);
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        handleError(feedback, error);
        return;
      }
      status(feedback, '변경 사항은 저장됐습니다. 목록을 새로고침해 주세요.', true);
      return;
    }
    status(feedback);
    onSuccess();
  } catch (error) {
    handleError(feedback, error);
  } finally {
    button.disabled = false;
    areaChangePending = false;
  }
}

$('#area-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const name = form.elements.name.value.trim();
  changeAreas('/api/admin/areas', {name}, form.querySelector('button'), '#area-status', () => {
    form.reset();
    status('#area-status', '“' + name + '”을 추가했습니다.');
  });
});

$('#area-list').addEventListener('click', event => {
  const button = event.target.closest('[data-delete-area]');
  if (!button || areaChangePending || !report) return;
  const id = button.dataset.deleteArea;
  const name = report.activeAreas[id];
  if (!window.confirm('“' + name + '”을 삭제할까요? 상담사 배정에서 제거되고 기존 보고서는 유지됩니다.')) return;
  changeAreas('/api/admin/areas/delete', {id}, button, '#area-status', () => {
    status('#area-status', '“' + name + '”을 삭제했습니다.');
  });
});

$('#account-table').addEventListener('click', event => {
  const button = event.target.closest('[data-assign]');
  if (!button || areaChangePending || !report) return;
  const counselor = report.counselors.find(user => user.username === button.dataset.assign);
  if (!counselor) return;
  editingCounselor = counselor.username;
  $('#assignment-counselor').textContent = counselor.name + ' (' + counselor.username + ')';
  $('#assignment-options').innerHTML = areaCheckboxes(report.activeAreas, new Set(counselor.areas));
  status('#assignment-status');
  $('#assignment-dialog').showModal();
});

$('#assignment-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const areas = new FormData(form).getAll('areas');
  changeAreas('/api/admin/counselors/areas', {username: editingCounselor, areas}, form.querySelector('button'),
    '#assignment-status', () => {
      $('#assignment-dialog').close();
      status('#account-status', '상담사의 담당 구역을 변경했습니다.');
    });
});

$('#create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  const {name, username, password, confirm} = Object.fromEntries(fields);
  const areas = fields.getAll('areas');
  if (password !== confirm) {
    status('#account-status', '비밀번호와 비밀번호 확인이 일치하지 않습니다.', true);
    return;
  }
  if (!areas.length) {
    status('#account-status', '담당 구역을 하나 이상 선택해 주세요.', true);
    return;
  }
  const button = form.querySelector('button');
  button.disabled = true;
  $('#logout').disabled = true;
  status('#account-status', '상담사 계정을 만드는 중…');
  try {
    const response = await request('/api/admin/counselors', {name, username, password, areas});
    const user = await response.json();
    form.reset();
    try {
      await loadReport(report.filters);
      status('#account-status', user.name + ' (' + user.username + ') 계정을 만들었습니다.');
    } catch (error) {
      handleError('#account-status', error);
      if (report) status('#account-status', '계정은 생성되었습니다. 목록을 새로고침해 주세요.', true);
    }
  } catch (error) {
    handleError('#account-status', error);
  } finally {
    button.disabled = false;
    $('#logout').disabled = false;
  }
});

restoreLoginForm();
const initialLogin = loginForm.querySelector('button');
initialLogin.disabled = true;
loadReport().catch(error => {
  if (error.status !== 401) status('#login-status', error.message, true);
}).finally(() => { initialLogin.disabled = false; });
