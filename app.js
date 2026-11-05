'use strict';
const $=s=>document.querySelector(s);
const demoAreas=[{id:'a',name:'영화동 A구역',description:'영화동 · 1구역'}, {id:'b',name:'영화동 B구역',description:'영화동 · 2구역'}, {id:'c',name:'영화동 C구역',description:'영화동 · 3구역'}];
const storageKey='ondongne-counselor-v2';
const nowDate=()=>{const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let entries=[];try{const saved=JSON.parse(localStorage.getItem(storageKey)||'[]');entries=Array.isArray(saved)?saved:[]}catch{}
let area=null;let linkedId=null;
const form=$('#activity-form');
function show(name){document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active',s.id===name));document.body.classList.toggle('login-mode',name==='login');$('#header-actions').hidden=name==='login';window.scrollTo(0,0)}
function resetForm(){form.reset();form.elements.area.value=area?area.id:'';form.elements.date.value=nowDate();linkedId=null;$('#linked').hidden=true;$('#form-heading').textContent='활동 내용 작성';$('#feedback').textContent='';syncType()}
function syncType(){const simple=form.elements.type.value==='단순 업데이트';$('#visit-result').hidden=simple;form.querySelectorAll('[name=result]').forEach(el=>{el.required=!simple; if(simple)el.checked=false})}
function getGroup(id){return entries.filter(e=>e.targetId===id).sort((a,b)=>b.date.localeCompare(a.date)||b.createdAt-a.createdAt)}
function selectArea(id){area=demoAreas.find(x=>x.id===id)||null;$('#search').value='';resetForm();render()}
function safeSave(){try{localStorage.setItem(storageKey,JSON.stringify(entries));return true}catch{return false}}
function render(){
 const visible=area?entries.filter(e=>e.area===area.id):[];const today=visible.filter(e=>e.date===nowDate());
 $('#visits-count').innerHTML=String(today.filter(e=>e.type!=='단순 업데이트').length)+' <small>건</small>';
 $('#revisits-count').innerHTML=String(today.filter(e=>e.type==='재방문').length)+' <small>건</small>';
 $('#updates-count').innerHTML=String(today.filter(e=>e.type==='단순 업데이트').length)+' <small>건</small>';
 $('#consent-count').innerHTML=String(today.filter(e=>e.consent&&!e.previousConsent).length)+' <small>건</small>';
 const groups=[...new Set(visible.map(e=>e.targetId))].map(id=>getGroup(id)).sort((a,b)=>b[0].date.localeCompare(a[0].date)||b[0].createdAt-a[0].createdAt);
 const query=$('#search').value.trim().toLowerCase();
 const shown=groups.filter(g=>(g[0].address+' '+g[0].unit+' '+g[0].owner).toLowerCase().includes(query));
 $('#record-total').textContent=groups.length+'명';
 $('#records').innerHTML=shown.length?shown.map(g=>{const e=g[0];return '<article class="record"><div class="record-top"><strong>'+esc(e.address)+' '+esc(e.unit)+'</strong><span class="tag '+(e.type==='단순 업데이트'?'update':'')+'">'+esc(e.type)+'</span></div><small>'+esc(e.owner)+' · 최근 '+esc(e.date)+' · '+g.length+'회 기록</small><p>'+esc(e.note||'상담 내용 없음')+'</p><details><summary class="record-action">활동 이력 보기</summary>'+g.map(x=>'<p>'+esc(x.date)+' · '+esc(x.type)+' · '+esc(x.result||'방문 없음')+'<br>'+esc(x.note||'상담 내용 없음')+'</p>').join('')+'</details><button type="button" class="record-action continue" data-target="'+esc(e.targetId)+'">이어서 기록 →</button></article>'}).join(''):'<div class="empty">'+(query?'검색 결과가 없습니다.':!area?'활동 구역을 선택해 주세요.':'아직 작성한 활동이 없습니다.<br>첫 활동을 기록해 보세요.')+'</div>';
}
$('#login-form').addEventListener('submit',e=>{e.preventDefault();let f=e.currentTarget;if(f.elements.id.value.trim()==='demo'&&f.elements.password.value==='demo'){$('#login-error').textContent='';f.reset();area=null;resetForm();render();show('workspace')}else{$('#login-error').textContent='시안 체험용 아이디와 비밀번호를 확인해 주세요.'}});
$('#area-select').innerHTML='<option value="">구역을 선택해 주세요</option>'+demoAreas.map(x=>'<option value="'+x.id+'">'+x.name+'</option>').join('');
$('#area-select').addEventListener('change',e=>{const next=e.target.value;if(formIsDirty()&&!confirm('작성 중인 내용을 지우고 구역을 변경할까요?')){e.target.value=area?area.id:'';return}selectArea(next)});
$('#logout').addEventListener('click',()=>{if(!formIsDirty()||confirm('작성 중인 내용을 지우고 로그아웃할까요?')){resetForm();area=null;show('login')}});
function formIsDirty(){return Boolean(form.elements.address.value||form.elements.unit.value||form.elements.owner.value||form.elements.note.value||form.elements.changes.value||form.elements.follow.value||form.elements.followDate.value||form.elements.consent.checked||form.elements.privacy.checked||form.elements.identity.checked||form.elements.result.value||form.elements.preference.value!=='미확인'||form.elements.type.value!=='최초 방문')}
$('#clear-form').addEventListener('click',()=>{if(!formIsDirty()||confirm('작성 중인 내용을 초기화할까요?'))resetForm()});
form.elements.type.addEventListener('change',syncType);
$('#search').addEventListener('input',render);
$('#records').addEventListener('click',e=>{const button=e.target.closest('.continue');if(!button)return;if(formIsDirty()&&!confirm('작성 중인 내용을 지우고 선택한 대상의 이력을 불러올까요?'))return;const last=getGroup(button.dataset.target)[0];if(!last)return;resetForm();linkedId=last.targetId;form.elements.address.value=last.address;form.elements.unit.value=last.unit;form.elements.owner.value=last.owner;form.elements.type.value='재방문';form.elements.consent.checked=last.consent;form.elements.privacy.checked=last.privacy;form.elements.identity.checked=last.identity;form.elements.preference.value=last.preference;$('#linked').textContent=last.address+' '+last.unit+' · '+last.owner+'의 이력을 이어서 작성합니다.';$('#linked').hidden=false;$('#form-heading').textContent='기존 대상 업데이트';syncType();form.scrollIntoView({behavior:'smooth',block:'start'})});
form.addEventListener('submit',e=>{e.preventDefault();if(!area){$('#feedback').textContent='활동 구역을 선택해 주세요.';return}const f=e.currentTarget;const previous=linkedId?getGroup(linkedId)[0]:null;const targetId=linkedId||('target-'+Date.now()+'-'+Math.random().toString(36).slice(2,8));const entry={targetId,area:area.id,date:f.elements.date.value,type:f.elements.type.value,address:f.elements.address.value.trim(),unit:f.elements.unit.value.trim(),owner:f.elements.owner.value.trim(),result:f.elements.type.value==='단순 업데이트'?'':f.elements.result.value,consent:f.elements.consent.checked,privacy:f.elements.privacy.checked,identity:f.elements.identity.checked,previousConsent:previous?previous.consent:false,preference:f.elements.preference.value,note:f.elements.note.value.trim(),changes:f.elements.changes.value.trim(),follow:f.elements.follow.value,followDate:f.elements.followDate.value,createdAt:Date.now()};if(!entry.address||!entry.owner){$('#feedback').textContent='권리지번과 소유자명을 입력해 주세요.';return}entries.push(entry);if(!safeSave()){entries.pop();$('#feedback').textContent='저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.';return}resetForm();$('#feedback').textContent='활동 기록을 저장했습니다.';render()});
resetForm();
