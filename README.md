# jino-session-board

Claude Code 세션이 지금 어디까지 왔는지 보여 주는 보드와, 내 프로젝트 파일을 Codex 로 교차검증하는 기능을 묶은 플러그인입니다.
스킬 두 개와 훅 두 개로 이루어져 있고, Node.js 만 있으면 어떤 에디터나 터미널에서도 동작합니다.

## 스킬

### `/session-board` 세션 보드

Claude 에게 「진행판 보여줘」 라고 하면 브라우저에 보드가 열립니다.

| 탭 | 내용 |
|---|---|
| 진행판 | Claude 가 일을 시작하며 적은 체크리스트와 진행률. 지금 하는 단계를 강조 |
| 결과보고 | 턴마다 Claude 가 남긴 보고. 누르면 그 턴에 바꾼 파일, 캡처, 빌드 · 린트 · 타입 · 테스트 검사 결과와 보고 전문. 안 읽은 보고에 점, 에이전트가 끝나서 이어진 턴 표시. 말로만 답한 턴은 골라서 보기 |
| 컨텍스트 | 컨텍스트 사용률과 토큰 수, 모델, 마지막 응답. side-panel 사용량 기록이 있으면 항목별 비율과 계정 사용 한도 |
| 에이전트 | 띄운 하위 에이전트의 상태, 모델, 도구 횟수, 지금 하는 일, 받은 지시, 최근 한 일, 최종 보고 |
| 코덱스 | Codex 계정 한도(5시간, 주간), Codex 교차검증 결과(판정, 지적 사항)와 Claude 가 실행한 Codex 호출 |
| 결과물 | Claude 가 보내거나 열어 본 이미지. 크게 보기, 두 장 비교 |
| 주소 | 대화에 나온 URL. 로컬 주소는 켜져 있는지, 사내 IP 로 열기 |
| 바뀐 파일 | Claude 가 고치거나 새로 만든 파일과 횟수 |

보는 방식은 세 가지입니다.

- **실시간 보드** (`--serve`): 세션이 진행되는 대로 2초마다 갱신됩니다. 파일 열기, 로컬 주소 확인, 턴이 끝났을 때 브라우저 알림.
  - **프로젝트 보드** (`--project`, 스킬의 기본): 같은 작업 폴더의 세션들을 서버 하나, 탭 하나로 봅니다. 왼쪽 목록에 데스크톱 앱 사이드바와 같은 세션 제목, 마지막 활동, 진행판 진행률, 작업 중 표시가 나오고, 누르면 그 세션으로 넘어갑니다. 다른 세션에서 보드를 다시 열면 새 서버를 띄우지 않고, 열려 있는 탭을 그 세션으로 넘깁니다. 세션마다 서버와 탭을 따로 띄우던 때보다 메모리를 덜 씁니다.
  - 목록은 「켜져 있음」(Claude 프로세스가 살아 있는 세션)과 「꺼짐」(꺼졌지만 데스크톱 앱 사이드바에는 아직 있는 세션)으로 나뉩니다. 꺼졌고 앱에도 없는 세션(VS Code 나 터미널에서 닫은 세션, 앱에서 보관한 세션)은 맨 아래 「닫힌 세션 N개 보기」 안에 접어 둡니다. 닫힌 세션으로 넘어가면 이 목록이 한 번 저절로 펼쳐지고, 그 뒤로는 「닫힌 세션 접기」 단추로 언제든 접을 수 있습니다. 같은 폴더에서 VS Code 확장으로 연 세션에는 「VS Code」 표시가 붙습니다.
  - 닫힌 세션마다 있는 × 단추(「목록에서 빼기」)로 그 세션을 목록에서 뺄 수 있습니다. 펼친 닫힌 세션 아래의 「닫힌 세션 모두 목록에서 빼기」로 한꺼번에 뺄 수도 있습니다. 빼고 나면 「되돌리기」 안내가 뜨고, 뺀 세션이 있는 동안은 「목록에서 뺀 세션 N개 되돌리기」로 모두 되돌립니다. 보드 목록에서만 빠지고 대화 기록은 그대로입니다. 뺀 세션을 다시 켜거나 앱에서 열면 저절로 목록에 돌아옵니다. 뺀 세션은 `~/.claude/session-board/hidden.json` 에 적힙니다.
  - 목록 오른쪽 끝을 끌면 너비가 아이콘 너비부터 440px 까지 포인터를 부드럽게 따라갑니다. 이름이 보이는 가장 좁은 너비는 140px 이고, 112px 쯤보다 좁히면 아이콘으로 바뀝니다. 거기서 놓으면 아이콘만 남고, 나중에 다시 펼치면 전의 너비로 돌아갑니다. 위쪽 단추, 끝을 두 번 누르기, 화살표 키로 바꿀 때는 미끄러지듯 바뀝니다. 너비와 접힘은 브라우저에 기억됩니다.
  - 아이콘은 기본으로 두 글자(세션 이름 앞 두 낱말의 첫 글자)와 세션마다 다른 색으로 보이고, 켜져 있으면 초록 점, 작업 중이면 깜박이는 파란 점이 붙습니다. 마우스를 올리면 이름이 나옵니다. 아이콘을 두 번 누르거나 오른쪽 단추로 누르거나, 세션에 초점을 두고 F2 를 누르면 글자를 바꿀 수 있습니다. 네 글자까지 적고 Enter 를 누르면 되고, 길게 적으면 두 줄로 나눠 보입니다. 비워 두면 자동 글자로 돌아갑니다. 바꾼 글자는 `~/.claude/session-board/labels.json` 에 적힙니다.
  - 켜져 있는 세션 옆의 끄기 단추로 그 세션의 Claude 를 끌 수 있습니다. 누르면 하위 프로세스(MCP 서버, 셸) 수와 메모리를 먼저 보여 주고, 확인을 받아야 끕니다. 대화 기록은 남으니 앱이나 VS Code 에서 다시 열면 이어 갈 수 있습니다. 이 보드를 띄운 세션을 꺼도 보드는 켜 둡니다.
  - 무거운 분석은 고른 세션 하나만 하고, 세션 기록은 새로 붙은 줄만 읽습니다.
- **HTML 한 장**: 지금 상태를 파일 하나로 저장합니다.
- **텍스트 요약**: 대화창에서 글로 받습니다.

탭 줄 오른쪽 끝의 설정 단추에서 탭을 켜고 끄고 끌어서 순서를 바꿀 수 있고, 세션마다 따로 정할 수도 있습니다. 같은 메뉴에서 어두운 화면(기본)과 밝은 화면, 답이 끝났을 때의 알림을 고릅니다.

### `/codex-verify` Codex 교차검증

Claude 에게 「코덱스로 교차검증해줘」 라고 하면, 내 프로젝트 파일을 Codex CLI 에 읽기 전용으로 넘겨 독립 검토를 받습니다.
Claude 는 Codex 의 지적을 그대로 옮기지 않고 해당 코드를 다시 읽어 맞는지 확인한 뒤 정리해 줍니다.

| 이렇게 말하면 | 검토 대상 |
|---|---|
| 「src/pay.ts 코덱스로 검증해줘」 | 지정한 파일과 폴더 |
| 「커밋 전 변경분 코덱스로 확인해줘」 | git 변경분 |
| 「이번에 네가 고친 것 교차검증해줘」 | 이 세션에서 고친 파일 |
| 「프로젝트 전체 코덱스한테 검토시켜」 | 프로젝트 전체 |

결과는 판정(통과, 고칠 점 있음, 불합격)과 지적 사항(심각도, 위치, 내용, 제안)으로 나오고, 세션 보드의 코덱스 탭에 쌓입니다.
Codex CLI 가 설치되어 있고 `codex login` 으로 로그인되어 있어야 하며, 검토는 내 Codex 계정 한도를 씁니다.

## 설치

Claude Code 입력창에서:

```
/plugin marketplace add ggambopce/jino-session-board
/plugin install session-board@jino-session-board
```

필요한 것: Claude Code, Node.js 18 이상. 교차검증에는 Codex CLI.

## 직접 실행

```bash
node plugins/session-board/skills/session-board/scripts/board.mjs --project --serve --open
```

`--project` 를 빼면 세션 하나만 보는 보드가 뜹니다.

```bash
node plugins/session-board/skills/codex-verify/scripts/codex-verify.mjs --diff --focus "경계값 처리"
```

각 스크립트에 `--help` 를 주면 옵션이 나옵니다.

## 구성

```
.claude-plugin/marketplace.json            마켓플레이스 정의
plugins/session-board/
  .claude-plugin/plugin.json               플러그인 정의
  hooks/hooks.json, hooks/board-rule.mjs   진행판 파일 경로와 작성 규칙을 Claude 에게 알리는 훅 (side-panel 이 켜져 있으면 조용함)
  skills/session-board/SKILL.md
  skills/session-board/scripts/core.mjs    세션 기록 분석
  skills/session-board/scripts/board.mjs   출력과 실시간 서버
  skills/session-board/scripts/procs.mjs   켜져 있는 세션의 프로세스 찾기와 끄기
  skills/session-board/scripts/board.html  화면
  skills/codex-verify/SKILL.md
  skills/codex-verify/scripts/codex-verify.mjs
```

## 읽고 쓰는 파일

모두 내 컴퓨터 안에서만 처리합니다. 교차검증 때 Codex CLI 가 검토 대상 파일을 읽어 Codex 서비스로 보내는 것이 유일하게 밖으로 나가는 경로입니다.

- 읽기: `~/.claude/projects/` (세션 기록과 하위 에이전트 기록), `~/.claude/session-board/` (보드 파일, 교차검증 기록, 목록 설정), `~/.claude/session-plans/` (side-panel 진행판), `~/.claude/session-usage/` (side-panel 사용량 기록, 있을 때만), `~/.codex/sessions/` 와 `~/.codex/auth.json` 의 계정 ID (Codex 한도, 지금 계정의 기록만 고르는 데 씀), 설정 파일의 `enabledPlugins` (side-panel 이 켜져 있는지), `~/.claude/sessions/<pid>.json` (Claude Code 가 켜져 있는 세션마다 남기는 세션 ID 와 프로세스 시작 시각. 켜짐 표시와 끄기에 씀), 데스크톱 앱의 `claude-code-sessions/**/local_*.json` 앞부분 (세션 ID 와 보관 여부만. 앱 사이드바에 열려 있는 세션을 가리는 데 씀)
- 프로세스: 끄기를 누르면 프로세스 목록(Windows 는 PowerShell 의 `Get-CimInstance Win32_Process`, 그 밖은 `ps`)을 읽어 그 세션 프로세스와 하위 프로세스를 찾고, 확인을 받은 뒤에만 끕니다 (Windows 는 `taskkill /F`, 그 밖은 SIGTERM). 기록된 시작 시각과 실제 프로세스 시작 시각이 다르면 끄지 않습니다.
- 쓰기: Claude 가 `~/.claude/session-board/<세션ID>.md` 에 진행판을 적고 (side-panel 이 켜져 있으면 `~/.claude/session-plans/<세션ID>.md`), 교차검증 결과가 `~/.claude/session-board/codex/` 에 저장됩니다. 보드 목록 설정은 `~/.claude/session-board/` 의 `hidden.json`(목록에서 뺀 세션)과 `labels.json`(아이콘 글자)에 저장됩니다.
- 실시간 보드는 127.0.0.1 에서만 열리고, 주소에 든 임의의 열쇠가 없으면 응답하지 않습니다. 세션 기록에 나온 파일만 열 수 있습니다.

## 알아 둘 점

- 세션 기록 형식은 공식 규격이 아니어서 Claude Code 가 바뀌면 손봐야 할 수 있습니다.
- 바뀐 파일은 Claude 가 편집 도구로 고친 것만 잡힙니다. 셸 명령으로 만든 파일은 빠집니다.
- Claude 계정 사용 한도(5시간, 주간)와 비용은 세션 기록에 없어서, side-panel 의 사용량 기록(`~/.claude/session-usage/`)이 있을 때만 보여 줍니다.
- 컨텍스트 창 크기는 `--window` 로 주지 않으면 모델 이름으로 어림합니다 (haiku 200K, 그 밖은 1M).
- 하위 에이전트는 받은 지시, 최근 동작 몇 개, 최종 보고를 보여 줍니다. 전체 단계 기록은 보여 주지 않습니다.
- [side-panel](https://github.com/HOLYMOLYJUN/claude-side-panel) 플러그인(`side-panel@...`)과 함께 켜 두어도 됩니다. 사용자, 프로젝트(`.claude/settings.json`), 로컬(`.claude/settings.local.json`) 설정을 차례로 겹쳐 보아 side-panel 이 켜져 있으면 이 플러그인의 훅은 아무 안내도 하지 않고, Claude 는 side-panel 규칙대로 `~/.claude/session-plans/<세션ID>.md` 한 곳에만 진행판을 씁니다. 세션 보드는 그 파일도 읽으므로 데스크톱 앱의 「Claude 진행판」과 이 보드에 같은 체크리스트가 보입니다. side-panel 을 끄면 예전처럼 이 플러그인의 훅이 규칙을 알립니다.

## 만든 배경

[HOLYMOLYJUN/claude-side-panel](https://github.com/HOLYMOLYJUN/claude-side-panel) (Cursor, VS Code 확장)의
「세션 상태를 탭으로 모아 본다」는 아이디어에서 출발했습니다. 세션 분석과 서버는 에디터에 묶이지 않는 스킬 형태로
처음부터 새로 작성했고, 보드 화면(`board.html`)은 그 확장의 「Claude 진행판」 화면을 따라 CSS 일부와 아이콘 경로를 옮겨 왔습니다
(claude-side-panel: Copyright (c) 2026 HOLYMOLYJUN, MIT License. 아이콘 원본은 Phosphor Icons, MIT).

## 라이선스

MIT License. Copyright (c) 2026 JINO
