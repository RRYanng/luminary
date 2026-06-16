#!/usr/bin/env python3
"""
Luminary Phase 3 — Top 200 校对工作台（本地小工具，无依赖）

逐座显示 Top 200 灯塔的完整详情（照片/名字/摘要/年/高/国/状态/来源链接），
你只做判断：一键标 OK 或「有问题」并写一句说明。标记**立即**写入
data/review_marks.json，关掉再开能接着校，不丢进度。

只读 lighthouse_details.json，不改任何灯塔数据；你的标记单独存。
具体修改之后由我根据 review_marks.json 来做。

用法:
  python scripts/review_server.py        # 然后浏览器打开提示的地址
  python scripts/review_server.py --port 8800
"""

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DETAILS = ROOT / "data" / "lighthouse_details.json"
MARKS = ROOT / "data" / "review_marks.json"

PAGE = r"""<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Luminary — Top 200 校对</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#0c0b10;color:#eee7d8;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .wrap{max-width:720px;margin:0 auto;padding:18px 18px 120px}
  header{display:flex;align-items:center;gap:14px;position:sticky;top:0;background:#0c0b10ee;backdrop-filter:blur(8px);padding:12px 0;z-index:5;border-bottom:1px solid #ffffff14}
  h1{font-size:16px;margin:0;color:#ffd27a;font-weight:600;letter-spacing:.04em}
  .prog{font-size:13px;opacity:.8;margin-left:auto;font-variant-numeric:tabular-nums}
  .bar{height:4px;background:#ffffff14;border-radius:3px;overflow:hidden;flex:1;max-width:220px}
  .bar>i{display:block;height:100%;background:#ffd27a;width:0}
  .card{margin-top:18px;border:1px solid #ffffff14;border-radius:14px;overflow:hidden;background:#16151c}
  .card img{display:block;width:100%;height:300px;object-fit:cover;background:#000}
  .body{padding:18px 20px}
  .rank{font-size:12px;opacity:.5;letter-spacing:.1em}
  h2{margin:4px 0 8px;font-size:24px;color:#ffd27a}
  .status{display:inline-flex;align-items:center;gap:7px;font-size:13px;margin-bottom:12px}
  .status .dot{width:9px;height:9px;border-radius:50%}
  .op .dot{background:#6ee787;box-shadow:0 0 8px #6ee787}.op{color:#8cf0a3}
  .ex .dot{background:#6fb3ff;box-shadow:0 0 8px #6fb3ff}.ex{color:#8fc0ff}
  .gn .dot{background:#b388ff;box-shadow:0 0 8px #b388ff}.gn{color:#c7a8ff}
  .summary{font-size:15px;line-height:1.6;margin:0 0 14px}
  .facts{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:14px;font-size:14px}
  .facts b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.08em;opacity:.5;font-weight:600}
  a.src{color:#ffcf6e;font-size:13px}
  .meta{font-size:12px;opacity:.5;margin-top:10px}
  .verdict{margin-top:8px;font-size:13px}
  .verdict.vok{color:#8cf0a3}.verdict.vp{color:#ff9b8a}
  .bottom{position:fixed;left:0;right:0;bottom:0;background:#100f15f2;border-top:1px solid #ffffff1c;backdrop-filter:blur(10px);padding:14px 18px}
  .bottom .row{max-width:720px;margin:0 auto;display:flex;gap:10px;align-items:center}
  button{font:inherit;border:1px solid #ffffff22;background:#ffffff10;color:#eee7d8;padding:9px 16px;border-radius:9px;cursor:pointer}
  button:hover{background:#ffffff1c}
  button.ok{border-color:#6ee78755;color:#8cf0a3}
  button.prob{border-color:#ff9b8a55;color:#ff9b8a}
  #note{flex:1;background:#ffffff0d;border:1px solid #ffffff22;border-radius:9px;color:#eee7d8;padding:9px 12px;font:inherit}
  .hint{font-size:11px;opacity:.45;margin-top:8px;text-align:center}
  kbd{background:#ffffff18;border-radius:4px;padding:1px 6px;font-family:ui-monospace,Menlo,monospace;font-size:11px}
  .done{text-align:center;padding:60px 20px;opacity:.8}
</style></head><body>
<div class=wrap>
  <header>
    <h1>Top 200 校对</h1>
    <div class=bar><i id=barfill></i></div>
    <div class=prog id=prog>– / –</div>
  </header>
  <div id=stage></div>
</div>
<div class=bottom><div class=row>
  <button class=ok onclick="mark('ok')">OK <kbd>o</kbd></button>
  <button class=prob onclick="markProblem()">有问题 <kbd>p</kbd></button>
  <input id=note placeholder="问题说明（可选，回车保存并下一座）">
  <button onclick="go(-1)">← <kbd>k</kbd></button>
  <button onclick="go(1)">→ <kbd>j</kbd></button>
</div>
<div class=hint><kbd>o</kbd> OK · <kbd>p</kbd> 有问题(写说明回车) · <kbd>j</kbd>/<kbd>→</kbd> 下一座 · <kbd>k</kbd>/<kbd>←</kbd> 上一座 · 进度自动保存</div>
</div>
<script>
let ITEMS=[], MARKS={}, i=0;
const $=s=>document.querySelector(s);
const ST={operational:['op','Operational 在役'],existing:['ex','Standing 现存'],gone:['gn','No longer exists 已不存在']};
async function load(){
  const d=await (await fetch('/api/data')).json();
  ITEMS=d.items; MARKS=d.marks||{};
  // resume: jump to first unmarked
  const f=ITEMS.findIndex(x=>!MARKS[x.id]); i=f<0?0:f;
  render();
}
function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function render(){
  const reviewed=Object.keys(MARKS).length, total=ITEMS.length;
  $('#prog').textContent=reviewed+' / '+total;
  $('#barfill').style.width=(total?reviewed/total*100:0)+'%';
  const it=ITEMS[i]; if(!it){$('#stage').innerHTML='<div class=done>没有数据</div>';return;}
  const m=MARKS[it.id]; const st=ST[it.status]||['ex',it.status||'?'];
  const facts=[]; if(it.built)facts.push(['Built',esc(it.built)]); if(it.height_m!=null)facts.push(['Height',it.height_m+' m']); if(it.country)facts.push(['Country',esc(it.country)]);
  $('#stage').innerHTML=`<div class=card>
    ${it.image?`<img src="${esc(it.image)}" onerror="this.style.display='none'">`:''}
    <div class=body>
      <div class=rank>#${it.top200_rank} · ${it.lang_count} langs</div>
      <h2>${esc(it.name||'(无名)')}</h2>
      <div class="status ${st[0]}"><span class=dot></span>${st[1]}</div>
      ${it.summary?`<p class=summary>${esc(it.summary)}</p>`:'<p class=summary style=opacity:.5>（无摘要）</p>'}
      ${facts.length?`<div class=facts>${facts.map(f=>`<div><b>${f[0]}</b>${f[1]}</div>`).join('')}</div>`:''}
      ${it.summary_source?`<a class=src href="${esc(it.summary_source)}" target=_blank rel=noreferrer>Wikipedia 来源 ↗</a>`:''}
      <div class=meta>${esc(it.id)} · ${esc(it.wikidata||'')}</div>
      ${m?`<div class="verdict ${m.verdict==='ok'?'vok':'vp'}">已标：${m.verdict==='ok'?'OK':'有问题'}${m.note?(' — '+esc(m.note)):''}</div>`:''}
    </div></div>`;
  $('#note').value=(m&&m.note)||'';
}
async function save(id,verdict,note){
  MARKS[id]={verdict,note,ts:Date.now()};
  render();
  try{await fetch('/api/mark',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,verdict,note})});}catch(e){}
}
function mark(v){const it=ITEMS[i];if(!it)return;save(it.id,v,(v==='problem')?$('#note').value.trim():'');if(v==='ok')go(1);}
function markProblem(){const it=ITEMS[i];if(!it)return;save(it.id,'problem',$('#note').value.trim());}
function go(d){i=Math.max(0,Math.min(ITEMS.length-1,i+d));render();$('#note').blur();}
document.addEventListener('keydown',e=>{
  if(e.target===$('#note')){
    if(e.key==='Enter'){e.preventDefault();markProblem();go(1);}
    else if(e.key==='Escape')$('#note').blur();
    return;
  }
  if(e.key==='o'){mark('ok');}
  else if(e.key==='p'){e.preventDefault();$('#note').focus();}
  else if(e.key==='j'||e.key==='ArrowRight'){go(1);}
  else if(e.key==='k'||e.key==='ArrowLeft'){go(-1);}
});
load();
</script></body></html>"""


def top200(details):
    items = [d for d in details if d.get("top200_rank")]
    items.sort(key=lambda d: d["top200_rank"])
    keys = ("id", "name", "wikidata", "status", "summary", "summary_source",
            "image", "built", "height_m", "country", "lang_count", "top200_rank")
    return [{k: d.get(k) for k in keys} for d in items]


def make_handler(items):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/" or self.path.startswith("/index"):
                self._send(200, PAGE, "text/html; charset=utf-8")
            elif self.path.startswith("/api/data"):
                marks = json.loads(MARKS.read_text(encoding="utf-8")) if MARKS.exists() else {}
                self._send(200, json.dumps({"items": items, "marks": marks}, ensure_ascii=False))
            else:
                self._send(404, "{}")

        def do_POST(self):
            if not self.path.startswith("/api/mark"):
                self._send(404, "{}")
                return
            n = int(self.headers.get("Content-Length", "0") or 0)
            payload = json.loads(self.rfile.read(n) or b"{}")
            marks = json.loads(MARKS.read_text(encoding="utf-8")) if MARKS.exists() else {}
            marks[payload["id"]] = {
                "verdict": payload.get("verdict"),
                "note": payload.get("note", ""),
                "rank": next((it["top200_rank"] for it in items if it["id"] == payload["id"]), None),
                "ts": int(time.time()),
            }
            MARKS.write_text(json.dumps(marks, ensure_ascii=False, indent=2), encoding="utf-8")
            self._send(200, json.dumps({"ok": True, "reviewed": len(marks)}))

    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8777)
    args = ap.parse_args()

    details = json.loads(DETAILS.read_text(encoding="utf-8"))["details"]
    items = top200(details)
    reviewed = len(json.loads(MARKS.read_text(encoding="utf-8"))) if MARKS.exists() else 0

    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(items))
    print(f"\n  Top 200 校对工作台已启动")
    print(f"  浏览器打开:  http://127.0.0.1:{args.port}/")
    print(f"  待校 {len(items)} 座 · 已校 {reviewed} 座 · 标记存入 {MARKS}")
    print(f"  Ctrl-C 停止（进度已随时保存，可随时再开接着校）\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。进度已保存。")


if __name__ == "__main__":
    main()
