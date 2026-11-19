#!/usr/bin/env python3
"""把 content/config.js 嵌進 src/tasks.html，產生兩個可以直接使用的網站。

    python3 build.py          # 產生 dist/part1.html 與 dist/part2.html
    python3 build.py --check  # 只檢查產出是否已是最新

產出：
  dist/part1.html   網站 1：階段 1–3（人工標註、引導 AI、檢核 AI）＋教師端
  dist/part2.html   網站 2：階段 4–5（回饋修正、一句話）＋教師端
兩個網站用同一份原始碼，只差 window.SYN_PART。
"""
import re, sys, pathlib, subprocess, shutil, json

ROOT = pathlib.Path(__file__).resolve().parent
CONFIG = ROOT / 'content' / 'config.js'
SRC = ROOT / 'src' / 'tasks.html'
CONFIG_TAG = '<script src="../content/config.js"></script>'
TITLE_TAG = '<title>語法偏誤任務單</title>'
PARTS = {1: 'dist/part1.html', 2: 'dist/part2.html'}

def check_config(config: str):
    """有 node 的話，檢查設定檔：語法、每個語料都有斷詞、每一組都分到語料。"""
    node = shutil.which('node')
    if not node:
        return
    js = ('global.window={};' + config + ';const c=window.SYN_CONFIG;'
          'const out={groups:c.totalGroups,texts:c.texts.map(t=>({id:t.id,groups:t.groups,n:t.toks.split("|").length,empty:t.toks.split("|").filter(x=>x==="").length}))};'
          'console.log(JSON.stringify(out))')
    r = subprocess.run([node, '-e', js], capture_output=True, text=True)
    if r.returncode:
        sys.exit('content/config.js 有語法錯誤：\n' + r.stderr)
    info = json.loads(r.stdout)
    covered = sorted(g for t in info['texts'] for g in t['groups'])
    for t in info['texts']:
        if t['empty']:
            sys.exit(f"語料 {t['id']} 的 toks 有連續的「||」，會多出空白的詞")
    missing = [g for g in range(1, info['groups'] + 1) if g not in covered]
    if missing:
        print('注意：這些組別沒有分到語料，會用語料 1：', missing)

def build() -> dict:
    config = CONFIG.read_text(encoding='utf-8').strip('\n')
    check_config(config)
    html = SRC.read_text(encoding='utf-8')
    for tag in (CONFIG_TAG, TITLE_TAG):
        if tag not in html:
            sys.exit(f'src/tasks.html 裡沒有 {tag}')
    out = {}
    for part, dist in PARTS.items():
        inline = f'<script>window.SYN_PART={part};</script>\n<script>\n{config}\n</script>'
        page = html.replace(CONFIG_TAG, inline, 1)
        page = page.replace(TITLE_TAG, f'<title>語法偏誤任務單 · 網站 {part}</title>', 1)
        out[dist] = page
    return out

def syntax_check(path: pathlib.Path):
    """有 node 的話，把每個 <script> 區塊抓出來檢查語法。"""
    node = shutil.which('node')
    if not node:
        return
    html = path.read_text(encoding='utf-8')
    for i, js in enumerate(re.findall(r'<script>(.*?)</script>', html, re.S)):
        tmp = path.with_suffix(f'.check{i}.js')
        tmp.write_text(js, encoding='utf-8')
        try:
            subprocess.run([node, '--check', str(tmp)], check=True)
        finally:
            tmp.unlink()

def main():
    out = build()
    if '--check' in sys.argv:
        stale = [p for p, s in out.items() if not (ROOT / p).exists() or (ROOT / p).read_text(encoding='utf-8') != s]
        if stale:
            sys.exit('這些檔案不是最新的，請執行 python3 build.py：\n  ' + '\n  '.join(stale))
        print('產出都是最新的。')
        return
    for p, s in out.items():
        path = ROOT / p
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(s, encoding='utf-8')
        syntax_check(path)
        print(f'寫入 {p}  ({len(s.encode("utf-8"))//1024} KB)')

if __name__ == '__main__':
    main()
