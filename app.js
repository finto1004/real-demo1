'use strict';
const $=s=>document.querySelector(s);
const demoAreas=[{id:'a',name:'영화동 A구역',description:'영화동 · 1구역'}, {id:'b',name:'영화동 B구역',description:'영화동 · 2구역'}, {id:'c',name:'영화동 C구역',description:'영화동 · 3구역'}];
const isDemo=location.pathname.endsWith('/demo.html');
const storageKey='work-report-sample-v1';
const workDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'});
const nowDate=()=>workDate.format(new Date());
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function sampleEntries(){const today=nowDate();const previous=new Date();previous.setDate(previous.getDate()-1);const yesterday=[previous.getFullYear(),String(previous.getMonth()+1).padStart(2,'0'),String(previous.getDate()).padStart(2,'0')].join('-');const time=d=>new Date(d+'T10:30:00').getTime();return [
{targetId:'sample-a',area:'a',date:yesterday,type:'최초 방문',address:'가상 123-45',unit:'101호',owner:'예시 주민',result:'상담 완료',consent:false,privacy:false,identity:false,previousConsent:false,preference:'중',notes:[{text:'사업 내용을 설명하고 다음 방문을 약속했습니다.',at:time(yesterday)}],changesItems:[{text:'연락 방법을 다시 확인하기로 했습니다.',at:time(yesterday)}],createdAt:time(yesterday)},
{targetId:'sample-a',area:'a',date:today,type:'재방문',address:'가상 123-45',unit:'101호',owner:'예시 주민',result:'상담 완료',consent:true,privacy:false,identity:false,previousConsent:false,preference:'상',notes:[{text:'동의서를 받았습니다.',at:time(today)}],changesItems:[],createdAt:time(today)}
]}
let entries=[];if(isDemo)try{const raw=localStorage.getItem(storageKey);const saved=raw===null&&isDemo?sampleEntries():JSON.parse(raw||'[]');entries=Array.isArray(saved)?saved:[]}catch{entries=isDemo?sampleEntries():[]}
if(isDemo){const samples=sampleEntries();const today=nowDate();const t=Date.now();samples.push({targetId:'sample-b',area:'a',date:today,type:'최초 방문',address:'가상 234-56',unit:'202호',owner:'가상 김소유',result:'부재',consent:false,privacy:false,identity:false,previousConsent:false,preference:'미확인',notes:[{text:'부재로 안내문을 남겼습니다.',at:t-3600000}],changesItems:[],createdAt:t-3600000},{targetId:'sample-c',area:'a',date:today,type:'단순 업데이트',address:'가상 345-67',unit:'301호',owner:'가상 이소유',result:'',consent:false,privacy:true,identity:false,previousConsent:false,preference:'중',notes:[{text:'전화로 서류 준비 상황을 확인했습니다.',at:t-1800000}],changesItems:[{text:'다음 연락 일정을 확인했습니다.',at:t-1800000}],createdAt:t-1800000});for(const sample of samples){if(!entries.some(x=>x.targetId===sample.targetId&&x.date===sample.date&&x.type===sample.type))entries.push(sample)}}
let area=null;let linkedId=null;let draftNotes=[];let draftChanges=[];let historyFilter={start:'',end:'',query:'',type:'all',area:null};
let requestId=null;
async function api(path,body){
 let response;
 try{
  response=await fetch('/api/'+path,body===undefined?{cache:'no-store'}:{
   method:'POST',headers:{'Content-Type':'application/json','X-Work-Report':'1'},body:JSON.stringify(body)
  });
 }catch{throw new Error('업무보고 서버에 연결하지 못했습니다. 연결을 확인해 주세요.')}
 const data=await response.json().catch(()=>null);
 if(!response.ok||!data){
  const error=new Error(data?.error||'업무보고 서버를 통해 접속해 주세요.');
  error.status=response.status;
  throw error;
 }
 return data;
}
function startWorkspace(data){
 entries=data.entries;
 allowedAreas=data.areaNames
   ? Object.entries(data.areaNames).map(([id,name])=>({id,name}))
   : demoAreas.filter(item=>data.areas?.includes(item.id));
 renderAreaOptions();
 area=null;
 $('#user-name').textContent=data.name;
 $('#user-initial').textContent=Array.from(data.name)[0]||'';
 resetForm();render();show('workspace');
}
const fmtTime=value=>{let d=new Date(value);return Number.isNaN(d.getTime())?'시간 미상':new Intl.DateTimeFormat('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(d)};
function itemsFor(e,kind){const list=kind==='note'?e.notes:e.changesItems;if(Array.isArray(list))return list;const legacy=kind==='note'?e.note:e.changes;return legacy?[{text:legacy,at:e.createdAt}]:[]}
function itemMarkup(item,style=''){return '<div class="entry-item '+style+'"><p>'+esc(item.text)+'</p><time>'+esc(fmtTime(item.at))+'</time></div>'}
function refreshDraft(){ $('#note-draft').innerHTML=draftNotes.map(x=>itemMarkup(x,'draft-item')).join('');$('#changes-draft').innerHTML=draftChanges.map(x=>itemMarkup(x,'draft-item')).join('') }
function appendInput(kind){const input=form.elements[kind],value=input.value.trim();if(!value)return false;(kind==='note'?draftNotes:draftChanges).push({text:value,at:Date.now()});input.value='';refreshDraft();return true}
function showHistory(id){const group=getGroup(id);for(const kind of ['note','changes']){const items=group.flatMap(e=>itemsFor(e,kind)).sort((a,b)=>b.at-a.at);$('#'+kind+'-history').innerHTML=items.length?'<div class="entry-label">이전에 기록한 내용</div>'+items.map(x=>itemMarkup(x)).join(''):''}}
const form=$('#activity-form');
function show(name){document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active',s.id===name));document.body.classList.toggle('login-mode',name==='login');$('#header-actions').hidden=name==='login';window.scrollTo(0,0)}
function resetForm(){requestId=null;clearPreview();form.reset();form.elements.area.value=area?area.id:'';form.elements.date.value=nowDate();form.elements.date.min=nowDate();form.elements.date.max=nowDate();linkedId=null;draftNotes=[];draftChanges=[];refreshDraft();$('#note-history').innerHTML='';$('#changes-history').innerHTML='';$('#attachment-preview').innerHTML='';closePostcode();form.elements.postcode.readOnly=true;form.elements.residentAddress.readOnly=true;$('#address-error').textContent='';$('#linked').hidden=true;$('#form-heading').textContent='활동 내용 작성';$('#feedback').textContent='';syncType();phoneNames.forEach(syncPhone)}
function syncType(){const simple=form.elements.type.value==='단순 업데이트';$('#visit-result').hidden=simple;form.querySelectorAll('[name=result]').forEach(el=>{el.required=!simple;if(simple)el.checked=false});syncOther()}
function syncOther(){const resultOther=!$('#visit-result').hidden&&form.elements.result.value==='기타';const docOther=form.elements.other.checked;$('#result-other-field').hidden=!resultOther;$('#document-other-field').hidden=!docOther;form.elements.resultOther.required=resultOther;form.elements.otherDocument.required=docOther}
function getGroup(id){return entries.filter(e=>e.targetId===id).sort((a,b)=>b.date.localeCompare(a.date)||b.createdAt-a.createdAt)}
function selectArea(id){area=allowedAreas.find(x=>x.id===id)||null;$('#search').value='';resetForm();render()}
function safeSave(){try{localStorage.setItem(storageKey,JSON.stringify(entries));return true}catch{return false}}
function render(){
 const selectedTarget=$('#target-select').value;const targetList=area?[...new Set(entries.filter(x=>x.area===area.id).map(x=>x.targetId))].map(id=>getGroup(id)[0]):[];$('#target-select').innerHTML='<option value="">새 대상 작성</option>'+targetList.map(x=>'<option value="'+esc(x.targetId)+'">'+esc(x.address+' '+(x.unit||'')+' · '+x.owner)+'</option>').join('');$('#target-select').value=targetList.some(x=>x.targetId===selectedTarget)?selectedTarget:'';
 const visible=area?entries.filter(e=>e.area===area.id):[];const today=visible.filter(e=>e.date===nowDate());
 $('#visits-count').innerHTML=String(today.filter(e=>e.type!=='단순 업데이트').length)+' <small>건</small>';
 $('#revisits-count').innerHTML=String(today.filter(e=>e.type==='재방문').length)+' <small>건</small>';
 $('#updates-count').innerHTML=String(today.filter(e=>e.type==='단순 업데이트').length)+' <small>건</small>';
 $('#consent-count').innerHTML=String(today.filter(e=>e.consent&&!e.previousConsent).length)+' <small>건</small>';
 const {start:startDate,end:endDate,query,type:selectedType,area:historyArea}=historyFilter;
 const invalidRange=Boolean(startDate&&endDate&&startDate>endDate);
 const historyVisible=historyArea?entries.filter(e=>e.area===historyArea):entries;
 const matchesType=x=>selectedType==='all'||(selectedType==='visit'&&x.type!=='단순 업데이트')||(selectedType==='revisit'&&x.type==='재방문')||(selectedType==='update'&&x.type==='단순 업데이트')||(selectedType==='consent'&&x.consent&&!x.previousConsent);
 const shown=historyVisible.filter(x=>!invalidRange&&(!startDate||x.date>=startDate)&&(!endDate||x.date<=endDate)&&matchesType(x)&&(x.address+' '+(x.unit||'')+' '+x.owner).toLowerCase().includes(query));
 $('#active-filter').hidden=selectedType==='all';
 $('#active-filter').textContent=selectedType==='all'?'':({visit:'선택한 구역의 오늘 방문',revisit:'선택한 구역의 오늘 재방문',update:'선택한 구역의 오늘 단순 업데이트',consent:'선택한 구역의 오늘 동의서 징구'}[selectedType]||'')+' 기록입니다. 검색하면 전체 활동을 조회합니다.';
 $('#record-total').textContent=shown.length+'건';
 const allRows=shown.sort((a,b)=>b.date.localeCompare(a.date)||b.createdAt-a.createdAt);
 const cellItems=(x,kind)=>{const list=itemsFor(x,kind);return list.length?list.map(i=>'<div class="history-entry">'+esc(i.text)+'<time class="item-time">'+esc(fmtTime(i.at))+'</time></div>').join(''):'—'};
 const imageItems=x=>Array.isArray(x.attachments)&&x.attachments.length?'<div class="attachment-list">'+x.attachments.filter(a=>/^data:image\/(png|jpeg|gif|webp|bmp|avif);base64,/i.test(a.data)).map(a=>'<figure><img src="'+esc(a.data)+'" alt="'+esc(a.name)+'"><figcaption>'+esc(a.name)+'</figcaption></figure>').join('')+'</div>':'—';
 const dates=[...new Set(allRows.map(x=>x.date))];
 const makeRow=(x,i)=>'<tr><td data-label="번호"><span class="history-number">'+(i+1)+'</span></td><td data-label="활동일">'+esc(x.date)+'</td><td data-label="대상"><strong>'+esc(x.address)+' '+esc(x.unit||'')+'</strong><br>'+esc(x.owner)+(x.homePhone?'<br>집전화: '+esc(x.homePhone):'')+(x.mobilePhone?'<br>휴대전화: '+esc(x.mobilePhone):'')+(x.residentAddress?'<br>주소: '+esc([x.postcode,x.residentAddress,x.addressDetail].filter(Boolean).join(' ')):'')+'</td><td data-label="활동 / 결과">'+esc(x.type)+'<br>'+esc(x.result||'방문 없음')+(x.resultOther?' ('+esc(x.resultOther)+')':'')+'</td><td data-label="상담 내용"><div class="history-content">'+cellItems(x,'note')+'</div></td><td data-label="변동사항"><div class="history-content">'+cellItems(x,'changes')+'</div></td><td data-label="서류 징구">'+esc([x.consent?'동의서':'',x.privacy?'개인정보 관련 서류':'',x.identity?'신분증 관련 자료':'',x.other?'기타'+(x.otherDocument?' ('+x.otherDocument+')':''):''].filter(Boolean).join(', ')||'확인 없음')+'</td><td data-label="첨부">'+imageItems(x)+'</td></tr>';
 $('#records').innerHTML=allRows.length?dates.map(date=>{const rows=allRows.filter(x=>x.date===date);return '<section class="history-day"><div class="history-day-heading"><strong>'+esc(date)+'</strong><span>'+rows.length+'건</span></div><div class="history-table-wrap"><table class="history-table"><thead><tr><th>번호</th><th>활동일</th><th>권리지번 / 소유자</th><th>활동 / 결과</th><th>상담 내용</th><th>변동사항</th><th>서류 징구</th><th>첨부</th></tr></thead><tbody>'+rows.map(makeRow).join('')+'</tbody></table></div></section>'}).join(''):'<div class="empty">'+(invalidRange?'날짜 범위를 확인해 주세요.':'해당 조건의 활동 이력이 없습니다.')+'</div>';

}
$('#login-form').addEventListener('submit',async e=>{
 e.preventDefault();
 const login=e.currentTarget;
 const button=login.querySelector('[type=submit]');
 button.disabled=true;
 $('#login-error').textContent='';
 try{
  const data=await api('login',{username:login.elements.id.value.trim(),password:login.elements.password.value,remember:login.elements.remember.checked});
  login.reset();startWorkspace(data);
 }catch(error){$('#login-error').textContent=error.message}
 finally{button.disabled=false}
});
$('#logout')?.addEventListener('click',async ()=>{
 if(saving)return;
 if(formIsDirty()&&!confirm('작성 중인 내용을 지우고 로그아웃할까요?'))return;
 try{
  await api('logout',{});
  entries=[];area=null;resetForm();render();show('login');
 }catch(error){alert(error.message)}
});
let allowedAreas=demoAreas;
function renderAreaOptions(){
 const placeholder=allowedAreas.length?'구역을 선택해 주세요':'배정된 구역이 없습니다';
 $('#area-select').replaceChildren(new Option(placeholder,''),...allowedAreas.map(x=>new Option(x.name,x.id)));
}
renderAreaOptions();
function openHistory(type='all'){$('#history-status').hidden=true;const day=type==='all'?'':nowDate();$('#history-start').value=day;$('#history-end').value=day;$('#search').value='';$('#date-error').hidden=true;historyFilter={start:day,end:day,query:'',type,area:type==='all'?null:(area?area.id:'__none__')};render();show('history-page')}
document.querySelectorAll('.open-history').forEach(button=>button.addEventListener('click',()=>openHistory()));
document.querySelectorAll('.summary-item').forEach(button=>button.addEventListener('click',()=>openHistory(button.dataset.stat)));
$('#back-to-work').addEventListener('click',()=>show('workspace'));
$('#area-select').addEventListener('change',e=>{const next=e.target.value;if(formIsDirty()&&!confirm('작성 중인 내용을 지우고 구역을 변경할까요?')){e.target.value=area?area.id:'';return}selectArea(next)});

function formIsDirty(){return Boolean(draftNotes.length||draftChanges.length||form.elements.address.value||form.elements.unit.value||form.elements.owner.value||phoneParts('homePhone').some(input=>input.value)||phoneParts('mobilePhone').some(input=>input.value)||form.elements.postcode.value||form.elements.residentAddress.value||form.elements.addressDetail.value||form.elements.resultOther.value||form.elements.otherDocument.value||form.elements.note.value||form.elements.changes.value||form.elements.follow.value||form.elements.followDate.value||form.elements.consent.checked||form.elements.privacy.checked||form.elements.identity.checked||form.elements.other.checked||form.elements.attachments.files.length||form.elements.result.value||form.elements.preference.value!=='미확인'||form.elements.type.value!=='최초 방문')}
$('#clear-form').addEventListener('click',()=>{if(!formIsDirty()||confirm('작성 중인 내용을 초기화할까요?'))resetForm()});
form.elements.type.addEventListener('change',syncType);
form.querySelectorAll('[name=result]').forEach(el=>el.addEventListener('change',syncOther));form.elements.other.addEventListener('change',syncOther);
const postcodeDialog=$('#postcode-wrap');
function closePostcode(){if(postcodeDialog.open)postcodeDialog.close();$('#postcode-frame').textContent=''}
function allowManualAddress(message){closePostcode();$('#address-error').textContent=message;form.elements.postcode.readOnly=false;form.elements.residentAddress.readOnly=false;form.elements.residentAddress.focus()}
function openPostcode(){
 const error=$('#address-error');error.textContent='';
 if(!window.kakao?.Postcode){allowManualAddress('주소 검색을 불러오지 못했습니다. 우편번호와 주소를 직접 입력해 주세요.');return}
 try{
  closePostcode();
  postcodeDialog.showModal();
  new window.kakao.Postcode({oncomplete:data=>{
   form.elements.postcode.value=data.zonecode||'';
   form.elements.residentAddress.value=(data.userSelectedType==='R'?data.roadAddress:data.jibunAddress)||data.address||'';
   form.elements.postcode.readOnly=true;form.elements.residentAddress.readOnly=true;
   closePostcode();form.elements.addressDetail.focus()
  },width:'100%',height:'100%'}).embed($('#postcode-frame'),{autoClose:false})
 }catch{allowManualAddress('주소 검색을 열지 못했습니다. 우편번호와 주소를 직접 입력해 주세요.')}
}
$('#postcode-close').addEventListener('click',closePostcode);
postcodeDialog.addEventListener('cancel',e=>{e.preventDefault();closePostcode()});
$('#address-search').addEventListener('click',openPostcode);
form.elements.postcode.addEventListener('click',()=>{if(form.elements.postcode.readOnly)openPostcode()});
form.elements.postcode.addEventListener('keydown',e=>{if(form.elements.postcode.readOnly&&(e.key==='Enter'||e.key===' ')){e.preventDefault();openPostcode()}});
const phoneNames=['homePhone','mobilePhone'];
function phoneParts(name){return ['Prefix','Middle','Last'].map(part=>form.elements[name+part])}
function phoneValue(name){const values=phoneParts(name).map(input=>input.value);return values.some(Boolean)?values.join('-'):''}
function fillPhone(name,value){const text=String(value||'');const digits=text.replace(/[^0-9]/g,'');const pieces=text.trim().split(/[\s-]+/);const prefix=name==='mobilePhone'?3:digits.startsWith('02')?2:digits.length===12?4:3;
 const parts=pieces.length===3?pieces.map(x=>x.replace(/[^0-9]/g,'')):[digits.slice(0,prefix),digits.slice(prefix,Math.max(prefix,digits.length-4)),digits.slice(Math.max(prefix,digits.length-4))];
 phoneParts(name).forEach((input,i)=>{input.value=parts[i]||''});syncPhone(name)
}
function syncPhone(name){const parts=phoneParts(name);const started=parts.some(input=>input.value);parts.forEach(input=>{input.required=started})}
for(const name of phoneNames){const parts=phoneParts(name);for(const input of parts){
 input.addEventListener('input',()=>{input.value=input.value.replace(/[^0-9]/g,'');syncPhone(name)});
 input.addEventListener('paste',e=>{const value=e.clipboardData?.getData('text')||'';const count=value.replace(/[^0-9]/g,'').length;if(count>=9&&count<=12){e.preventDefault();fillPhone(name,value)}})
}}
document.querySelectorAll('.add-entry').forEach(button=>button.addEventListener('click',()=>{if(!appendInput(button.dataset.kind)){const input=form.elements[button.dataset.kind];input.focus();$('#feedback').textContent='내용을 입력한 후 추가해 주세요.'}else{$('#feedback').textContent='추가된 내용은 활동 기록 저장 시 함께 저장됩니다.'}}));
$('#search-history').addEventListener('click',()=>{const start=$('#history-start').value,end=$('#history-end').value;if(start&&end&&start>end){$('#date-error').hidden=false;return}$('#date-error').hidden=true;historyFilter={start,end,query:$('#search').value.trim().toLowerCase(),type:'all',area:null};render()});
$('#search').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('#search-history').click()}});
$('#target-select').addEventListener('change',e=>{const id=e.target.value;if(!id)return;if(formIsDirty()&&!confirm('작성 중인 내용을 지우고 기존 대상을 불러올까요?')){e.target.value=linkedId||'';return}const last=getGroup(id)[0];if(!last)return;resetForm();linkedId=id;$('#target-select').value=id;showHistory(id);form.elements.address.value=last.address;form.elements.unit.value=last.unit;form.elements.owner.value=last.owner;for(const name of ['postcode','residentAddress','addressDetail'])form.elements[name].value=last[name]||'';phoneNames.forEach(name=>fillPhone(name,last[name]));form.elements.type.value='재방문';form.elements.consent.checked=last.consent;form.elements.privacy.checked=last.privacy;form.elements.identity.checked=last.identity;form.elements.other.checked=Boolean(last.other);form.elements.otherDocument.value=last.otherDocument||'';form.elements.preference.value=last.preference;$('#linked').textContent=last.address+' '+(last.unit||'')+' · '+last.owner+' 대상의 오늘 활동을 새로 기록합니다. 이전 기록은 변경되지 않습니다.';$('#linked').hidden=false;$('#form-heading').textContent='기존 대상의 오늘 활동';syncType()});

const fileInput=$('#attachments');
let previewUrls=[];
function clearPreview(){previewUrls.forEach(u=>URL.revokeObjectURL(u));previewUrls=[];$('#attachment-preview').innerHTML=''}
fileInput.addEventListener('change',()=>{clearPreview();const files=[...fileInput.files];if(files.length>5||files.some(f=>!/^image\/(png|jpeg|gif|webp|bmp|avif)$/i.test(f.type))){fileInput.value='';$('#attachment-preview').innerHTML='<span class="attachment-error">지원되는 이미지 파일을 최대 5장까지 선택해 주세요.</span>';return}$('#attachment-preview').innerHTML=files.map(f=>{const url=URL.createObjectURL(f);previewUrls.push(url);return '<figure><img src="'+url+'" alt=""><figcaption>'+esc(f.name)+'</figcaption></figure>'}).join('')});
function readFile(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:file.name,data:reader.result});reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file)})}
async function compressImage(file){
 if(file.size<=250*1024&&!/image\/gif/i.test(file.type))return readFile(file);
 const url=URL.createObjectURL(file);
 try{const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('이미지를 열 수 없습니다'));img.src=url});const max=1600;let scale=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));const canvas=document.createElement('canvas');const context=canvas.getContext('2d');if(!context)throw new Error('압축을 지원하지 않습니다');let blob=null;
 for(let attempt=0;attempt<6;attempt++){canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(img,0,0,canvas.width,canvas.height);blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',Math.max(.45,.82-attempt*.075)));if(!blob)throw new Error('이미지 압축에 실패했습니다');if(blob.size<=280*1024)break;scale*=.8}
 if(blob.size>280*1024)throw new Error('압축 후에도 이미지 용량이 큽니다');const converted=new File([blob],file.name.replace(/\.[^.]+$/,'')+'.jpg',{type:'image/jpeg'});return await readFile(converted)
 }finally{URL.revokeObjectURL(url)}
}
let saving=false;
form.addEventListener('submit',async e=>{e.preventDefault();if(saving)return;if(!area){$('#feedback').textContent='활동 구역을 선택해 주세요.';return}if(e.currentTarget.elements.date.value!==nowDate()){$('#feedback').textContent='오늘 날짜의 활동만 새로 기록할 수 있습니다.';return}const f=e.currentTarget;const files=[...fileInput.files];if(files.length>5||files.some(file=>!/^image\/(png|jpeg|gif|webp|bmp|avif)$/i.test(file.type))){$('#feedback').textContent='지원되는 이미지 파일을 최대 5장까지 선택해 주세요.';return}let attachments=[];saving=true;f.inert=true;const saveButton=f.querySelector('[type=submit]');saveButton.disabled=true;$('#feedback').textContent=files.length?'사진을 압축하고 저장하고 있습니다.':'';try{attachments=await Promise.all(files.map(compressImage))}catch{saving=false;f.inert=false;saveButton.disabled=false;$('#feedback').textContent='이미지 압축에 실패했습니다. 다른 사진을 선택해 주세요.';return}appendInput('note');appendInput('changes');const previous=linkedId?getGroup(linkedId)[0]:null;const targetId=linkedId||('target-'+Date.now()+'-'+Math.random().toString(36).slice(2,8));const entry={targetId,area:area.id,date:f.elements.date.value,type:f.elements.type.value,address:f.elements.address.value.trim(),unit:f.elements.unit.value.trim(),owner:f.elements.owner.value.trim(),homePhone:phoneValue('homePhone'),mobilePhone:phoneValue('mobilePhone'),postcode:f.elements.postcode.value.trim(),residentAddress:f.elements.residentAddress.value.trim(),addressDetail:f.elements.addressDetail.value.trim(),resultOther:f.elements.result.value==='기타'?f.elements.resultOther.value.trim():'',otherDocument:f.elements.other.checked?f.elements.otherDocument.value.trim():'',result:f.elements.type.value==='단순 업데이트'?'':f.elements.result.value,consent:f.elements.consent.checked,privacy:f.elements.privacy.checked,identity:f.elements.identity.checked,other:f.elements.other.checked,attachments,previousConsent:previous?previous.consent:false,preference:f.elements.preference.value,notes:[...draftNotes],changesItems:[...draftChanges],follow:f.elements.follow.value,followDate:f.elements.followDate.value,createdAt:Date.now()};try{
 if(!entry.address||!entry.owner)throw new Error('권리지번과 소유자명을 입력해 주세요.');
 if(isDemo){
  entries.push(entry);
  if(!safeSave()){
   entries.pop();
   throw new Error('저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.');
  }
 }else{
  requestId??=crypto.randomUUID();
  const saved=await api('entries',{...entry,targetId:linkedId||'',requestId});
  entries=saved.entries;
 }
}catch(error){
 $('#feedback').textContent=error.message;
 return;
}finally{
 saving=false;f.inert=false;saveButton.disabled=false;
}
clearPreview();resetForm();const day=entry.date;$('#history-start').value=day;$('#history-end').value=day;$('#search').value='';$('#date-error').hidden=true;historyFilter={start:day,end:day,query:'',type:'all',area:null};$('#history-status').textContent='활동 기록을 저장했습니다. 오늘의 활동 이력을 확인해 주세요.';$('#history-status').hidden=false;render();show('history-page')});
if(isDemo){
 try {
   const settings=JSON.parse(localStorage.getItem('work-report-admin-preview-v1'));
   if(settings?.activeAreas) allowedAreas=Object.entries(settings.activeAreas).map(([id,name])=>({id,name}));
 } catch {}
 renderAreaOptions();
 area=allowedAreas[0]||null;resetForm();render();show('workspace');
}else{
 resetForm();render();show('login');
 api('entries').then(startWorkspace).catch(error=>{
  if(error.status!==401)$('#login-error').textContent=error.message;
 });
}

