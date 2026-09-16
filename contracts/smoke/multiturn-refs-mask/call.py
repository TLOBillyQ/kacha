"""One gateway call: raw response + downloaded images to out/<name>/, sanitized fixture to fixtures/<name>.json."""
import base64, json, sys, time, urllib.request, urllib.error, os
sys.path.insert(0, "../../../src")
from ugc_image_tool.contracts.recorder import _sanitize_headers, _decode_and_sanitize
from datetime import UTC, datetime
BASE = "http://lzxsvn:3001"; KEY = os.environ["UGC_IMAGE_TOOL_GATEWAY_API_KEY"]
def durl(p):
    return "data:image/png;base64," + base64.b64encode(open(p,"rb").read()).decode()
def run(name, body, path="/v1/images/edits"):
    os.makedirs(f"out/{name}", exist_ok=True); os.makedirs("fixtures", exist_ok=True)
    raw = json.dumps(body, ensure_ascii=False).encode()
    hdr = {"Accept":"application/json","Authorization":f"Bearer {KEY}","Content-Type":"application/json"}
    req = urllib.request.Request(BASE+path, data=raw, headers=hdr, method="POST")
    t0=time.time()
    try:
        with urllib.request.urlopen(req, timeout=900) as r: st, rh, rb = r.status, dict(r.headers.items()), r.read()
    except urllib.error.HTTPError as e: st, rh, rb = e.code, dict(e.headers.items()), e.read()
    dt=time.time()-t0
    open(f"out/{name}/raw.json","wb").write(rb)
    try: j=json.loads(rb)
    except Exception: j=None
    imgs=[]
    if j and st==200:
        for ch in j.get("metadata",{}).get("output",{}).get("choices",[]):
            for c in ch["message"]["content"]:
                if "image" in c: imgs.append(c["image"])
        for i,u in enumerate(imgs):
            p=f"out/{name}/img{i}.png"
            if u.startswith("http"): urllib.request.urlretrieve(u,p)
            else: open(p,"wb").write(base64.b64decode(u.split(",",1)[-1]))
    fx={"interface":"image_edit","recorded_at":datetime.now(UTC).isoformat(),"note":name,
        "request":{"method":"POST","path":path,"headers":_sanitize_headers(hdr),"body":_decode_and_sanitize(raw,"application/json")},
        "response":{"status":st,"headers":_sanitize_headers(rh),"body":_decode_and_sanitize(rb,rh.get("Content-Type",""))}}
    json.dump(fx, open(f"fixtures/{name}.json","w"), ensure_ascii=False, indent=2)
    usage = j.get("usage") if j else None
    err = (j or {}).get("error") if j else rb[:300]
    print(f"{name}: status={st} dt={dt:.0f}s imgs={len(imgs)} usage={usage} err={err}")
    return j
def edit(model, images, text, params=None, extra_input=None, messages=None):
    if messages is None:
        messages=[{"role":"user","content":[{"image":durl(p)} for p in images]+[{"text":text}]}]
    inp={"messages":messages}
    if extra_input: inp.update(extra_input)
    b={"model":model,"prompt":text,"input":inp}
    if params: b["parameters"]=params
    return b
