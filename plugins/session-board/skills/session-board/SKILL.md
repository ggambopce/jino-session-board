---
name: session-board
description: 지금 Claude Code 세션의 진행 상황을 한눈에 보여 준다. 진행판 체크리스트, 턴별 결과보고, 하위 에이전트, Codex 교차검증, 결과물 이미지, 바뀐 파일, 빌드·테스트 검사, 대화에 나온 주소, 컨텍스트 토큰을 세션 기록에서 뽑아 실시간 보드, HTML 한 장, 텍스트 요약으로 만든다. 사용자가 "진행판 보여줘", "세션 보드", "지금까지 뭐 했어", "바뀐 파일 정리", "실시간으로 보여줘", "session board", "세션 현황" 처럼 세션 상태를 묻거나 /session-board 를 실행할 때 쓴다.
---

# 세션 보드

세션 기록(`~/.claude/projects/**/<세션ID>.jsonl`)과 보드 파일(`~/.claude/session-board/<세션ID>.md` 또는
`~/.claude/session-plans/<세션ID>.md`)을 읽어서 현황판을 만든다. 밖으로 보내는 것은 없다.

## 고르는 기준

| 상황 | 방식 |
|---|---|
| 작업하는 동안 옆에 띄워 두고 계속 보고 싶다 (기본 추천) | 실시간 보드 |
| 지금 상태를 한 번만 본다, 파일로 남긴다 | HTML 한 장 |
| 화면을 열 수 없다, 대화창에서 글로 받고 싶다 | 텍스트 요약 |

## 실시간 보드

백그라운드로 실행한다 (run_in_background). 출력 첫 줄의 주소를 사용자에게 알려 준다.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/board.mjs" --session "${CLAUDE_SESSION_ID}" --serve --open
```

- 2초마다 갱신된다. 턴이 끝나면 브라우저 알림을 보낼 수 있다 (화면의 「알림 켜기」).
- 바뀐 파일과 이미지를 기본 프로그램으로 열고, 로컬 주소가 켜져 있는지 표시한다.
- 127.0.0.1 에서만 열리고 주소에 든 열쇠가 있어야 접근된다. 기본 120분 동안 접속이 없으면 스스로 꺼진다 (`--ttl <분>`).

## HTML 한 장

```bash
node "${CLAUDE_SKILL_DIR}/scripts/board.mjs" --session "${CLAUDE_SESSION_ID}" --format html --open
```

## 텍스트 요약

```bash
node "${CLAUDE_SKILL_DIR}/scripts/board.mjs" --session "${CLAUDE_SESSION_ID}" --format text
```

## 옵션

| 옵션 | 뜻 |
|---|---|
| `--session <id>` | 볼 세션. 빼면 현재 폴더의 가장 최근 세션 |
| `--transcript <경로>` | 세션 기록 파일을 직접 지정 |
| `--format html\|text\|json` | 출력 형태 (기본 html) |
| `--out <경로>` | HTML 저장 위치 (기본 임시 폴더) |
| `--open` | 만든 화면을 기본 브라우저로 연다 |
| `--window <토큰수>` | 컨텍스트 창 크기. 주면 사용률(%)도 계산 |
| `--serve`, `--port <번호>`, `--ttl <분>` | 실시간 보드 |

## 결과를 전할 때

- 화면을 열었으면 주소나 파일 경로를 알려 주고, 눈에 띄는 것(남은 단계, 실패한 검사, 교차검증 지적)만 한두 줄로 덧붙인다.
- text: 출력된 요약을 그대로 길게 옮기지 말고, 사용자가 물은 부분 위주로 간추린다.
- 스크립트가 세션을 못 찾으면 `--transcript` 로 경로를 직접 주어 다시 실행한다.

## 진행판 쓰기

진행판 규칙은 한 곳에서만 온다.

- side-panel 플러그인이 꺼져 있으면 이 플러그인의 훅이 세션마다 `~/.claude/session-board/<세션ID>.md` 경로와 규칙을 알려 준다.
- side-panel 플러그인(`side-panel@...`)이 사용자, 프로젝트, 로컬 설정 중 어디서든 켜져 있으면 (뒤 설정이 앞 설정을 덮는다) 이 플러그인의 훅은 아무것도 알리지 않는다.
  side-panel 이 알려 주는 `~/.claude/session-plans/<세션ID>.md` 한 곳에만 쓰면 되고, 같은 내용을 session-board 폴더에 또 쓰지 않는다.

어느 훅 안내도 없으면 `~/.claude/session-board/<세션ID>.md` 에 다음 모양으로 직접 쓴다.

```markdown
# 이번 목표를 한 줄로
- [x] 마친 단계 - 한 일
- [ ] 아직 남은 단계
```

스크립트는 두 폴더의 파일을 모두 찾아보고, 둘 다 있으면 더 최근에 고친 파일을 보여 준다.
둘 다 없을 때는 세션 기록의 할 일 목록(TodoWrite 등)을 대신 보여 준다.
