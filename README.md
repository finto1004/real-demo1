# real-demo1
동의서 업무보고 어플

상담사 서비스는 Python 3.10 이상에서 실행합니다. 계정 생성 시 비밀번호는
터미널에 표시되지 않으며, 상담사별 활동 기록과 사진은 서버의 SQLite에 저장됩니다.

```powershell
python server.py add-user counselor01 "상담사 이름"
python server.py serve
```

브라우저에서 http://127.0.0.1:8766/ 을 열고 생성한 계정으로 로그인합니다.
Windows 기본 데이터 위치는 `%LOCALAPPDATA%\work-report\work-report.sqlite3`입니다.
`--db`로 위치를 지정할 때는 계정 생성과 서버 실행에 같은 경로를 사용합니다.

GitHub Pages는 정적 파일을 제공하므로 서비스 서버를 별도로 실행해야 합니다.
외부 기기에서 사용하려면 운영 호스트에서 HTTPS 프록시를 구성하고
`python server.py serve --secure-cookie`로 실행합니다.
