// Inject the Ranked Management panel into the existing subscription dashboard.
// No browser-side admin secret is exposed; requests use the existing HttpOnly session.
export function enhanceSubscriptionAdminRankedHtml(html) {
  let output = String(html);
  output = output.replace(
    '<button class="nav" data-view="accounts">Accounts</button>',
    '<button class="nav" data-view="accounts">Accounts</button>\n      <button class="nav" data-view="ranked">Ranked Management</button>'
  );
  output = output.replace(
    '    <section id="view-history" class="hidden">',
    `    <section id="view-ranked" class="hidden">
      <div class="section">
        <div class="sectionhead"><h2>Ranked account management</h2><span>Changes are audited · Requires an established ladder rating</span></div>
        <div class="toolbar"><input id="rankedSearch" placeholder="Filter by account ID, email or name (optional)" autocomplete="off" type="search" />
          <button type="button" id="rankedSearchButton">Search</button></div>\n        <div class="toolbar" style="justify-content:flex-end;padding:4px 12px 9px"><label>Sort accounts <select id="rankedSort"><option value="newest">Newest accounts</option><option value="highest">Highest ranked first</option><option value="lowest">Lowest ranked first</option></select></label></div>
        <div id="rankedSearchResults" class="tablewrap"><div class="loading">Loading accounts...</div></div>\n        <div class="toolbar" id="rankedPaging" style="justify-content:flex-end;align-items:center;margin-top:10px"><span id="rankedPageInfo" class="muted"></span><button type="button" id="rankedPrevious">Previous</button><button type="button" id="rankedNext">Next</button></div>
      </div>
      <div id="rankedSelected" class="section hidden">
        <div class="sectionhead"><h2 id="rankedAccountTitle">Selected account</h2><span id="rankedState"></span></div>
        <div id="rankedProfile" class="toolbar"></div>
        <div class="toolbar">
          <label>Action <select id="rankedAction">
            <option value="adjust">Add / subtract RP</option>
            <option value="set">Set rank and RP</option>
            <option value="restore">Restore failed debate RP</option>
            <option value="reset">Reset ladder rating to Initiate III · 0 RP</option>
          </select></label>
          <label id="rankedPointsBox">RP change <input id="rankedPoints" type="number" min="-500" max="500" step="1" value="10" /></label>
          <label id="rankedSetBox" class="hidden">Rank <select id="rankedRank">
            <option value="initiate">Initiate</option><option value="student">Student</option>
            <option value="dialectician">Dialectician</option><option value="logician">Logician</option>
            <option value="scholar">Scholar</option><option value="sage">Sage</option>
            <option value="philosopher">Philosopher</option><option value="alchemist">The Alchemist</option>
          </select>
          Division <select id="rankedDivision"><option value="3">III</option><option value="2">II</option><option value="1">I</option></select>
          RP <input id="rankedExactRP" type="number" min="0" max="99" step="1" value="0" /></label>
          <label id="rankedRestoreBox" class="hidden">Failed ladder debate <select id="rankedFailedDebate"></select></label>
        </div>
        <div class="toolbar"><input id="rankedReason" type="text" maxlength="500" placeholder="Required reason (at least 8 characters)" style="min-width:290px;flex:1" />
          <button id="rankedApply" type="button">Review and apply</button></div>
        <p class="muted">Changes cannot be made during an active Ranked debate. Resetting the ladder rating does not erase placements or match history. All changes are recorded in the Ranked rating history.</p>
        <div id="rankedMessage" role="status" aria-live="polite"></div>
        <div class="sectionhead"><h2>Latest Ranked rating events</h2></div>
        <div id="rankedHistory" class="tablewrap"></div>
      </div>
    </section>
    <section id="view-history" class="hidden">`
  );
  output = output.replace(
    '  function eventParams(){',
    `  let rankedSelectedId=null,rankedSnapshot=null;
  function rankedPos(p){return p?p.rankKey+' '+(p.division==null?'':(['','I','II','III'][p.division]+' · '))+p.rp+' RP':'No ladder rating';}
  function rankedMsg(text,bad=false){const el=qs('#rankedMessage');if(el){el.textContent=text;el.style.color=bad?'#ff9ca4':'#a1e8bb';}}
  function rankedSwitchAction(){
    const a=qs('#rankedAction')?.value;
    qs('#rankedPointsBox')?.classList.toggle('hidden',a!=='adjust');
    qs('#rankedSetBox')?.classList.toggle('hidden',a!=='set');
    qs('#rankedRestoreBox')?.classList.toggle('hidden',a!=='restore');
    qs('#rankedDivision').disabled=qs('#rankedRank').value==='alchemist';
  }
  let rankedOffset=0;
  const RANKED_PAGE_SIZE=25;
  function rankedAccountStatus(a){
    if(a.placement_status==='in_progress')return 'Placements · '+(Number(a.placement_trials_completed)||0)+'/5';
    if(a.current_rank_key)return a.current_rank_key+' '+(a.current_division||'')+' / '+a.current_rp+' RP';
    return a.placement_status==='completed'?'Rank pending':'Not started';
  }
  async function rankedSearchNow(reset=true){
    const el=qs('#rankedSearchResults'),q=qs('#rankedSearch').value.trim();
    if(reset)rankedOffset=0;
    const browsing=q.length===0;
    const sort=qs('#rankedSort')?.value||'newest';
    if(!browsing&&q.length<3){el.textContent='Enter 3 or more characters, or clear the search to browse accounts.';return;}
    el.textContent='Searching...';
    try {
      const d=await api(browsing
        ? '/ranked/list?limit='+RANKED_PAGE_SIZE+'&offset='+rankedOffset+'&sort='+encodeURIComponent(sort)
        : '/ranked/search?q='+encodeURIComponent(q));
      el.innerHTML=(d.accounts||[]).length
       ?'<table><thead><tr><th>Account</th><th>Rank</th><th>Action</th></tr></thead><tbody>'+
         d.accounts.map(a=>'<tr><td><strong>'+esc(a.display_name||a.email||'Unnamed')+'</strong><div class="muted">'+esc(a.email||'')+'</div><div class="muted mono">'+esc(a.account_id)+'</div></td><td>'+esc(rankedAccountStatus(a))+'</td><td><button type="button" data-ranked-id="'+esc(a.account_id)+'">Manage</button></td></tr>').join('')+'</tbody></table>'
       :'<div class="empty">No matching accounts.</div>';
      el.querySelectorAll('[data-ranked-id]').forEach(b=>b.addEventListener('click',()=>rankedSelect(b.dataset.rankedId)));
      const paging=qs('#rankedPaging');
      paging?.classList.toggle('hidden',!browsing);
      if(browsing){
        const total=Number(d.total||0),shown=(d.accounts||[]).length;
        qs('#rankedPageInfo').textContent=total?(rankedOffset+1)+'–'+(rankedOffset+shown)+' of '+total+' accounts':'No accounts';
        qs('#rankedPrevious').disabled=rankedOffset===0;
        qs('#rankedNext').disabled=rankedOffset+shown>=total;
      }
    } catch(e){el.textContent=e.message||'Search unavailable.';}
  }
  async function rankedSelect(id){
    rankedSelectedId=id;rankedMsg('');
    try{
      const d=await api('/ranked/account/'+encodeURIComponent(id));
      rankedSnapshot=d;
      const p=d.profile;
      qs('#rankedSelected').classList.remove('hidden');
      qs('#rankedAccountTitle').textContent='Ranked account · '+id.slice(0,8);
      qs('#rankedState').textContent='Version '+p.stateVersion+' · '+p.placementStatus;
      qs('#rankedProfile').textContent=rankedPos(p.current)+' · peak '+(p.peak?rankedPos({...p.peak,rp:0}):'None')+
        ' · '+p.completedDebates+' completed · '+p.forfeits+' forfeits · '+p.invalidResults+' invalid · '+p.activeDebates+' active';
      qs('#rankedRank').value=p.current?.rankKey||'initiate';
      qs('#rankedDivision').value=String(p.current?.division||3);
      qs('#rankedExactRP').value=String(p.current?.rp||0);
      const failures=(d.failedDebates||[]).filter(x=>x.debate_kind==='ladder'&&Number(x.rp_delta)<0);
      qs('#rankedFailedDebate').innerHTML=failures.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.status)+' · '+esc(x.rp_delta)+' RP · '+esc(x.id.slice(0,8))+'</option>').join('');
      qs('#rankedHistory').innerHTML='<table><thead><tr><th>When</th><th>Type</th><th>Before → After</th><th>Reason</th></tr></thead><tbody>'+
        (d.events||[]).map(e=>'<tr><td>'+esc(fmtDate(e.occurred_at))+'</td><td>'+esc(e.admin_action||e.event_type)+'</td><td>'+esc(e.before_rank_key||'')+' '+esc(e.before_rp??'')+' → '+esc(e.after_rank_key||'')+' '+esc(e.after_rp??'')+'</td><td>'+esc(e.reason||'')+'</td></tr>').join('')+'</tbody></table>';
      rankedSwitchAction();
    }catch(e){rankedMsg(e.message||'Could not load ranked profile.',true);}
  }
  async function rankedApplyNow(){
    if(!rankedSelectedId||!rankedSnapshot)return;
    const action=qs('#rankedAction').value,reason=qs('#rankedReason').value.trim();
    if(reason.length<8){rankedMsg('A specific reason is required.',true);return;}
    const body={action,reason,expectedVersion:rankedSnapshot.profile.stateVersion,requestId:crypto.randomUUID()};
    if(action==='adjust')body.points=Number(qs('#rankedPoints').value);
    if(action==='set'){
      body.rankKey=qs('#rankedRank').value;
      body.division=body.rankKey==='alchemist'?null:Number(qs('#rankedDivision').value);
      body.rp=Number(qs('#rankedExactRP').value);
    }
    if(action==='restore')body.debateId=qs('#rankedFailedDebate').value;
    const description=action==='adjust'?'Adjust by '+body.points+' RP':action==='set'?'Set to '+body.rankKey+' / '+body.rp+' RP':action==='reset'?'RESET LADDER RATING to Initiate III / 0 RP':'Restore RP lost in '+body.debateId;
    if(!confirm('Apply to account '+rankedSelectedId+'?\\n'+description+'\\n\\nReason: '+reason+'\\n\\nThis is recorded in permanent rating history.'))return;
    const btn=qs('#rankedApply');btn.disabled=true;rankedMsg('Applying...');
    try{
      const response=await fetch('/subscription-admin/data/ranked/account/'+encodeURIComponent(rankedSelectedId),{
        method:'POST',credentials:'same-origin',
        headers:{'Content-Type':'application/json','X-Requested-With':'AgoraRankedAdmin'},
        body:JSON.stringify(body)
      });
      const data=await response.json();
      if(!response.ok||!data.success)throw new Error(data.error?.message||'Adjustment failed.');
      await rankedSelect(rankedSelectedId);
      rankedMsg('Adjustment saved. '+rankedPos(data.before)+' → '+rankedPos(data.after));
      qs('#rankedReason').value='';
    }catch(e){rankedMsg(e.message||'Adjustment failed.',true);}finally{btn.disabled=false;}
  }
  function rankedBind(){
    if(qs('#rankedSearchButton')?.dataset.bound)return;
    qs('#rankedSearchButton').dataset.bound='1';
    qs('#rankedSearchButton').addEventListener('click',()=>rankedSearchNow(true));
    qs('#rankedSort').addEventListener('change',()=>rankedSearchNow(true));
    qs('#rankedPrevious').addEventListener('click',()=>{rankedOffset=Math.max(0,rankedOffset-RANKED_PAGE_SIZE);rankedSearchNow(false);});
    qs('#rankedNext').addEventListener('click',()=>{rankedOffset+=RANKED_PAGE_SIZE;rankedSearchNow(false);});
    qs('#rankedSearch').addEventListener('input',()=>{if(!qs('#rankedSearch').value.trim())rankedSearchNow(true);});
    qs('#rankedSearch').addEventListener('keydown',e=>{if(e.key==='Enter')rankedSearchNow(true);});
    qs('#rankedAction').addEventListener('change',rankedSwitchAction);
    qs('#rankedRank').addEventListener('change',rankedSwitchAction);
    qs('#rankedApply').addEventListener('click',rankedApplyNow);
    rankedSwitchAction();
  }
  function loadRanked(){rankedBind();rankedSearchNow(true);}
  function eventParams(){`
  );
  output = output.replace(
    "if(view==='accounts')loadAccounts();",
    "if(view==='accounts')loadAccounts(); if(view==='ranked')loadRanked();"
  );
  // Register the page with the dashboard's switchView() routing and page
  // metadata. Adding a sidebar button and section alone leaves the view
  // hidden and throws when switchView tries to read meta[0].
  output = output
    .replace(
      "['overview','breakdown','accounts','customers','history','events']",
      "['overview','breakdown','accounts','ranked','customers','history','events']"
    )
    .replace(
      "accounts:['Accounts','Registered Agora accounts and account creation over time'],",
      "accounts:['Accounts','Registered Agora accounts and account creation over time'],ranked:['Ranked Management','Manage Ranked RP and restore unfair losses'],"
    );
  return output;
}
