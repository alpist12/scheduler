"""RTDB 트리를 Firestore 컬렉션 구조로 옮긴다.

기본은 검증만 하는 dry-run 이다. 실제 쓰기는 --write 를 붙여야 한다.

바꾸는 것 두 가지:
  1. 국원 ID  이름을 URL 인코딩한 값  ->  고정 랜덤 ID (이름은 필드로만)
  2. 개인일정  "9M7D월" / "9월 10일 (목)"  ->  ISO 날짜 "2026-09-10"

연도가 어디에도 없어서, 주 키에 적힌 요일이 실제로 맞는 연도를 찾아 정한다.
후보가 없거나 여럿이면 실패로 보고하고 옮기지 않는다.
"""
import argparse
import json
import re
import sys
import urllib.parse
import uuid
from datetime import date, timedelta
from urllib.request import Request, urlopen

PROJECT = 'hnubs-2sceduler'
# 콘솔에서 만든 데이터베이스 ID 가 '(default)' 가 아니라 'default' 다.
# 클라이언트도 getFirestore(app, 'default') 로 붙여야 한다.
DATABASE = 'default'

DOW = ['월', '화', '수', '목', '금', '토', '일']
WEEK_KEY = re.compile(r'^(\d{1,2})M(\d{1,2})D(.)$')
DATE_KEY = re.compile(r'^(\d{1,2})월\s*(\d{1,2})일\s*\((.)\)$')


def resolve_year(month, day, dow_label, anchor):
    """요일이 맞는 연도를 고른다. 기준 연도에서 가까운 순으로 본다."""
    hits = []
    for year in range(anchor - 2, anchor + 2):
        try:
            d = date(year, month, day)
        except ValueError:
            continue
        if DOW[d.weekday()] == dow_label:
            hits.append(d)
    if len(hits) != 1:
        return None, f'{month}월 {day}일 ({dow_label}) -> 후보 {len(hits)}개'
    return hits[0], None


class Migration:
    def __init__(self, tree, anchor_year):
        self.tree = tree
        self.anchor = anchor_year
        self.docs = {}          # collection path -> {doc_id: fields}
        self.id_by_legacy = {}  # 예전 ID/이름 -> 새 ID
        self.problems = []

    def put(self, collection, doc_id, fields):
        self.docs.setdefault(collection, {})[doc_id] = fields

    # --- 1단계: 국원. 나머지가 전부 이 매핑에 의존하므로 먼저 만든다. ---
    def members(self):
        for dept, people in (self.tree.get('인원') or {}).items():
            if dept == '_meta':
                continue
            for name, rec in (people or {}).items():
                legacy = str((rec or {}).get('legacyId') or '')
                # 예전 키에서 같은 ID 가 나오도록 한다. 다시 돌려도 중복이 생기지 않는다.
                seed = legacy or urllib.parse.quote(name)
                new_id = uuid.uuid5(uuid.NAMESPACE_URL, f'hnubs/member/{seed}').hex[:20]
                for key in {legacy, urllib.parse.quote(name), name}:
                    if key:
                        self.id_by_legacy[key] = new_id
                self.put('members', new_id, {
                    'name': name,
                    'department': dept,
                    'role': str((rec or {}).get('role') or ''),
                    'createdAt': (rec or {}).get('createdAt') or 0,
                    'legacyKey': legacy or urllib.parse.quote(name),
                })

    def member_id(self, raw, where):
        """예전 참조를 새 ID 로 바꾼다. 못 찾으면 기록만 남기고 버린다."""
        key = str(raw or '')
        found = self.id_by_legacy.get(key) or self.id_by_legacy.get(urllib.parse.unquote(key))
        if not found:
            self.problems.append(f'{where}: 국원 참조를 찾지 못함 -> {urllib.parse.unquote(key)}')
        return found

    def fixed_classes(self):
        for dept, people in (self.tree.get('고정시간표') or {}).items():
            if dept == '_meta':
                continue
            for name, items in (people or {}).items():
                owner = self.member_id(urllib.parse.quote(name), f'고정시간표/{dept}/{name}')
                if not owner:
                    continue
                for item_id, item in (items or {}).items():
                    self.put(f'members/{owner}/fixedClasses', item_id, {
                        'day': int((item or {}).get('day') or 0),
                        'title': str((item or {}).get('title') or '수업'),
                        'start': float((item or {}).get('start') or 0),
                        'end': float((item or {}).get('end') or 0),
                    })

    # --- 개인일정. 여기가 이전의 핵심이다. 하루 = 문서 1개. ---
    def availability(self):
        for dept, people in (self.tree.get('개인일정') or {}).items():
            if dept == '_meta':
                continue
            for name, weeks in (people or {}).items():
                owner = self.member_id(urllib.parse.quote(name), f'개인일정/{dept}/{name}')
                if not owner:
                    continue
                for week_key, rec in (weeks or {}).items():
                    self._week(owner, name, week_key, rec or {})

    def _week(self, owner, name, week_key, rec):
        m = WEEK_KEY.match(week_key)
        if not m:
            self.problems.append(f'개인일정/{name}: 주 키 형식 불명 -> {week_key}')
            return
        anchor, _ = resolve_year(int(m.group(1)), int(m.group(2)), m.group(3), self.anchor)
        if not anchor:
            self.problems.append(f'개인일정/{name}: 주 시작일 연도를 정할 수 없음 -> {week_key}')
            return
        for day_key, day in (rec.get('schedules') or {}).items():
            dm = DATE_KEY.match(day_key.strip())
            if not dm:
                self.problems.append(f'개인일정/{name}/{week_key}: 날짜 형식 불명 -> {day_key}')
                continue
            iso = self._iso(anchor, int(dm.group(1)), int(dm.group(2)), dm.group(3))
            if not iso:
                self.problems.append(f'개인일정/{name}/{week_key}: 주와 맞지 않는 날짜 -> {day_key}')
                continue
            # 국원 밑에 둔다. 전원 조회는 collectionGroup('availability') 로 한다.
            self.put(f'members/{owner}/availability', iso, {
                'memberId': owner,
                'date': iso,
                'status': str((day or {}).get('status') or ''),
                'entryMode': str((day or {}).get('entryMode') or ''),
                'memo': str((day or {}).get('memo') or ''),
                'mandatory': bool(rec.get('mandatory')),
                'availableRanges': list((day or {}).get('availableRanges') or []),
                'unavailableRanges': list((day or {}).get('unavailableRanges') or []),
            })

    @staticmethod
    def _iso(anchor, month, day, dow_label):
        """주 시작일 기준 7일 안에서 월/일/요일이 모두 맞는 날을 찾는다."""
        for offset in range(7):
            d = anchor + timedelta(days=offset)
            if d.month == month and d.day == day and DOW[d.weekday()] == dow_label:
                return d.isoformat()
        return None

    def shoots(self):
        for shoot_id, rec in (self.tree.get('촬영일정') or {}).items():
            if shoot_id == '_meta':
                continue   # 집계용 노드는 문서가 아니다
            rec = rec or {}
            cast = []
            for person in rec.get('cast') or []:
                found = self.member_id((person or {}).get('id'), f'촬영일정/{shoot_id}')
                if found:
                    cast.append(found)
            # 원본을 먼저 깔고 아는 필드만 덮는다. scenes 처럼 여기서 모르는 값도 남긴다.
            extra = {k: v for k, v in rec.items() if k != 'cast'}
            self.put('shoots', shoot_id, {
                **extra,
                'date': str(rec.get('date') or ''),
                'startH': float(rec.get('startH') or 0),
                'endH': float(rec.get('endH') or 0),
                'title': str(rec.get('title') or ''),
                'location': str(rec.get('location') or ''),
                'note': str(rec.get('note') or ''),
                'projectId': str(rec.get('projectId') or ''),
                'castIds': cast,     # 이름 사본은 두지 않는다. members 에서 읽는다.
            })

    def projects(self):
        for project_id, rec in (self.tree.get('프로젝트') or {}).items():
            if project_id == '_meta':
                continue   # 집계용 노드는 문서가 아니다
            rec = rec or {}
            ids = lambda seq, where: [x for x in
                                      (self.member_id((p or {}).get('id'), where) for p in seq or [])
                                      if x]
            roles = rec.get('roles') or {}
            # aiAnalysis 는 하위 문서로 따로 옮기고, 나머지 미지의 필드는 그대로 남긴다.
            extra = {k: v for k, v in rec.items() if k not in ('members', 'roles', 'aiAnalysis')}
            self.put('projects', project_id, {
                **extra,
                'name': str(rec.get('name') or ''),
                'color': str(rec.get('color') or ''),
                'createdAt': rec.get('createdAt') or 0,
                'memberIds': ids(rec.get('members'), f'프로젝트/{project_id}'),
                'roles': {k: ids(roles.get(k), f'프로젝트/{project_id}/{k}')
                          for k in ('planning', 'production', 'cast')},
            })
            analysis = rec.get('aiAnalysis')
            if analysis:
                self.put(f'projects/{project_id}/analyses', 'latest', analysis)

    def settings(self):
        if self.tree.get('설정'):
            self.put('settings', 'app', self.tree['설정'])
        if self.tree.get('라디오방송'):
            self.put('settings', 'radio', self.tree['라디오방송'])

    def run(self):
        self.members()
        self.fixed_classes()
        self.availability()
        self.shoots()
        self.projects()
        self.settings()
        return self


def encode(value, where='루트'):
    """파이썬 값을 Firestore REST 표현으로 바꾼다.

    Firestore 는 배열 바로 안의 배열을 허용하지 않는다. 조용히 뭉개지 말고 알린다.
    """
    if value is None:
        return {'nullValue': None}
    if isinstance(value, bool):
        return {'booleanValue': value}
    if isinstance(value, int):
        return {'integerValue': str(value)}
    if isinstance(value, float):
        return {'integerValue': str(int(value))} if value.is_integer() else {'doubleValue': value}
    if isinstance(value, str):
        return {'stringValue': value}
    if isinstance(value, list):
        for item in value:
            if isinstance(item, list):
                raise ValueError(f'{where}: 배열 안에 배열이 있어 Firestore 에 넣을 수 없습니다')
        return {'arrayValue': {'values': [encode(v, where) for v in value]}}
    if isinstance(value, dict):
        return {'mapValue': {'fields': {k: encode(v, f'{where}.{k}') for k, v in value.items()}}}
    return {'stringValue': str(value)}


def commit(writes, api_key):
    url = (f'https://firestore.googleapis.com/v1/projects/{PROJECT}'
           f'/databases/{DATABASE}/documents:commit?key={api_key}')
    body = json.dumps({'writes': writes}).encode('utf-8')
    req = Request(url, data=body, headers={'content-type': 'application/json'}, method='POST')
    with urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode('utf-8'))


def push(mig, api_key):
    """문서를 Firestore 에 쓴다. 한 번에 최대 500개씩 묶어 보낸다."""
    base = f'projects/{PROJECT}/databases/{DATABASE}/documents'
    writes = []
    for collection in sorted(mig.docs):
        for doc_id, fields in mig.docs[collection].items():
            writes.append({'update': {
                'name': f'{base}/{collection}/{doc_id}',
                'fields': {k: encode(v, f'{collection}/{doc_id}.{k}') for k, v in fields.items()},
            }})
    done = 0
    for start in range(0, len(writes), 500):
        batch = writes[start:start + 500]
        commit(batch, api_key)
        done += len(batch)
        print('  %d/%d 기록' % (done, len(writes)))
    return done


def summarize(mig):
    print('=== 옮길 문서 ===')
    total = 0
    for collection in sorted(mig.docs):
        n = len(mig.docs[collection])
        total += n
        print('  %-46s %4d' % (collection, n))
    print('  %-46s %4d' % ('합계', total))
    print()
    if mig.problems:
        print('=== 문제 %d건 ===' % len(mig.problems))
        for p in mig.problems:
            print('  -', p)
    else:
        print('문제 없음. 모든 참조와 날짜가 해석되었습니다.')
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('backup')
    ap.add_argument('--year', type=int, default=date.today().year,
                    help='연도가 없는 주 키를 해석할 기준 연도')
    ap.add_argument('--out', help='변환 결과를 JSON 으로 저장할 경로')
    ap.add_argument('--write', action='store_true', help='실제로 Firestore 에 쓴다')
    ap.add_argument('--key', help='Firebase 웹 API 키 (--write 에 필요)')
    args = ap.parse_args()

    with open(args.backup, encoding='utf-8') as fp:
        tree = (json.load(fp) or {}).get('scheduler') or {}

    mig = Migration(tree, args.year).run()
    total = summarize(mig)

    if args.out:
        with open(args.out, 'w', encoding='utf-8') as fp:
            json.dump({'documents': mig.docs, 'idMap': mig.id_by_legacy},
                      fp, ensure_ascii=False, indent=1)
        print('\n변환 결과 저장:', args.out)

    if args.write:
        if mig.problems:
            print('\n문제가 남아 있어 쓰지 않았습니다. 먼저 위 항목을 해결하세요.')
            return 1
        if not args.key:
            print('\n--key 가 필요합니다.')
            return 1
        print('\n=== Firestore 기록 (%s/%s) ===' % (PROJECT, DATABASE))
        print('  총 %d개 기록 완료' % push(mig, args.key))
        return 0
    print('\n(dry-run 입니다. 실제 쓰기는 --write)')
    return 0 if total and not mig.problems else 1


if __name__ == '__main__':
    sys.exit(main())
