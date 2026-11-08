# real-demo1
동의서 업무보고 어플

상담사 서비스는 Python 3.10 이상에서 실행합니다. 계정 생성 시 비밀번호는
터미널에 표시되지 않으며, 상담사별 활동 기록과 사진은 서버의 SQLite에 저장됩니다.
관리자와 상담사 비밀번호는 모두 **5자 이상, 12자 이하**로 설정합니다.

```powershell
python server.py add-user counselor01 "상담사 이름"
python server.py serve
```

브라우저에서 http://127.0.0.1:8766/ 을 열고 생성한 계정으로 로그인합니다.
Windows 기본 데이터 위치는 `%LOCALAPPDATA%\work-report\work-report.sqlite3`입니다.
`--db`로 위치를 지정할 때는 계정 생성과 서버 실행에 같은 경로를 사용합니다.

관리자 페이지: http://127.0.0.1:8766/admin

```powershell
python server.py add-admin site-admin "관리자 이름"
python server.py serve
```

최초 관리자만 위 명령으로 생성합니다. 관리자 페이지의 **상담사 관리**에서 새 상담사 계정을
만들 수 있고, 기존 상담사와 활동 기록도 같은 데이터베이스에서 바로 조회됩니다.
첫 화면은 한국 시간 기준 오늘의 통합 보고서입니다. 기간·상담사·구역으로 조회하고,
같은 조건의 통계와 활동 내역을 Excel(`.xlsx`)로 받거나 A4 가로로 인쇄할 수 있습니다.

GitHub Pages는 정적 파일을 제공하므로 로그인과 보고서 저장에는 별도 Python 서버가 필요합니다.
`db/initial.sqlite3`에는 업무보고를 시작할 때 사용할 구역 설정만 들어 있습니다.
운영 호스트에 영구 저장소와 HTTPS 프록시를 설정하고, 아래 두 명령에 같은 DB 경로를 사용합니다.
운영 관리자 계정은 첫 실행 때 별도로 생성합니다.

```sh
python server.py --db /var/data/work-report.sqlite3 --seed-db db/initial.sqlite3 add-admin site-admin "관리자 이름"
python server.py --db /var/data/work-report.sqlite3 --seed-db db/initial.sqlite3 serve --host 0.0.0.0 --port "${PORT:-8766}" --secure-cookie
```

HTTPS 주소의 `/`는 업무보고, `/admin`은 관리자 페이지입니다.
