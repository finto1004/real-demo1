"""Read-only reporting and Excel export for the work-report administrator."""
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from io import BytesIO
import json
import re
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile

DEFAULT_AREAS = {key: f"영화동 {key.upper()}구역" for key in ("a", "b", "c")}
KST = timezone(timedelta(hours=9))
METRICS = {"total": "전체 기록", "visits": "방문", "first": "최초 방문",
           "revisits": "재방문", "updates": "단순 업데이트", "consents": "동의서 신규 징구"}


def area_catalog(db, active_only=False):
    rows = db.execute("SELECT id, name FROM areas WHERE active=1 OR ?=0 ORDER BY rowid", (active_only,))
    return dict(rows)


def count_entries(entries):
    kinds = Counter(entry["type"] for entry in entries)
    return dict(total=len(entries), visits=kinds["최초 방문"] + kinds["재방문"],
                first=kinds["최초 방문"], revisits=kinds["재방문"], updates=kinds["단순 업데이트"],
                consents=sum(bool(entry.get("consent") and not entry.get("previousConsent")) for entry in entries))


def report_data(db, query, today):
    start = query.get("start", [today])[0]
    end = query.get("end", [today])[0]
    counselor = query.get("counselor", [""])[0]
    area = query.get("area", [""])[0]
    try:
        if any(date.fromisoformat(day).isoformat() != day for day in (start, end)) or start > end:
            raise ValueError
    except ValueError as exc:
        raise ValueError("조회 시작일과 종료일을 확인해 주세요.") from exc
    areas = area_catalog(db)
    active_areas = area_catalog(db, active_only=True)
    households = dict(db.execute("SELECT id, households FROM areas"))
    if area and area not in areas:
        raise ValueError("활동 구역을 확인해 주세요.")
    if counselor and not re.fullmatch(r"[a-zA-Z0-9_.-]{3,48}", counselor):
        raise ValueError("상담사 아이디를 확인해 주세요.")
    users = [dict(username=username, name=name, phone=phone, active=bool(active),
                  areas=[key for key in assigned.split(",") if key in active_areas])
             for username, name, phone, active, assigned in db.execute(
        "SELECT username, name, phone, active, areas FROM users WHERE role='counselor' ORDER BY name, username")]
    rows = db.execute("""
        SELECT e.body, e.username, u.name, e.request_id FROM entries e JOIN users u USING(username)
        WHERE json_extract(e.body, '$.date') BETWEEN ? AND ?
        AND (? = '' OR e.username = ?) AND (? = '' OR json_extract(e.body, '$.area') = ?)
        ORDER BY json_extract(e.body, '$.date') DESC, json_extract(e.body, '$.createdAt') DESC, e.rowid DESC
    """, (start, end, counselor, counselor, area, area))
    entries = []
    by_counselor, by_area, by_day = (defaultdict(list) for _ in range(3))
    for body, username, name, request_id in rows:
        entry = json.loads(body)
        entry.update(username=username, counselor=name, requestId=request_id,
                     areaName=areas.get(entry["area"], entry["area"]))
        entry["attachments"] = [item["name"] for item in entry.get("attachments", [])]
        entries.append(entry)
        by_counselor[username].append(entry)
        by_area[entry["area"]].append(entry)
        by_day[entry["date"]].append(entry)
    return dict(today=today, filters=dict(start=start, end=end, counselor=counselor, area=area),
                counselors=users, areas=areas, activeAreas=active_areas, households=households,
                entries=entries, metrics=count_entries(entries),
                byCounselor=[dict(**user, **count_entries(by_counselor[user["username"]]))
                             for user in users if not counselor or counselor == user["username"]],
                byArea=[dict(id=key, name=name, archived=key not in active_areas, **count_entries(by_area[key]))
                        for key, name in areas.items()
                        if (area == key) or (not area and (key in active_areas or key in by_area))],
                byDay=[dict(name=day, **count_entries(group)) for day, group in by_day.items()])


def format_time(milliseconds):
    return datetime.fromtimestamp(milliseconds / 1000, KST).strftime("%Y-%m-%d %H:%M:%S") if milliseconds else ""


def joined_items(entry, key):
    return "\n".join(f"{format_time(item.get('at'))}  {item['text']}".strip() for item in entry.get(key, []))


def report_workbook(report):
    filters = report["filters"]
    counselor = next((u["name"] for u in report["counselors"] if u["username"] == filters["counselor"]), "")
    stats = [
        ("집계 기준", "시작일", "종료일", "상담사", "활동 구역"),
        ("한국 시간", filters["start"], filters["end"], counselor or filters["counselor"] or "전체",
         report["areas"].get(filters["area"], "전체")),
        (),
        ("구분", "이름", "아이디", *METRICS.values()),
        ("전체", "합계", "", *(report["metrics"][key] for key in METRICS)),
    ]
    for group, key in (("상담사", "byCounselor"), ("활동 구역", "byArea"), ("활동일", "byDay")):
        stats.extend((group, item["name"], item.get("username", ""), *(item[metric] for metric in METRICS))
                     for item in report[key])
    fields = {
        "date": "활동일", "createdAt": "저장일시 (한국 시간)", "counselor": "상담사", "username": "상담사 아이디",
        "areaName": "구역", "type": "활동 유형", "address": "권리지번", "unit": "동·호수", "owner": "소유자명",
        "homePhone": "집전화", "mobilePhone": "휴대전화", "postcode": "우편번호", "residentAddress": "주소",
        "addressDetail": "상세주소", "result": "방문 결과", "resultOther": "방문 결과 기타",
        "consent": "동의서", "privacy": "개인정보 관련 서류", "identity": "신분증 관련 자료",
        "other": "기타 서류", "otherDocument": "기타 서류 내용", "newConsent": "신규 동의서 징구",
        "preference": "개발성향", "notes": "상담 내용", "changesItems": "변동사항", "follow": "후속 조치",
        "followDate": "예정일", "attachments": "첨부파일 이름",
    }
    entries = [tuple(fields.values())]
    for entry in report["entries"]:
        row = dict(entry, createdAt=format_time(entry["createdAt"]), notes=joined_items(entry, "notes"),
                   changesItems=joined_items(entry, "changesItems"), attachments="\n".join(entry["attachments"]),
                   newConsent=bool(entry["consent"] and not entry["previousConsent"]))
        entries.append(tuple(("예" if row.get(key) else "") if key in
                             {"consent", "privacy", "identity", "other", "newConsent"} else row.get(key, "")
                             for key in fields))
    # Long notes also have one row per item so Excel's cell limit cannot cut off report text.
    notes = [("보고서 번호", "활동일", "상담사 아이디", "권리지번", "항목", "기록 일시 (한국 시간)", "내용")]
    for number, entry in enumerate(report["entries"], 1):
        for key, label in (("notes", "상담 내용"), ("changesItems", "변동사항")):
            notes.extend((number, entry["date"], entry["username"], entry["address"], label,
                          format_time(item.get("at")), item["text"]) for item in entry.get(key, []))
    return make_xlsx([("통계", stats, {}), ("활동 보고서", [
        ("보고서 번호", *entries[0]), *((number, *row) for number, row in enumerate(entries[1:], 1))
    ], {3: 24, 14: 35, 25: 46, 26: 46}), ("상담 및 변동 내역", notes, {6: 24, 7: 65})])


def make_xlsx(sheets):
    main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    package = "http://schemas.openxmlformats.org/package/2006"
    office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    extension = "application/vnd.openxmlformats-officedocument.spreadsheetml"
    output = BytesIO()

    def col(number):
        letters = ""
        while number:
            number, digit = divmod(number - 1, 26)
            letters = chr(65 + digit) + letters
        return letters

    def cell(row, column, value):
        address = f"{col(column)}{row}"
        if isinstance(value, int):
            return f'<c r="{address}"><v>{value}</v></c>'
        clean = re.sub(r"[^\x09\x0a\x0d\x20-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]", "", str(value))[:16000]
        clean = re.sub(r"_(?=x[0-9a-fA-F]{4}_)", "_x005F_", clean)
        return f'<c r="{address}" t="inlineStr"><is><t xml:space="preserve">{escape(clean)}</t></is></c>'

    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        def put(path, xml):
            archive.writestr(path, '<?xml version="1.0" encoding="UTF-8"?>' + xml)

        numbers = range(1, len(sheets) + 1)
        overrides = "".join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="{extension}.worksheet+xml"/>' for i in numbers)
        put("[Content_Types].xml", f'<Types xmlns="{package}/content-types">'
            f'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            f'<Default Extension="xml" ContentType="application/xml"/>'
            f'<Override PartName="/xl/workbook.xml" ContentType="{extension}.sheet.main+xml"/>{overrides}</Types>')
        put("_rels/.rels", f'<Relationships xmlns="{package}/relationships">'
            f'<Relationship Id="rId1" Type="{office}/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        links = "".join(f'<Relationship Id="rId{i}" Type="{office}/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in numbers)
        put("xl/_rels/workbook.xml.rels", f'<Relationships xmlns="{package}/relationships">{links}</Relationships>')
        names = "".join(f'<sheet name="{name}" sheetId="{i}" r:id="rId{i}"/>' for i, (name, _, _) in enumerate(sheets, 1))
        put("xl/workbook.xml", f'<workbook xmlns="{main}" xmlns:r="{office}"><sheets>{names}</sheets></workbook>')
        for i, (_, rows, widths) in enumerate(sheets, 1):
            column_count = max(map(len, rows))
            columns = "".join(f'<col min="{n}" max="{n}" width="{widths.get(n, 19)}" customWidth="1"/>'
                              for n in range(1, column_count + 1))
            data = "".join(f'<row r="{n}">' + "".join(cell(n, j, value) for j, value in enumerate(row, 1)) + "</row>"
                           for n, row in enumerate(rows, 1))
            views = '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' if i != 1 else ""
            filtering = f'<autoFilter ref="A1:{col(column_count)}{len(rows)}"/>' if i != 1 else ""
            put(f"xl/worksheets/sheet{i}.xml", f'<worksheet xmlns="{main}">{views}<cols>{columns}</cols>'
                f'<sheetData>{data}</sheetData>{filtering}</worksheet>')
    return output.getvalue()
