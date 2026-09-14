"""템플릿 무결성 검사. sc-if/sc-for 짝이 안 맞으면 화면 한 덩어리가 통째로 사라진다."""
import io
import re
import sys

bad = 0
for f in sys.argv[1:]:
    src = io.open(f, encoding='utf-8').read()
    cut = src.index('<script type="text/x-dc"')
    tpl, logic = src[:cut], src[cut:]
    for tag in ('sc-if', 'sc-for'):
        o = len(re.findall(r'<%s\b' % tag, tpl))
        c = len(re.findall(r'</%s>' % tag, tpl))
        if o != c:
            bad += 1
            print(f'!! {f}: {tag} 열림 {o} / 닫힘 {c}')
    refs = set(re.findall(r'\{\{\s*([a-zA-Z_$][\w$.]*)\s*\}\}', tpl))
    loop = set(re.findall(r'as="(\w+)"', tpl))
    miss = [r for r in sorted(refs)
            if '.' not in r and r not in loop and r not in ('true', 'false')
            and not re.search(r'\b%s\s*[:,]' % re.escape(r), logic)]
    if miss:
        bad += 1
    print(f'{f}: 참조 {len(refs)}개 · 미정의 {len(miss)}개 {miss if miss else ""}')
print('템플릿 OK' if not bad else f'!! 문제 {bad}건')
sys.exit(1 if bad else 0)
