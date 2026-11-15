// session-board core: 세션 기록을 읽어 보드 자료를 만든다.
// Copyright (c) 2026 JINO. MIT License. 의존성 없음 (Node 18+).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
export const projectsDir = path.join(configDir, 'projects')
export const boardDir = path.join(configDir, 'session-board')
export const codexDir = path.join(boardDir, 'codex')
// side-panel 플러그인이 쓰는 진행판 폴더. 그 훅은 CLAUDE_CONFIG_DIR 와 상관없이 ~/.claude 아래에 쓰므로 둘 다 본다.
export const planDirs = [...new Set([path.join(configDir, 'session-plans'), path.join(os.homedir(), '.claude', 'session-plans')])]
// side-panel 의 사용량 기록(항목별 컨텍스트, 계정 사용 한도). 없으면 보여 주지 않는다.
export const usageDirs = [...new Set([path.join(configDir, 'session-usage'), path.join(os.homedir(), '.claude', 'session-usage')])]
// Codex CLI 기록. 한도 값은 가장 최근 기록 끝에 남는다.
export const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')

// ---------- 세션 찾기 ----------
function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(dir, d.name)) }
  catch { return [] }
}

function newestJsonl(dirs) {
  let best = null
  for (const dir of dirs) {
    let names = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(dir, name)
      let mtime = 0
      try { mtime = fs.statSync(file).mtimeMs } catch { continue }
      if (!best || mtime > best.mtime) best = { file, mtime }
    }
  }
  return best && best.file
}

export function validSession(id) {
  return typeof id === 'string' && /^[0-9a-zA-Z_-]{8,}$/.test(id) ? id : undefined
}

export function findTranscript({ session, transcript, cwd } = {}) {
  if (transcript) return path.resolve(transcript)
  const all = listDirs(projectsDir)
  if (session) {
    for (const dir of all) {
      const file = path.join(dir, `${session}.jsonl`)
      if (fs.existsSync(file)) return file
    }
    return null
  }
  // 프로젝트 폴더 이름은 작업 경로의 영숫자 외 문자를 - 로 바꾼 것이다.
  const slug = (cwd || process.cwd()).replace(/[^0-9a-zA-Z]/g, '-').toLowerCase()
  const mine = all.filter(d => path.basename(d).toLowerCase() === slug)
  return newestJsonl(mine) || newestJsonl(all)
}

// ---------- 프로젝트: 같은 작업 폴더의 세션들 ----------
const slugOf = p => String(p).replace(/[^0-9a-zA-Z]/g, '-').toLowerCase()

// 프로젝트의 세션 기록 폴더들. project 는 작업 경로나 기록 폴더, 없으면 세션이 든 폴더, 그것도 없으면 지금 폴더다.
// 윈도에서는 D--Work 와 d--Work 가 같은 폴더로 보이므로 실제 폴더 기준으로 한 번만 넣는다.
export function projectDirs({ project, session, cwd } = {}) {
  const all = listDirs(projectsDir)
  let name = ''
  if (project && all.some(d => d.toLowerCase() === path.resolve(project).toLowerCase())) name = path.basename(project)
  else if (project) name = slugOf(path.resolve(project))
  else if (session) { const f = findTranscript({ session }); if (f) name = path.basename(path.dirname(f)) }
  if (!name) name = slugOf(cwd || process.cwd())
  const seen = new Set(), out = []
  for (const d of all) {
    if (path.basename(d).toLowerCase() !== name.toLowerCase()) continue
    let id
    try { const st = fs.statSync(d); id = st.dev + ':' + st.ino } catch { continue }
    if (seen.has(id)) continue
    seen.add(id)
    out.push(d)
  }
  return out
}

export function sessionFile(dirs, id) {
  if (!validSession(id)) return null
  for (const d of dirs) {
    const file = path.join(d, `${id}.jsonl`)
    if (fs.existsSync(file)) return file
  }
  return null
}

// ---------- 기록 읽기 ----------
// 파일에 새로 붙은 줄만 읽는다. 처음 읽을 때도 조각씩 읽어 큰 기록을 한꺼번에 메모리에 올리지 않는다.
// 줄바꿈(0x0A)은 UTF-8 글자 중간에 나오지 않으므로 줄 단위로 끊으면 글자가 깨지지 않는다.
const CHUNK = 4 * 1024 * 1024
function readNewLines(c, file, size, onLine) {
  let fd
  try { fd = fs.openSync(file, 'r') } catch { return }
  try {
    while (c.offset < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - c.offset))
      const n = fs.readSync(fd, buf, 0, buf.length, c.offset)
      if (n <= 0) break
      c.offset += n
      const all = c.rest.length ? Buffer.concat([c.rest, buf.subarray(0, n)]) : buf.subarray(0, n)
      const cut = all.lastIndexOf(10)
      // 남은 조각은 복사해 두어 읽은 덩어리 전체가 메모리에 남지 않게 한다.
      c.rest = Buffer.from(cut < 0 ? all : all.subarray(cut + 1))
      if (cut < 0) continue
      for (const line of all.toString('utf8', 0, cut).split('\n')) if (line.trim()) onLine(line)
    }
  } catch { /* 읽는 도중 파일이 바뀌면 다음에 이어 읽는다 */ }
  finally { fs.closeSync(fd) }
}

// 세션마다 분석 상태를 들고 있다가 새 줄만 더한다. 프로젝트 보드에서 세션을 오가도 몇 개만 남긴다.
const sessionReaders = new Map()
const KEEP_READERS = 3
function readSession(file) {
  let size = 0
  try { size = fs.statSync(file).size } catch {}
  let c = sessionReaders.get(file)
  if (!c || size < c.offset) c = { offset: 0, rest: Buffer.alloc(0), an: createAnalyzer() }
  sessionReaders.delete(file)
  sessionReaders.set(file, c)
  while (sessionReaders.size > KEEP_READERS) sessionReaders.delete(sessionReaders.keys().next().value)
  const feed = line => { let e; try { e = JSON.parse(line) } catch { return } c.an.feed(e) }
  readNewLines(c, file, size, feed)
  // 마지막 줄이 줄바꿈 없이 끝났으면 완성된 줄인지 보고 넣는다 (쓰는 중인 줄이면 다음에 이어 읽는다).
  if (c.rest.length && c.offset >= size) {
    let e
    try { e = JSON.parse(c.rest.toString('utf8')) } catch {}
    if (e) { c.rest = Buffer.alloc(0); c.an.feed(e) }
  }
  return c.an.result()
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const AGENT_TOOLS = new Set(['Agent', 'Task'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i

const CHECK_RULES = [
  ['테스트', /\b(jest|vitest|pytest|mocha|playwright test|go test|cargo test|dotnet test|phpunit|rspec|gradlew? test|mvn test|(npm|pnpm|yarn|bun)( run)? test\S*)\b/i],
  ['타입', /\b(tsc|mypy|pyright|(npm|pnpm|yarn|bun)( run)? (typecheck|type-check|check-types))\b/i],
  ['린트', /\b(eslint|biome|ruff|flake8|pylint|stylelint|golangci-lint|clippy|(npm|pnpm|yarn|bun)( run)? lint\S*)\b/i],
  ['빌드', /\b(vite build|next build|webpack|cargo build|go build|dotnet build|gradlew? (build|assemble)|mvn (package|install)|(npm|pnpm|yarn|bun)( run)? build\S*)\b/i],
]
const checkKind = command => { for (const [label, re] of CHECK_RULES) if (re.test(command)) return label; return null }

function blocksOf(entry) {
  const c = entry && entry.message && entry.message.content
  if (typeof c === 'string') return [{ type: 'text', text: c }]
  return Array.isArray(c) ? c : []
}

function resultText(block) {
  const c = block.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter(b => b && b.type === 'text').map(b => b.text).join('\n')
  return ''
}

export function clip(text, max) {
  const t = String(text || '').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function cleanPrompt(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(command-[a-z]+|local-command-[a-z]+|browser_instruction|ide_selection|ide_opened_file)>[\s\S]*?<\/\1>/g, '')
    .trim()
}

// 백그라운드 일이 끝났다는 알림(<task-notification>)을 읽는다.
function parseNotices(text) {
  const out = []
  for (const m of String(text || '').matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const tag = k => ((m[1].match(new RegExp(`<${k}>([\\s\\S]*?)</${k}>`)) || [])[1] || '').trim()
    out.push({ taskId: tag('task-id'), toolUseId: tag('tool-use-id'), status: tag('status'), summary: tag('summary') })
  }
  return out
}
const NOTICE_STATUS = { completed: 'done', failed: 'failed', killed: 'stopped', stopped: 'stopped' }

// 하위 에이전트가 한 일을 한 줄로
const baseName = p => String(p || '').split(/[\\/]/).pop()
function brief(name, i) {
  if (name === 'Read') return '읽기 · ' + baseName(i.file_path)
  if (EDIT_TOOLS.has(name)) return '고치기 · ' + baseName(i.file_path || i.notebook_path)
  if (SHELL_TOOLS.has(name)) return '명령 · ' + (i.description || String(i.command || '').split('\n')[0])
  if (name === 'Grep' || name === 'Glob') return '찾기 · ' + (i.pattern || '')
  if (name === 'WebSearch') return '웹 검색 · ' + (i.query || '')
  if (name === 'WebFetch') return '웹 읽기 · ' + (i.url || '')
  if (AGENT_TOOLS.has(name)) return '에이전트 · ' + (i.description || '')
  if (name === 'SubagentHandback') return '보고 · 최종 보고를 넘김'
  return String(name).replace(/^mcp__(.+?)__(.+)$/, '$1 · $2')
}

function parseTodos(input) {
  const list = input && (input.todos || input.items)
  if (!Array.isArray(list) || !list.length) return null
  const items = list.filter(t => t && typeof t.content === 'string')
    .map(t => ({ text: t.content, done: t.status === 'completed', active: t.status === 'in_progress', note: '' }))
  return items.length ? items : null
}

// 기록 한 줄씩 feed 로 넣고, result 로 지금까지의 모습을 얻는다. 실시간 보드는 새 줄만 넣는다.
function createAnalyzer() {
  const s = {
    sessionId: '', title: '', titles: { custom: '', agent: '', ai: '' }, cwd: '', branch: '', model: '', started: '', updated: '',
    turns: [], files: new Map(), agents: [], checks: [], urls: new Map(), images: new Map(), codexCalls: [], todos: null,
    context: { tokens: 0, input: 0, cacheRead: 0, cacheWrite: 0 }, contextAt: '', outputTokens: 0, toolCalls: 0, busy: false,
  }
  const pending = new Map()
  const outputByMessage = new Map()
  // 에이전트는 Agent 호출 ID 와, 백그라운드로 띄운 뒤 받는 에이전트 ID 둘 다로 찾는다.
  const agentByTool = new Map(), agentById = new Map()
  let turn = null
  const newTurn = (at, prompt, by = 'me') => { turn = { at, prompt, by, report: '', reportMsg: '', tools: 0, ended: false, files: new Set(), checks: [], images: new Set() }; s.turns.push(turn) }
  const addImage = (file, at, via) => {
    if (typeof file !== 'string' || !IMAGE_RE.test(file)) return
    if (!s.images.has(file)) s.images.set(file, { path: file, at, via })
    if (turn) turn.images.add(file)
  }
  // 에이전트나 백그라운드 명령이 끝났다는 알림. 답을 마친 뒤에 오면 그 알림이 새 턴을 연다.
  const onNotices = (text, at) => {
    const list = parseNotices(text)
    for (const n of list) {
      const a = agentById.get(n.taskId) || agentByTool.get(n.toolUseId)
      if (a && NOTICE_STATUS[n.status]) { a.status = NOTICE_STATUS[n.status]; a.finished = at }
      n.agent = a
    }
    if (list.length && (!turn || turn.ended)) {
      const n = list.find(x => x.agent) || list[0]
      newTurn(at, clip(n.summary || (n.agent ? '에이전트 작업 끝남' : '백그라운드 작업 끝남'), 400), n.agent ? 'agent' : 'task')
    }
    return list.length > 0
  }

  function feed(e) {
    if (e.sessionId && !s.sessionId) s.sessionId = e.sessionId
    // 제목: 사용자가 붙인 이름, 에이전트 이름, 자동 제목 순으로 쓴다.
    if (e.customTitle) s.titles.custom = e.customTitle
    if (e.agentName) s.titles.agent = e.agentName
    if (e.aiTitle) s.titles.ai = e.aiTitle
    if (e.isSidechain) return
    if (e.timestamp) { if (!s.started) s.started = e.timestamp; s.updated = e.timestamp }
    if (e.cwd) s.cwd = e.cwd
    if (e.gitBranch) s.branch = e.gitBranch

    if (e.type === 'attachment' && e.attachment) {
      const p = e.attachment.prompt
      if (p) onNotices(typeof p === 'string' ? p : Array.isArray(p) ? p.map(x => (x && x.text) || '').join('\n') : '', e.timestamp || '')
      return
    }

    if (e.type === 'user') {
      const blocks = blocksOf(e)
      const results = blocks.filter(b => b.type === 'tool_result')
      for (const r of results) {
        const text = resultText(r)
        for (const hit of text.matchAll(/\[Image: source: ([^\]\n]+)\]/g)) addImage(hit[1].trim(), e.timestamp || '', '도구 결과')
        const target = pending.get(r.tool_use_id)
        if (!target) continue
        pending.delete(r.tool_use_id)
        const failed = r.is_error === true
        if (target.kind === 'agent') {
          const a = target.ref, info = e.toolUseResult && typeof e.toolUseResult === 'object' ? e.toolUseResult : {}
          if (info.agentId) { a.agentId = info.agentId; agentById.set(info.agentId, a) }
          if (info.resolvedModel) a.model = info.resolvedModel
          if (info.totalToolUseCount) a.tools = info.totalToolUseCount
          // 백그라운드로 띄운 에이전트는 여기서 시작만 알리고, 끝은 알림으로 온다.
          if (failed) Object.assign(a, { status: 'failed', result: clip(text, 4000), finished: e.timestamp || '' })
          else if (info.status === 'async_launched' || info.isAsync) a.status = 'running'
          else Object.assign(a, { status: 'done', result: clip(text, 4000), finished: e.timestamp || '' })
        } else if (target.kind === 'check') {
          target.ref.status = failed ? 'fail' : 'pass'
          if (failed) target.ref.output = clip(text, 800)
        } else if (target.kind === 'codex') {
          Object.assign(target.ref, { status: failed ? 'failed' : 'done', output: clip(text, 3000), finished: e.timestamp || '' })
        } else if (target.kind === 'edit' && failed) {
          const f = s.files.get(target.ref)
          if (f) { f.count--; if (f.count <= 0) s.files.delete(target.ref) }
          if (turn) turn.files.delete(target.ref)
        }
      }
      if (results.length || e.isMeta) return
      const raw = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n')
      if (onNotices(raw, e.timestamp || '')) return
      const text = cleanPrompt(raw)
      if (!text) return
      newTurn(e.timestamp || '', clip(text, 400))
      s.busy = true
      return
    }

    if (e.type !== 'assistant') return
    const m = e.message || {}
    if (m.model && !/synthetic/.test(m.model)) s.model = m.model
    if (m.usage) {
      const u = m.usage
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      if (ctx > 0) { s.context = { tokens: ctx, input: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 }; s.contextAt = e.timestamp || '' }
      // 한 응답이 블록마다 여러 줄로 나뉘며 같은 usage 를 되풀이하므로 응답 ID 별로 한 번만 센다.
      if (m.id) outputByMessage.set(m.id, Math.max(outputByMessage.get(m.id) || 0, u.output_tokens || 0))
    }
    if (!turn) newTurn(e.timestamp || '', '')
    if (m.stop_reason === 'end_turn') { s.busy = false; turn.ended = true }
    else if (m.stop_reason === 'tool_use') s.busy = true

    for (const b of blocksOf(e)) {
      if (b.type === 'text' && b.text && b.text.trim()) {
        // 같은 응답이 여러 줄로 나뉘어 오면 이어 붙이고, 새 응답이면 그것으로 바꾼다.
        turn.report = m.id && m.id === turn.reportMsg ? turn.report + '\n\n' + b.text.trim() : b.text.trim()
        turn.reportMsg = m.id || ''
        turn.reportAt = e.timestamp || ''
        for (const hit of b.text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
          const url = hit[0].replace(/[.,;:!?*]+$/, '')
          if (!s.urls.has(url)) s.urls.set(url, { url, at: e.timestamp || '', local: /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(url) })
        }
      }
      if (b.type !== 'tool_use') continue
      s.toolCalls++
      turn.tools++
      const input = b.input || {}
      const at = e.timestamp || ''
      if (EDIT_TOOLS.has(b.name)) {
        const file = input.file_path || input.notebook_path
        if (!file) continue
        const f = s.files.get(file) || { path: file, count: 0, created: false, last: '' }
        f.count++
        if (b.name === 'Write' && f.count === 1) f.created = true
        f.last = at
        s.files.set(file, f)
        turn.files.add(file)
        pending.set(b.id, { kind: 'edit', ref: file })
      } else if (AGENT_TOOLS.has(b.name)) {
        const agent = { id: b.id, agentId: '', name: input.description || input.name || input.subagent_type || '에이전트', type: input.subagent_type || 'general-purpose', model: input.model || '', prompt: clip(input.prompt, 4000), status: 'running', result: '', started: at, finished: '', tools: 0 }
        s.agents.push(agent)
        agentByTool.set(b.id, agent)
        pending.set(b.id, { kind: 'agent', ref: agent })
      } else if (b.name === 'SendMessage') {
        // 끝난 에이전트에게 말을 보내면 다시 일한다.
        const a = agentById.get(input.to) || s.agents.find(x => x.name === input.to)
        if (a) { a.status = 'running'; a.finished = '' }
      } else if (SHELL_TOOLS.has(b.name) && typeof input.command === 'string') {
        if (/\bcodex(\.cmd)?\s+(exec|review)\b|codex-verify\.mjs/.test(input.command)) {
          const call = { command: clip(input.command, 500), note: input.description || '', status: 'running', output: '', started: at, finished: '' }
          s.codexCalls.push(call)
          pending.set(b.id, { kind: 'codex', ref: call })
          continue
        }
        const kind = checkKind(input.command)
        if (!kind) continue
        const check = { kind, command: clip(input.command, 300), status: 'running', output: '', at }
        s.checks.push(check)
        turn.checks.push(check)
        pending.set(b.id, { kind: 'check', ref: check })
      } else if (b.name === 'Read') {
        addImage(input.file_path, at, '열어 봄')
      } else if (b.name === 'SendUserFile') {
        for (const f of Array.isArray(input.files) ? input.files : []) addImage(f, at, '보냄')
      } else {
        const todos = parseTodos(input)
        if (todos) s.todos = todos
        else if (input.advance === true && s.todos) {
          // 목록 전체를 다시 보내지 않고 다음 단계로 넘기는 호출
          const i = s.todos.findIndex(t => t.active)
          if (i >= 0) { s.todos[i].active = false; s.todos[i].done = true }
          const nextUp = s.todos.find(t => !t.done)
          if (nextUp) nextUp.active = true
        }
      }
    }
  }
  // 몇 번을 불러도 같은 값이 나오도록 누적하지 않고 새로 센다.
  function result() {
    s.outputTokens = 0
    for (const v of outputByMessage.values()) s.outputTokens += v
    s.title = s.titles.custom || s.titles.agent || s.titles.ai
    return s
  }
  return { feed, result }
}

// ---------- 프로젝트 세션 목록 ----------
// 목록에는 제목, 첫 요청, 작업 중 여부만 필요하다. 제목 줄과 사용자 요청 줄만 JSON 으로 풀고 나머지는 글자만 훑는다.
const metaReaders = new Map()
function scanMeta(file, size) {
  let c = metaReaders.get(file)
  if (!c || size < c.offset) c = { offset: 0, rest: Buffer.alloc(0), custom: '', agent: '', ai: '', prompt: '', cwd: '', busy: false }
  metaReaders.set(file, c)
  readNewLines(c, file, size, line => {
    if (line.includes('"isSidechain":true')) return
    if (line.includes('"customTitle":"') || line.includes('"agentName":"') || line.includes('"aiTitle":"')) {
      try { const e = JSON.parse(line); if (e.customTitle) c.custom = e.customTitle; if (e.agentName) c.agent = e.agentName; if (e.aiTitle) c.ai = e.aiTitle } catch {}
      return
    }
    if (!c.cwd) { const m = line.match(/"cwd":("(?:[^"\\]|\\.)*")/); if (m) try { c.cwd = JSON.parse(m[1]) } catch {} }
    if (line.includes('"stop_reason":"end_turn"')) { c.busy = false; return }
    if (line.includes('"stop_reason":"tool_use"')) { c.busy = true; return }
    if (!line.includes('"type":"user"') || line.includes('"tool_result"') || line.includes('"isMeta":true')) return
    let e
    try { e = JSON.parse(line) } catch { return }
    if (e.type !== 'user') return
    const raw = blocksOf(e).filter(b => b.type === 'text').map(b => b.text).join('\n')
    if (parseNotices(raw).length) return
    const text = cleanPrompt(raw)
    if (!text) return
    if (!c.prompt) c.prompt = clip(text.split('\n').find(x => x.trim()), 120)
    c.busy = true
  })
  return c
}

function boardSummary(sessionId) {
  const b = readBoard(sessionId)
  return b ? { goal: b.goal, done: b.items.filter(i => i.done).length, total: b.items.length } : null
}

// 최근에 바뀐 순서로 limit 개. 15분 넘게 조용한 세션은 작업 중으로 치지 않는다 (끊긴 세션).
export function listSessions(dirs, limit = 50) {
  const files = []
  for (const d of dirs) {
    let names = []
    try { names = fs.readdirSync(d) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      const file = path.join(d, n)
      try { const st = fs.statSync(file); files.push({ file, id: n.slice(0, -6), mtime: st.mtimeMs, size: st.size }) } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const out = []
  for (const f of files) {
    if (out.length >= limit) break
    const m = scanMeta(f.file, f.size)
    const title = m.custom || m.agent || m.ai
    if (!title && !m.prompt) continue
    out.push({ id: f.id, title, prompt: m.prompt, cwd: m.cwd, updated: new Date(f.mtime).toISOString(), busy: m.busy && Date.now() - f.mtime < 15 * 60000, board: boardSummary(f.id) })
  }
  return out
}

// ---------- 하위 에이전트 기록 ----------
// <세션 폴더>/subagents/agent-<ID>.jsonl 에 남는다. 옆 meta.json 의 toolUseId 로 Agent 호출과 짝짓는다.
// 실시간 보드에서는 같은 파일을 계속 다시 읽으므로 새로 붙은 줄만 읽는다.
const agentLogs = new Map()
function readAgentLog(file) {
  let st
  try { st = fs.statSync(file) } catch { return null }
  let c = agentLogs.get(file)
  if (!c || st.size < c.offset) c = { offset: 0, rest: Buffer.alloc(0), tools: 0, steps: [], final: '', last: '', model: '' }
  if (st.size > c.offset) {
    const buf = Buffer.alloc(st.size - c.offset)
    try { const fd = fs.openSync(file, 'r'); fs.readSync(fd, buf, 0, buf.length, c.offset); fs.closeSync(fd) } catch { return c }
    c.offset = st.size
    const all = c.rest.length ? Buffer.concat([c.rest, buf]) : buf
    const cut = all.lastIndexOf(10)
    c.rest = cut < 0 ? all : all.subarray(cut + 1)
    for (const line of cut < 0 ? [] : all.toString('utf8', 0, cut).split('\n')) {
      if (!line.includes('"assistant"')) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (o.type !== 'assistant') continue
      const m = o.message || {}
      if (m.model && !/synthetic/.test(m.model)) c.model = m.model
      if (o.timestamp) c.last = o.timestamp
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'text' && b.text && b.text.trim()) { c.final = b.text.trim(); c.steps.push({ text: clip(b.text.split('\n').find(x => x.trim()), 200), at: o.timestamp || '' }) }
        if (b.type === 'tool_use') {
          c.tools++
          c.steps.push({ tool: clip(brief(b.name, b.input || {}), 200), at: o.timestamp || '' })
          if (b.name === 'SubagentHandback' && b.input && b.input.message) c.final = String(b.input.message).trim()
        }
      }
      if (c.steps.length > 40) c.steps = c.steps.slice(-20)
    }
  }
  agentLogs.set(file, c)
  return c
}

function attachAgentLogs(transcript, sessionId, agents) {
  const dir = path.join(path.dirname(transcript), sessionId, 'subagents')
  let names
  try { names = fs.readdirSync(dir) } catch { return }
  const byTool = new Map(agents.map(a => [a.id, a]))
  for (const n of names) {
    if (!n.endsWith('.meta.json')) continue
    let meta
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) } catch { continue }
    const a = byTool.get(meta.toolUseId)
    if (!a) continue
    const log = readAgentLog(path.join(dir, n.replace(/\.meta\.json$/, '.jsonl')))
    if (meta.finished && a.status === 'running') a.status = 'done'
    if (!log) continue
    if (!a.model) a.model = log.model
    a.tools = Math.max(a.tools || 0, log.tools)
    a.last = log.last
    a.steps = log.steps.slice(-12)
    const now = log.steps[log.steps.length - 1]
    a.now = now ? now.tool || now.text || '' : ''
    if (log.final && a.status !== 'running') a.report = clip(log.final, 6000)
  }
}

// ---------- 사용량과 한도 ----------
function readJsonNewest(files) {
  let best = null
  for (const file of files) {
    let mtime
    try { mtime = fs.statSync(file).mtimeMs } catch { continue }
    if (!best || mtime > best.mtime) best = { file, mtime }
  }
  if (!best) return null
  try { return JSON.parse(fs.readFileSync(best.file, 'utf8')) } catch { return null }
}

// Codex 한도는 계정 단위다. 지금 로그인한 계정이 만든 가장 최근 기록의 끝에서 마지막 한도 값을 찾는다.
let codexLimitCache = { at: 0, key: '', value: null }
export function codexLimits() {
  if (Date.now() - codexLimitCache.at < 15000) return codexLimitCache.value
  const root = path.join(codexHome, 'sessions')
  let account = ''
  try { account = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8')).tokens.account_id || '' } catch {}
  const all = []
  for (let i = 0; i < 14; i++) {
    const day = new Date(Date.now() - i * 864e5)
    const dir = path.join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    let names
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      try { all.push({ file: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs }) } catch {}
    }
  }
  all.sort((a, b) => b.mtime - a.mtime)
  // 첫 줄에 기록을 만든 계정이 적혀 있다. 계정을 바꾸면 이전 계정 한도가 보이지 않게 한다.
  const accountOf = file => {
    try {
      const buf = Buffer.alloc(16384), fd = fs.openSync(file, 'r'), n = fs.readSync(fd, buf, 0, buf.length, 0)
      fs.closeSync(fd)
      return (buf.toString('utf8', 0, n).match(/"creator_account_id":"([^"]*)"/) || [])[1] || ''
    } catch { return '' }
  }
  const newest = all.find(x => !account || accountOf(x.file) === account)
  let value = null
  if (!newest) value = all.length ? { none: true } : null
  else if (codexLimitCache.key === newest.file + ':' + newest.mtime) value = codexLimitCache.value
  else {
    try {
      const size = fs.statSync(newest.file).size, len = Math.min(size, 1024 * 1024), buf = Buffer.alloc(len)
      const fd = fs.openSync(newest.file, 'r')
      fs.readSync(fd, buf, 0, len, size - len)
      fs.closeSync(fd)
      for (const l of buf.toString('utf8').split('\n').reverse()) {
        if (!l.includes('"rate_limits"')) continue
        try {
          const o = JSON.parse(l), r = o.payload && o.payload.rate_limits
          if (r && r.primary) {
            value = { at: o.timestamp || '', plan: r.plan_type || '', windows: [r.primary, r.secondary].filter(Boolean).map(w => ({ minutes: w.window_minutes, usedPercent: w.used_percent, resetsAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : '' })) }
            break
          }
        } catch {}
      }
    } catch {}
  }
  codexLimitCache = { at: Date.now(), key: newest ? newest.file + ':' + newest.mtime : '', value }
  return value
}

// ---------- 보드 파일 ----------
// 이 플러그인의 session-board 와 side-panel 의 session-plans 중 있는 파일을 읽고, 둘 다 있으면 더 최근에 고친 쪽을 고른다.
export function boardFileOf(sessionId) {
  let best = null
  for (const dir of [boardDir, ...planDirs]) {
    const file = path.join(dir, `${sessionId}.md`)
    let mtime
    try { mtime = fs.statSync(file).mtimeMs } catch { continue }
    if (!best || mtime > best.mtime) best = { file, mtime }
  }
  return best && best.file
}

function readBoard(sessionId) {
  const file = boardFileOf(sessionId)
  if (!file) return null
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  const board = { goal: '', items: [], notes: [], file }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const head = line.match(/^#+\s+(.*)$/)
    if (head && !board.goal) { board.goal = head[1]; continue }
    const item = line.match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/)
    // 단계가 아닌 줄은 진행판 아래에 덧붙이는 메모로 둔다.
    if (!item) { if (line) board.notes.push(line); continue }
    const cut = item[2].indexOf(' - ')
    board.items.push({ done: item[1] !== ' ', active: false, text: cut > 0 ? item[2].slice(0, cut) : item[2], note: cut > 0 ? item[2].slice(cut + 3) : '' })
  }
  return board.items.length || board.goal ? board : null
}

// ---------- Codex 교차검증 기록 ----------
export function readVerifications(sessionId) {
  const out = []
  for (const dir of [path.join(codexDir, sessionId || '_'), path.join(codexDir, 'adhoc')]) {
    let names = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try { out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))) } catch {}
    }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

export function buildData(file, opt = {}) {
  const s = readSession(file)
  if (!s.sessionId) s.sessionId = path.basename(file, '.jsonl')
  let board = readBoard(s.sessionId)
  let source = 'file'
  if (!board && s.todos) { board = { goal: '', items: s.todos }; source = 'todos' }
  const done = board ? board.items.filter(i => i.done).length : 0
  const exists = p => { try { return fs.existsSync(p) } catch { return false } }
  const cwdNorm = path.resolve(s.cwd || '.').toLowerCase()
  const verifications = readVerifications(s.sessionId).filter(v => v.session === s.sessionId || path.resolve(v.cwd || '.').toLowerCase() === cwdNorm)
  attachAgentLogs(file, s.sessionId, s.agents)
  for (const a of s.agents) a.at = a.finished || a.last || a.started
  // 턴 하나가 결과보고 하나다. 도구를 쓴 턴은 reports, 말로만 답한 턴은 replies 에 둔다.
  const turn = (t, i) => ({
    id: `${i}:${t.at}`, at: t.reportAt || t.at, prompt: t.prompt, by: t.by, ended: t.ended, report: clip(t.report, 6000), tools: t.tools,
    files: [...t.files], images: [...t.images], checks: t.checks.map(c => ({ kind: c.kind, status: c.status, command: c.command, output: c.output })),
  })
  const turns = s.turns.map((t, i) => [t, i]).filter(([t]) => t.report)
  const usage = readJsonNewest(usageDirs.map(d => path.join(d, `${s.sessionId}.json`)))
  const limits = readJsonNewest(usageDirs.map(d => path.join(d, '_limits.json')))
  return {
    generated: new Date().toISOString(),
    session: { id: s.sessionId, title: s.title, cwd: s.cwd, branch: s.branch, model: s.model, started: s.started, updated: s.updated, transcript: file, busy: s.busy },
    board: board ? { ...board, source, done, total: board.items.length } : null,
    reports: turns.filter(([t]) => t.tools > 0).map(([t, i]) => turn(t, i)).reverse(),
    replies: turns.filter(([t]) => t.tools === 0).map(([t, i]) => turn(t, i)).reverse(),
    agents: s.agents.slice().reverse(),
    files: [...s.files.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)),
    checks: s.checks.slice().reverse(),
    urls: [...s.urls.values()].sort((a, b) => Number(b.local) - Number(a.local)),
    images: [...s.images.values()].map(i => ({ ...i, gone: !exists(i.path) })).reverse(),
    codex: { calls: s.codexCalls.slice().reverse(), verifications, limits: codexLimits() },
    context: {
      ...s.context, window: opt.window || null, percent: opt.window ? Math.round((s.context.tokens / opt.window) * 1000) / 10 : null, output: s.outputTokens,
      // --window 가 없을 때 화면이 쓰는 어림값 (side-panel 과 같이 haiku 는 200K, 그 밖은 1M)
      at: s.contextAt, guessWindow: /haiku/i.test(s.model) ? 200000 : 1000000,
      usage: usage && usage.context ? { window: usage.context.window || null, tokens: usage.context.tokens ?? null, percent: usage.context.percent ?? null, categories: Array.isArray(usage.context.categories) ? usage.context.categories : [], cost: usage.cost ?? null } : null,
      limits: limits && Array.isArray(limits.rateLimits) ? { at: limits.at || '', rateLimits: limits.rateLimits } : null,
    },
    counts: { turns: s.turns.filter(t => t.prompt && t.by === 'me').length, tools: s.toolCalls },
  }
}
