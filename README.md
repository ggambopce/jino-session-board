# jino-session-board

Claude Code 세션이 지금 어디까지 왔는지 한 장으로 보여 주는 플러그인입니다.
스킬 하나(`/session-board`)와 훅 두 개로 이루어져 있고, Node.js 만 있으면 어떤 에디터나 터미널에서도 동작합니다.

| 탭 | 내용 |
|---|---|
| 진행판 | Claude 가 일을 시작하며 적은 체크리스트와 진행률 |
| 결과보고 | 도구를 쓴 턴마다 Claude 가 남긴 마지막 보고, 그 턴에 바꾼 파일과 검사 결과 |
| 에이전트 | 띄운 하위 에이전트의 상태, 받은 지시, 최종 보고 |
| 바뀐 파일 | Claude 가 고치거나 새로 만든 파일과 횟수 |
| 검사 | 빌드, 린트, 타입, 테스트 명령과 통과 여부 |
| 주소 | 대화에 나온 URL (로컬 주소 우선) |
| 컨텍스트 | 현재 컨텍스트 토큰, 캐시 읽기와 쓰기, 누적 출력 |

## 설치

Claude Code 입력창에서:

```
/plugin marketplace add ggambopce/jino-session-board
/plugin install session-board@jino-session-board
```

필요한 것: Claude Code, Node.js 18 이상.

## 쓰는 법

- Claude 에게 「진행판 보여줘」 「세션 현황 정리해줘」 라고 하거나 `/session-board` 를 실행합니다.
- 기본은 HTML 한 장을 만들어 브라우저로 엽니다. 글로 받고 싶으면 「텍스트로」 라고 덧붙입니다.

스크립트를 직접 실행할 수도 있습니다.

```bash
node plugins/session-board/skills/session-board/scripts/board.mjs --format text
```

| 옵션 | 뜻 |
|---|---|
| `--session <id>` | 볼 세션. 빼면 현재 폴더의 가장 최근 세션 |
| `--transcript <경로>` | 세션 기록 파일 직접 지정 |
| `--format html\|text\|json` | 출력 형태 (기본 html) |
| `--out <경로>` | HTML 저장 위치 (기본 임시 폴더) |
| `--open` | 만든 HTML 을 기본 브라우저로 열기 |
| `--window <토큰수>` | 컨텍스트 창 크기. 주면 사용률도 표시 |

## 구성

```
.claude-plugin/marketplace.json        마켓플레이스 정의
plugins/session-board/
  .claude-plugin/plugin.json           플러그인 정의
  hooks/hooks.json                     SessionStart, UserPromptSubmit 훅
  hooks/board-rule.mjs                 보드 파일 경로와 작성 규칙을 Claude 에게 알림
  skills/session-board/SKILL.md        스킬 설명
  skills/session-board/scripts/board.mjs   세션 기록을 읽어 보드를 만드는 스크립트
```

## 읽고 쓰는 파일

모두 내 컴퓨터 안에서만 처리하고, 밖으로 보내는 것은 없습니다.

- 읽기: `~/.claude/projects/` (세션 기록), `~/.claude/session-board/` (보드 파일)
- 쓰기: Claude 가 `~/.claude/session-board/<세션ID>.md` 에 진행판을 적고, 스크립트가 HTML 한 장을 임시 폴더(또는 `--out` 경로)에 저장합니다.

## 알아 둘 점

- 세션 기록 형식은 공식 규격이 아니어서 Claude Code 가 바뀌면 손봐야 할 수 있습니다.
- 컨텍스트 탭은 가장 최근 응답의 사용량을 기준으로 하며, 계정 사용 한도는 보여 주지 않습니다.
- 같은 일을 하는 다른 진행판 플러그인과 함께 켜면 규칙 안내가 두 번 나옵니다. 하나만 켜 두세요.

## 만든 배경

[HOLYMOLYJUN/claude-side-panel](https://github.com/HOLYMOLYJUN/claude-side-panel) (Cursor, VS Code 확장)의
「세션 상태를 탭으로 모아 본다」는 아이디어에서 출발했습니다. 이 저장소의 코드는 그 확장의 코드를 가져오지 않고
에디터에 묶이지 않는 스킬 형태로 처음부터 새로 작성했습니다.

## 라이선스

MIT License. Copyright (c) 2026 JINO
