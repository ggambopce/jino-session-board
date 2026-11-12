---
name: session-board
description: 지금 Claude Code 세션의 진행 상황을 한눈에 보여 준다. 진행판 체크리스트, 턴별 결과보고, 하위 에이전트, 바뀐 파일, 빌드·테스트 검사 결과, 대화에 나온 주소, 컨텍스트 토큰을 세션 기록에서 뽑아 HTML 한 장 또는 텍스트 요약으로 만든다. 사용자가 "진행판 보여줘", "세션 보드", "지금까지 뭐 했어", "바뀐 파일 정리", "session board", "세션 현황" 처럼 세션 상태를 묻거나 /session-board 를 실행할 때 쓴다.
---

# 세션 보드

세션 기록(`~/.claude/projects/**/<세션ID>.jsonl`)과 보드 파일(`~/.claude/session-board/<세션ID>.md`)을
읽기만 해서 현황판을 만든다. 네트워크로 보내는 것은 없다.

## 실행

HTML 한 장으로 만들어 브라우저에서 열기 (기본):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/board.mjs" --session "${CLAUDE_SESSION_ID}" --format html --open
```

대화창에 바로 요약하기 (화면을 열 수 없는 환경이거나 사용자가 글로 달라고 할 때):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/board.mjs" --session "${CLAUDE_SESSION_ID}" --format text
```

옵션

| 옵션 | 뜻 |
|---|---|
| `--session <id>` | 볼 세션. 빼면 현재 폴더의 가장 최근 세션 |
| `--transcript <경로>` | 세션 기록 파일을 직접 지정 |
| `--format html\|text\|json` | 출력 형태 (기본 html) |
| `--out <경로>` | HTML 저장 위치 (기본 임시 폴더) |
| `--open` | 만든 HTML 을 기본 브라우저로 연다 |
| `--window <토큰수>` | 컨텍스트 창 크기. 주면 사용률(%)도 계산 |

## 결과를 전할 때

- html: 스크립트가 출력한 파일 경로를 알려 주고, 눈에 띄는 것(남은 단계, 실패한 검사)만 한두 줄로 덧붙인다.
- text: 출력된 요약을 그대로 길게 옮기지 말고, 사용자가 물은 부분 위주로 간추린다.
- 스크립트가 세션을 못 찾으면 `--transcript` 로 경로를 직접 주어 다시 실행한다.

## 진행판 쓰기

이 플러그인의 훅이 세션마다 보드 파일 경로와 규칙을 알려 준다. 훅 안내가 없으면
`~/.claude/session-board/<세션ID>.md` 에 다음 모양으로 직접 쓴다.

```markdown
# 이번 목표를 한 줄로
- [x] 마친 단계 - 한 일
- [ ] 아직 남은 단계
```

보드 파일이 없을 때는 스크립트가 세션 기록의 할 일 목록(TodoWrite 등)을 대신 보여 준다.
