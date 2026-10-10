#!/usr/bin/env python3
"""Build a self-contained case browser: python3 build.py -> index.html (same dir)."""
import base64, glob, json, os, re

ROOT = os.environ.get('CASES_DIR', os.path.join(os.path.dirname(__file__), '..', '..', '..', 'data', 'public-cases', 'Insurance Claims Processing'))
SIM = os.path.join(os.path.dirname(__file__), '..', 'out')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")
REF = re.compile(r"\b(?:INS|CLM|CERT|INV|RCP|EST|REP)-\d+\b")
CATS = [("Quote", {1, 2, 3, 4, 5, 10}), ("Policy docs", range(6, 10)), ("Renewal", range(11, 15)),
        ("Mid-term change", range(15, 21)), ("Billing", range(21, 29)), ("FNOL", range(29, 37)),
        ("Claim in progress", range(37, 45)), ("Decision / payout", range(45, 48)), ("Third party / privacy", range(48, 51))]


def sections(md):
    return {m[0].strip(): m[1].strip() for m in re.findall(r"^## (.+?)\n(.*?)(?=^## |\Z)", md, re.M | re.S)}


def case(d):
    n = int(os.path.basename(d))
    idx, hist = open(f"{d}/index.md").read(), open(f"{d}/history.md").read()
    s = sections(idx)
    det = dict(re.findall(r"^- \*\*(.+?):\*\* (.*)$", s.get("Case details", ""), re.M))
    events = []
    for chunk in re.split(r'<a id="event-\d+"></a>', hist)[1:]:
        head = re.search(r"^## (.+?) — event (\d+)", chunk, re.M)
        meta = dict(re.findall(r"^- \*\*(Channel|From|To):\*\* (.*)$", chunk, re.M))
        body = re.sub(r"^## .*\n|^- \*\*(Channel|From|To):\*\*.*\n", "", chunk.strip() + "\n", flags=re.M).strip()
        events.append({"n": int(head[2]), "ts": head[1], "ch": meta.get("Channel", ""),
                       "from": meta.get("From", ""), "to": meta.get("To", ""), "body": body})
    att = []
    for f in sorted(glob.glob(f"{d}/attachments/*")):
        mime = "application/pdf" if f.endswith(".pdf") else "image/png"
        att.append({"name": os.path.basename(f), "mime": mime, "b64": base64.b64encode(open(f, "rb").read()).decode()})
    return {"id": f"{n:03d}", "title": re.search(r"^# Case \d+: (.+)$", idx, re.M)[1].strip(),
            "cat": next(c for c, r in CATS if n in r), "details": det,
            "initial": s.get("Initial request", ""), "overview": s.get("Overview", ""),
            "next": s.get("Next action at escalation", ""), "outcome": s.get("Outcome", ""),
            "refs": sorted(set(REF.findall(idx + hist)), key=lambda r: (r.split("-")[0], r)),
            "events": events, "att": att}


def sim():
    out = {}
    for f in sorted(glob.glob(f"{SIM}/*.json")):
        try:  # files may still be mid-write
            rows = json.load(open(f))
        except Exception as e:
            print(f"skip {f}: {e}")
            continue
        out[os.path.basename(f)[:-5]] = [r for r in rows if isinstance(r, dict) and "case" in r]
    return out


HTML = r"""
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claims Casebook</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#f7f8fa;--sf:#fff;--bd:#e5e7eb;--tx:#111827;--mu:#6b7280;--ac:#1e2a5a;--acs:#eef0f8;
--cu:#475569;--cus:#f1f5f9;--br:#1e2a5a;--brs:#eef0f8;--in:#0f766e;--ins:#ecfdf8;--no:#a16207;--nos:#fefce8;
--g:#15803d;--gs:#dcfce7;--a:#b45309;--as:#fef3c7;--r:#b91c1c;--rs:#fee2e2}
*{box-sizing:border-box}body{margin:0;font:14px/1.55 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--tx);background:var(--bg);display:flex;height:100vh;overflow:hidden}
button{font:inherit;cursor:pointer}
aside{width:340px;flex:none;background:var(--sf);border-right:1px solid var(--bd);display:flex;flex-direction:column;min-height:0}
.brand{padding:18px 20px 12px;font-weight:700;font-size:16px;letter-spacing:-.01em;display:flex;align-items:center;gap:8px}
.brand i{width:10px;height:10px;border-radius:3px;background:var(--ac);display:inline-block}
.tabs{display:flex;gap:4px;padding:0 16px 12px}.tabs button{flex:1;border:1px solid var(--bd);background:var(--sf);border-radius:8px;padding:7px;color:var(--mu);font-weight:500}
.tabs button.on{background:var(--ac);border-color:var(--ac);color:#fff}
#q{margin:0 16px 10px;padding:9px 12px;border:1px solid var(--bd);border-radius:8px;font:inherit;outline:none}#q:focus{border-color:var(--ac);box-shadow:0 0 0 3px var(--acs)}
.chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 12px;border-bottom:1px solid var(--bd)}
.chip{border:1px solid var(--bd);background:var(--sf);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--mu)}.chip.on{background:var(--acs);border-color:var(--ac);color:var(--ac);font-weight:600}
#list{overflow:auto;flex:1}
.item{display:block;padding:12px 20px;border-bottom:1px solid var(--bd);text-decoration:none;color:inherit}.item:hover{background:var(--bg)}.item.on{background:var(--acs);box-shadow:inset 3px 0 var(--ac)}
.item b{font-weight:600}.item .n{color:var(--mu);font-variant-numeric:tabular-nums;margin-right:6px}.item .m{display:flex;justify-content:space-between;gap:8px;color:var(--mu);font-size:12px;margin-top:3px}
.tag{font-size:11px;padding:1px 8px;border-radius:999px;background:var(--bg);border:1px solid var(--bd);color:var(--mu);white-space:nowrap}
main{flex:1;overflow:auto;min-width:0}.wrap{max-width:920px;margin:0 auto;padding:24px 28px 80px}
.card{background:var(--sf);border:1px solid var(--bd);border-radius:8px;padding:18px 20px;margin-bottom:16px}
.card h3{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mu);font-weight:600}
.card p{margin:0}h1{font-size:22px;margin:4px 0 14px;letter-spacing:-.02em;line-height:1.3}
.kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px 20px}.kv div span{display:block;font-size:12px;color:var(--mu)}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.grid3 .card{margin:0}
.ref{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--acs);color:var(--ac);padding:2px 6px;border-radius:6px;margin:0 4px 4px 0;display:inline-block}
.status{display:inline-block;font-size:12px;font-weight:600;padding:2px 10px;border-radius:999px;background:var(--gs);color:var(--g)}
h2{font-size:15px;margin:28px 0 12px}
.tl{position:relative;padding-left:22px}.tl:before{content:"";position:absolute;left:7px;top:6px;bottom:6px;width:2px;background:var(--bd)}
.ev{position:relative;margin-bottom:14px}.ev .dot{position:absolute;left:-22px;top:14px;width:16px;height:16px;border-radius:50%;background:var(--sf);border:2px solid var(--c)}
.msg{background:var(--s);border:1px solid var(--bd);border-left:3px solid var(--c);border-radius:8px;padding:12px 16px;max-width:88%}
.ev.broker .msg{margin-left:auto}.ev.note .msg{border-style:dashed;border-left-style:solid;max-width:100%}
.ev.customer{--c:var(--cu);--s:var(--sf)}.ev.broker{--c:var(--br);--s:var(--brs)}.ev.insurer{--c:var(--in);--s:var(--ins)}.ev.note{--c:var(--no);--s:var(--nos)}
.mh{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:12px;color:var(--mu);margin-bottom:6px}.mh b{color:var(--tx);font-size:13px}
.role{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--c)}.mh svg{width:14px;height:14px;vertical-align:-2px}
.body{white-space:pre-wrap}
.pred{margin:0 0 14px;border:1px dashed var(--ac);border-radius:8px;background:var(--sf);padding:10px 14px}
.pred>div:first-child{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--ac);margin-bottom:6px}
.pr{border-top:1px solid var(--bd);padding:6px 0}.pr summary{cursor:pointer;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;font-size:13px}
.pr .why{color:var(--mu);font-size:12.5px;margin:4px 0}.pr .pm{white-space:pre-wrap;background:var(--bg);border-radius:6px;padding:8px 10px;font-size:13px}
.b{font-size:11px;font-weight:700;padding:1px 8px;border-radius:999px}.b2{background:var(--gs);color:var(--g)}.b1{background:var(--as);color:var(--a)}.b0{background:var(--rs);color:var(--r)}.bh{background:var(--r);color:#fff}.be{background:var(--bg);color:var(--mu)}
.cfg{font-weight:600}.mono{font:12px ui-monospace,Menlo,monospace;color:var(--mu)}
#sum{display:flex;flex-wrap:wrap;gap:8px;padding:12px 28px;border-bottom:1px solid var(--bd);background:var(--sf);overflow-x:auto;flex-wrap:nowrap}
#sum:empty{display:none}.st{border:1px solid var(--bd);border-radius:8px;padding:5px 10px;font-size:12px;white-space:nowrap}.st b{margin-right:6px}.st .g{color:var(--g);font-weight:600}.st .r{color:var(--r);font-weight:600}
.gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.th{border:1px solid var(--bd);border-radius:8px;overflow:hidden;background:var(--sf);padding:0;text-align:left}.th img{width:100%;height:130px;object-fit:cover;display:block;background:var(--bg)}
.th .pdf{height:130px;display:grid;place-items:center;background:var(--acs);color:var(--ac);font-weight:700;letter-spacing:.1em}.th div:last-child{padding:8px 10px;font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--sf);border:1px solid var(--bd);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--bd);vertical-align:top;font-size:13px}th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mu);background:var(--bg)}
td a{color:var(--ac);font-weight:600;text-decoration:none}.lnk{border:1px solid var(--bd);background:var(--sf);border-radius:6px;padding:2px 8px;font-size:12px;margin:0 4px 4px 0;color:var(--ac)}
dialog{border:none;border-radius:8px;padding:0;width:min(1000px,94vw);height:min(90vh,1000px);box-shadow:0 20px 60px rgba(0,0,0,.25)}dialog::backdrop{background:rgba(17,24,39,.5)}
dialog header{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid var(--bd);font-weight:600}
dialog header button{border:none;background:none;font-size:20px;color:var(--mu)}#dv{height:calc(100% - 49px);overflow:auto;display:grid;place-items:start center;background:var(--bg)}
#dv img{max-width:100%}#dv iframe{width:100%;height:100%;border:0}
.back{display:none}.empty{color:var(--mu);padding:60px 0;text-align:center}
@media(max-width:900px){.grid3{grid-template-columns:1fr}}
@media(max-width:760px){aside{width:100%;border:none}main{display:none}body.m aside{display:none}body.m main{display:block}
.wrap{padding:16px}#sum{padding:10px 16px}.msg{max-width:100%}.back{display:inline-block;border:1px solid var(--bd);background:var(--sf);border-radius:8px;padding:6px 12px;margin-bottom:12px}
.pt{display:block}.pt thead{display:none}.pt tr{display:block;border-bottom:1px solid var(--bd);padding:8px 0}.pt td{display:block;border:none;padding:3px 12px}}
</style></head><body>
<aside><div class="brand"><i></i>Claims Casebook</div>
<div class="tabs"><button data-v="case" class="on">Cases</button><button data-v="policies">Policies</button></div>
<input id="q" type="search" placeholder="Search cases, people, refs…"><div class="chips" id="chips"></div><nav id="list"></nav></aside>
<main><div id="sum"></div><div class="wrap" id="view"></div></main>
<dialog id="dlg"><header><span id="dt"></span><button onclick="dlg.close()" aria-label="Close">×</button></header><div id="dv"></div></dialog>
<script id="data" type="application/json">__DATA__</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent),C=D.cases,byId=Object.fromEntries(C.map(c=>[c.id,c]));
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
const ICON={Email:'<path d="M3 5h18v14H3z M3 6l9 7 9-7"/>',Call:'<path d="M5 3h4l2 5-3 2a12 12 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A18 18 0 0 1 3 5a2 2 0 0 1 2-2"/>',Note:'<path d="M5 3h10l4 4v14H5z M14 3v5h5 M8 12h8 M8 16h6"/>'};
const icon=ch=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">${ICON[ch]||ICON.Email}</svg>`;
let cat='All',view='case',cur=null;
C.forEach(c=>c.blob=[c.id,c.title,c.cat,c.initial,c.refs.join(' '),...Object.values(c.details),...c.events.map(e=>e.from+' '+e.to+' '+e.body)].join(' ').toLowerCase());

// Sim: index by config -> case -> k
const SIM={};for(const[cfg,rows]of Object.entries(D.sim))for(const r of rows)((SIM[cfg]??={})[r.case]??=[]).push(r);
function summary(){$('#sum').innerHTML=Object.entries(D.sim).map(([cfg,rows])=>{const ok=rows.filter(r=>!r.error),p=f=>ok.length?Math.round(100*ok.filter(f).length/ok.length)+'%':'–';
 return `<div class="st"><b>${esc(cfg)}</b><span class="g">${p(r=>r.j_match==2)}</span> match · <span class="r">${p(r=>r.j_harmful)}</span> harmful · ${ok.length}${rows.length>ok.length?` (+${rows.length-ok.length} err)`:''}</div>`}).join('')}
const badge=r=>r.error?'<span class="b be">error</span>':`<span class="b b${r.j_match}">${['wrong','partial','match'][r.j_match]??'?'}</span>${r.j_harmful?'<span class="b bh">⚑ harmful</span>':''}`;

// Role: Note -> internal; broker org / broker first name / bare first name -> broker; insurer name or keywords -> insurer; else customer
function roleOf(e,c){if(e.ch==='Note')return'note';const f=e.from.toLowerCase(),B=(c.details.Broker||'').toLowerCase(),I=(c.details.Insurer||'').toLowerCase();
 const parts=B.split(/,|—|\(|\)| at | represented by | handled by /).map(s=>s.trim()).filter(Boolean),orgs=parts.filter(p=>p.includes(' ')),names=parts.filter(p=>!p.includes(' ')).concat(parts.filter(p=>p.split(' ').length==2&&!/cover|risk|brokers?|insurance/.test(p)).map(p=>p.split(' ')[0]));
 if(orgs.some(o=>f.includes(o))||names.includes(f.split(/[ ,]/)[0])||!/[ ,]/.test(e.from.trim())&&!/tenant|landlord|neighbou?r|owner/.test(f))return'broker';
 if(f.includes(I)||f.includes(I.split(' ')[0])||/mutual|insurance|underwriting|team|insurer/.test(f))return'insurer';return'customer'}
// fallback (e.g. 022): broker unnamed in Broker field -> whoever the insurer writes to
function roles(c){const rs=c.events.map(e=>roleOf(e,c));if(!rs.includes('broker')){const to=new Set(c.events.filter((e,i)=>rs[i]==='insurer').map(e=>e.to));c.events.forEach((e,i)=>{if(rs[i]==='customer'&&to.has(e.from))rs[i]='broker'})}return rs}

function renderList(){$('#list').scrollTop=0;const q=$('#q').value.toLowerCase().trim();
 $('#chips').innerHTML=['All',...D.cats].map(k=>`<button class="chip${k===cat?' on':''}" data-c="${esc(k)}">${esc(k)}</button>`).join('');
 const xs=C.filter(c=>(cat==='All'||c.cat===cat)&&(!q||q.split(/\s+/).every(w=>c.blob.includes(w))));
 $('#list').innerHTML=xs.map(c=>`<a class="item${cur===c.id&&view==='case'?' on':''}" href="#case/${c.id}"><div><span class="n">${c.id}</span><b>${esc(c.title)}</b></div><div class="m"><span>${esc(c.details.Insurer)}</span><span class="tag">${esc(c.cat)}</span></div></a>`).join('')||'<div class="empty">No cases</div>';
 return xs}

function predBlock(c,k){const rs=Object.entries(SIM).flatMap(([cfg,m])=>(m[c.id]||[]).filter(r=>r.k===k).map(r=>({cfg,...r})));if(!rs.length)return'';
 return `<div class="pred"><div>Simulated broker action · event ${k}</div>${rs.map(r=>`<details class="pr"><summary><span class="cfg">${esc(r.cfg)}</span>${badge(r)}${r.error?`<span class="mono">${esc(r.error)}</span>`:`<span class="mono">${esc(r.action_type)} → ${esc(r.recipient)}</span><span class="mono">${esc(r.autonomy)} · conf ${r.confidence}</span>`}</summary>${r.error?'':`<div class="why"><b>Judge:</b> ${esc(r.j_why)}</div><div class="pm">${esc(r.message)}</div>`}</details>`).join('')}</div>`}

function attTile(c,i){const a=c.att[i];return `<button class="th" data-a="${c.id}:${i}">${a.mime==='application/pdf'?'<div class="pdf">PDF</div>':`<img src="data:${a.mime};base64,${a.b64}" alt="${esc(a.name)}" loading="lazy">`}<div>${esc(a.name)}</div></button>`}

function renderCase(id){const c=byId[id]||C[0];cur=c.id;const d=c.details,R=roles(c);
 const simRow=Object.entries(SIM).filter(([,m])=>m[c.id]).map(([cfg,m])=>`<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px"><span class="cfg" style="min-width:150px">${esc(cfg)}</span>${m[c.id].map(r=>`<span class="mono">ev ${r.k}</span>${badge(r)}`).join(' ')}</div>`).join('');
 $('#view').innerHTML=`<button class="back" onclick="location.hash=''">← Cases</button>
 <div class="card"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><span class="mono">Case ${c.id} · ${esc(c.cat)}</span><span class="status">${esc(d.Status)}</span></div>
 <h1>${esc(c.title)}</h1><div class="kv">${['Property','Broker','Insurer','Source role','Created','Updated','Completed'].map(k=>`<div><span>${k}</span>${esc(d[k]||'—')}</div>`).join('')}
 <div><span>References</span>${c.refs.map(r=>`<span class="ref">${r}</span>`).join('')||'—'}</div></div></div>
 <div class="card"><h3>Initial request</h3><p class="body">${esc(c.initial)}</p></div>
 <div class="grid3">${[['Overview',c.overview],['Next action at escalation',c.next],['Outcome',c.outcome]].map(([h,t])=>`<div class="card"><h3>${h}</h3><p>${esc(t)}</p></div>`).join('')}</div>
 ${simRow?`<div class="card" style="margin-top:16px"><h3>Simulation</h3>${simRow}</div>`:''}
 <h2>Timeline · ${c.events.length} events</h2><div class="tl">${c.events.map((e,i,_,r=R[i])=>{return predBlock(c,e.n)+`<div class="ev ${r}" id="ev${e.n}"><span class="dot"></span><div class="msg"><div class="mh">${icon(e.ch)}<span class="role">${r==='note'?'internal note':r}</span><b>${esc(e.from)}</b><span>→ ${esc(e.to)}</span><span style="margin-left:auto">#${e.n} · ${esc(e.ts)}</span></div><div class="body">${esc(e.body)}</div></div></div>`}).join('')}</div>
 ${c.att.length?`<h2>Attachments</h2><div class="gal">${c.att.map((_,i)=>attTile(c,i)).join('')}</div>`:''}`;
 $('main').scrollTop=0}

function renderPolicies(xs){$('#view').innerHTML=`<button class="back" onclick="location.hash=''">← Cases</button><h1>Policies &amp; references</h1>
 <table class="pt"><thead><tr><th>Case</th><th>References</th><th>Property</th><th>Insurer</th><th>Broker</th><th>Documents</th></tr></thead><tbody>${xs.map(c=>`<tr>
 <td><a href="#case/${c.id}">${c.id}</a><div class="mono">${esc(c.cat)}</div></td><td>${c.refs.map(r=>`<span class="ref">${r}</span>`).join('')||'<span class="mono">—</span>'}</td>
 <td>${esc(c.details.Property)}</td><td>${esc(c.details.Insurer)}</td><td>${esc(c.details.Broker)}</td><td>${c.att.map((a,i)=>`<button class="lnk" data-a="${c.id}:${i}">${esc(a.name)}</button>`).join('')}</td></tr>`).join('')}</tbody></table>`}

function openAtt(key){const[id,i]=key.split(':'),a=byId[id].att[+i];$('#dt').textContent=`Case ${id} · ${a.name}`;
 if(a.mime==='application/pdf'){const bin=atob(a.b64),u=new Uint8Array(bin.length);for(let j=0;j<bin.length;j++)u[j]=bin.charCodeAt(j);
  $('#dv').innerHTML=`<iframe src="${URL.createObjectURL(new Blob([u],{type:a.mime}))}"></iframe>`}else $('#dv').innerHTML=`<img src="data:${a.mime};base64,${a.b64}" alt="${esc(a.name)}">`;dlg.showModal()}

function route(){const h=location.hash.slice(1);view=h==='policies'?'policies':'case';document.body.classList.toggle('m',!!h);
 document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('on',b.dataset.v===view));
 if(view==='case')renderCase(h.split('/')[1]||cur);const xs=renderList();$('.item.on')?.scrollIntoView({block:'nearest'});if(view==='policies')renderPolicies(xs)}

document.addEventListener('click',e=>{const t=e.target.closest('[data-c],[data-v],[data-a]');if(!t)return;
 if(t.dataset.a)openAtt(t.dataset.a);else if(t.dataset.v)location.hash=t.dataset.v==='policies'?'policies':'';else{cat=t.dataset.c;route()}});
$('#q').addEventListener('input',route);addEventListener('hashchange',route);summary();route();
</script></body></html>
"""

data = {"cats": [c for c, _ in CATS], "cases": [case(d) for d in sorted(glob.glob(f"{ROOT}/[0-9][0-9][0-9]"))], "sim": sim()}
open(OUT, "w").write(HTML.replace("__DATA__", json.dumps(data).replace("</", "<\\/")))
print(f"wrote {OUT}: {len(data['cases'])} cases, sims={list(data['sim'])}, {os.path.getsize(OUT) // 1024} KB")
