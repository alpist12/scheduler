"""치환 헬퍼. 구간을 자를 때 끝 표식을 반드시 시작 뒤에서 찾는다.

이걸 안 지켰다가 end < start 가 되어 슬라이스가 빈 문자열이 됐고,
text.replace('', ...) 가 모든 글자 사이에 문자열을 끼워 넣어
316KB 파일이 767MB 가 된 적이 있다.
"""
import io


def read(path):
    return io.open(path, encoding='utf-8').read()


def write(path, text):
    io.open(path, 'w', encoding='utf-8').write(text)


def swap(text, old, new, count=1):
    """정확히 count 번 나오는 문자열만 바꾼다."""
    found = text.count(old)
    if found != count:
        raise SystemExit(f'치환 실패: {found}번 발견 (기대 {count})\n  --> {old[:90]}')
    return text.replace(old, new)


def cut(text, start_mark, end_mark, new):
    """start_mark 부터 end_mark 전까지를 new 로 갈아끼운다.

    end_mark 는 start 뒤에서만 찾는다. 빈 구간이면 즉시 멈춘다.
    """
    start = text.index(start_mark)
    end = text.index(end_mark, start + len(start_mark))
    if end <= start:
        raise SystemExit('치환 실패: 끝 표식이 시작보다 앞에 있습니다')
    return text[:start] + new + text[end:]
