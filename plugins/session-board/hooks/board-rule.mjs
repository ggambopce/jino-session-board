#!/usr/bin/env node
// session-board 훅. Copyright (c) 2026 JINO. MIT License.
// SessionStart / UserPromptSubmit 때 표준 입력으로 받은 세션 ID 로
// 이 세션의 보드 파일 경로를 계산해 Claude 에게 작성 규칙을 알려 준다.
// side-panel 플러그인이 켜져 있으면 그쪽 훅이 같은 규칙을 알리므로 아무것도 출력하지 않는다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mode = process.argv[2] === 'prompt' ? 'prompt' : 'start'

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch { return {} }
}

const input = readStdin()
const sessionId = String(input.session_id || '').replace(/[^0-9a-zA-Z_-]/g, '')
if (!sessionId) process.exit(0)

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const boardDir = path.join(configDir, 'session-board')
const boardFile = path.join(boardDir, `${sessionId}.md`).split(path.sep).join('/')

if (mode === 'start') {
  try { fs.mkdirSync(boardDir, { recursive: true }) } catch {}
}

// 설정 파일을 사용자 < 프로젝트 < 로컬 순서로 겹쳐 enabledPlugins 를 본다 (뒤에 오는 값이 이긴다).
// 읽거나 해석하지 못한 파일은 없는 것으로 친다.
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function sidePanelEnabled(cwd) {
  const merged = {}
  for (const file of [
    path.join(configDir, 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ]) {
    const plugins = readJson(file)?.enabledPlugins
    if (plugins && typeof plugins === 'object' && !Array.isArray(plugins)) Object.assign(merged, plugins)
  }
  return Object.entries(merged).some(([name, on]) => /^side-panel@/.test(name) && Boolean(on))
}

const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()
if (sidePanelEnabled(cwd)) process.exit(0)

if (mode === 'prompt') {
  console.log(
    `[session-board] 여러 단계가 필요한 요청이면 먼저 ${boardFile} 에 체크리스트를 적고, ` +
    `한 단계를 마칠 때마다 해당 줄을 [x] 로 바꾸며 한 일을 짧게 덧붙인다. ` +
    `이미 있는 파일은 읽은 다음에 고쳐 쓴다. 단답으로 끝나는 요청에는 쓰지 않는다.`
  )
  process.exit(0)
}

console.log(`[session-board] 이 세션의 보드 파일: ${boardFile}

사용자는 /session-board 로 이 파일과 세션 기록을 한 화면에서 확인한다. 다음처럼 관리한다.
1. 두 단계 이상 걸리는 요청을 받으면 작업 전에 보드 파일을 아래 모양으로 새로 쓴다.
2. 단계 하나가 끝나면 그 줄의 [ ] 를 [x] 로 바꾸고 " - 무엇을 했는지" 를 한 줄로 붙인다.
3. 다른 요청이 들어오면 새 목표로 갈아 쓴다. 한 번에 답할 수 있는 질문에는 만들지 않는다.
4. 파일이 이미 있으면 읽고 나서 쓴다.

# 이번 목표를 한 줄로
- [x] 마친 단계 - 한 일
- [ ] 아직 남은 단계`)
