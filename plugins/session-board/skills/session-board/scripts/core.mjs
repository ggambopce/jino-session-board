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

// ---------- 기록 읽기 ----------
function readEntries(file) {
  const out = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 쓰는 중인 마지막 줄 */ }
  }
  return out
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
    .replace(/<(command-[a-z]+|local-command-[a-z]+)>[\s\S]*?<\/\1>/g, '')
    .trim()
}

function parseTodos(input) {
  const list = input && (input.todos || input.items)
  if (!Array.isArray(list) || !list.length) return null
  const items = list.filter(t => t && typeof t.content === 'string')
    .map(t => ({ text: t.content, done: t.status === 'completed', active: t.status === 'in_progress', note: '' }))
  return items.length ? items : null
}

function analyze(entries) {
  const s = {
    sessionId: '', title: '', cwd: '', branch: '', model: '', started: '', updated: '',
    turns: [], files: new Map(), agents: [], checks: [], urls: new Map(), images: new Map(), codexCalls: [], todos: null,
    context: { tokens: 0, input: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: 0, toolCalls: 0, busy: false,
  }
  const pending = new Map()
  const outputByMessage = new Map()
  let turn = null
  const newTurn = (at, prompt) => { turn = { at, prompt, report: '', tools: 0, files: new Set(), checks: [], images: new Set() }; s.turns.push(turn) }
  const addImage = (file, at, via) => {
    if (typeof file !== 'string' || !IMAGE_RE.test(file)) return
    if (!s.images.has(file)) s.images.set(file, { path: file, at, via })
    if (turn) turn.images.add(file)
  }

  for (const e of entries) {
    if (e.sessionId && !s.sessionId) s.sessionId = e.sessionId
    if (e.type === 'custom-title' && e.customTitle) s.title = e.customTitle
    if (e.isSidechain) continue
    if (e.timestamp) { if (!s.started) s.started = e.timestamp; s.updated = e.timestamp }
    if (e.cwd) s.cwd = e.cwd
    if (e.gitBranch) s.branch = e.gitBranch

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
          Object.assign(target.ref, { status: failed ? 'failed' : 'done', result: clip(text, 4000), finished: e.timestamp || '' })
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
      if (results.length || e.isMeta) continue
      const text = cleanPrompt(blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'))
      if (!text) continue
      newTurn(e.timestamp || '', clip(text, 400))
      s.busy = true
      continue
    }

    if (e.type !== 'assistant') continue
    const m = e.message || {}
    if (m.model && !/synthetic/.test(m.model)) s.model = m.model
    if (m.usage) {
      const u = m.usage
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      if (ctx > 0) s.context = { tokens: ctx, input: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 }
      // 한 응답이 블록마다 여러 줄로 나뉘며 같은 usage 를 되풀이하므로 응답 ID 별로 한 번만 센다.
      if (m.id) outputByMessage.set(m.id, Math.max(outputByMessage.get(m.id) || 0, u.output_tokens || 0))
    }
    if (!turn) newTurn(e.timestamp || '', '')
    if (m.stop_reason === 'end_turn') s.busy = false
    else if (m.stop_reason === 'tool_use') s.busy = true

    for (const b of blocksOf(e)) {
      if (b.type === 'text' && b.text && b.text.trim()) {
        turn.report = b.text.trim()
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
        const agent = { name: input.description || input.subagent_type || '에이전트', type: input.subagent_type || 'general-purpose', prompt: clip(input.prompt, 4000), status: 'running', result: '', started: at, finished: '' }
        s.agents.push(agent)
        pending.set(b.id, { kind: 'agent', ref: agent })
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
  for (const v of outputByMessage.values()) s.outputTokens += v
  return s
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
  const board = { goal: '', items: [], file }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const head = line.match(/^#+\s+(.*)$/)
    if (head && !board.goal) { board.goal = head[1]; continue }
    const item = line.match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/)
    if (!item) continue
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
  const s = analyze(readEntries(file))
  if (!s.sessionId) s.sessionId = path.basename(file, '.jsonl')
  let board = readBoard(s.sessionId)
  let source = 'file'
  if (!board && s.todos) { board = { goal: '', items: s.todos }; source = 'todos' }
  const done = board ? board.items.filter(i => i.done).length : 0
  const exists = p => { try { return fs.existsSync(p) } catch { return false } }
  const cwdNorm = path.resolve(s.cwd || '.').toLowerCase()
  const verifications = readVerifications(s.sessionId).filter(v => v.session === s.sessionId || path.resolve(v.cwd || '.').toLowerCase() === cwdNorm)
  return {
    generated: new Date().toISOString(),
    session: { id: s.sessionId, title: s.title, cwd: s.cwd, branch: s.branch, model: s.model, started: s.started, updated: s.updated, transcript: file, busy: s.busy },
    board: board ? { ...board, source, done, total: board.items.length } : null,
    reports: s.turns.filter(t => t.tools > 0 && t.report).map(t => ({
      at: t.reportAt || t.at, prompt: t.prompt, report: clip(t.report, 6000), tools: t.tools,
      files: [...t.files], images: [...t.images], checks: t.checks.map(c => ({ kind: c.kind, status: c.status })),
    })).reverse(),
    agents: s.agents.slice().reverse(),
    files: [...s.files.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)),
    checks: s.checks.slice().reverse(),
    urls: [...s.urls.values()].sort((a, b) => Number(b.local) - Number(a.local)),
    images: [...s.images.values()].map(i => ({ ...i, gone: !exists(i.path) })).reverse(),
    codex: { calls: s.codexCalls.slice().reverse(), verifications },
    context: { ...s.context, window: opt.window || null, percent: opt.window ? Math.round((s.context.tokens / opt.window) * 1000) / 10 : null, output: s.outputTokens },
    counts: { turns: s.turns.filter(t => t.prompt).length, tools: s.toolCalls },
  }
}
