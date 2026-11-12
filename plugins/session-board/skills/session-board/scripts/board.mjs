#!/usr/bin/env node
// session-board: Claude Code 세션 기록을 읽어 현황판을 만든다.
// Copyright (c) 2026 JINO. MIT License.
// 의존성 없음 (Node 18+). 파일을 읽기만 하고 네트워크는 쓰지 않는다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

// ---------- 인자 ----------
function parseArgs(argv) {
  const opt = { format: 'html', open: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--session') opt.session = next()
    else if (a === '--transcript') opt.transcript = next()
    else if (a === '--format') opt.format = next()
    else if (a === '--out') opt.out = next()
    else if (a === '--window') opt.window = Number(next()) || undefined
    else if (a === '--open') opt.open = true
    else if (a === '--help' || a === '-h') opt.help = true
  }
  // 치환되지 않은 ${CLAUDE_SESSION_ID} 같은 값은 무시한다.
  if (opt.session && !/^[0-9a-zA-Z_-]{8,}$/.test(opt.session)) opt.session = undefined
  return opt
}

const HELP = `사용법: node board.mjs [--session <id>] [--transcript <파일>] [--format html|text|json]
                     [--out <파일>] [--open] [--window <토큰수>]`

// ---------- 세션 찾기 ----------
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const projectsDir = path.join(configDir, 'projects')
const boardDir = path.join(configDir, 'session-board')

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

function findTranscript(opt) {
  if (opt.transcript) return path.resolve(opt.transcript)
  const all = listDirs(projectsDir)
  if (opt.session) {
    for (const dir of all) {
      const file = path.join(dir, `${opt.session}.jsonl`)
      if (fs.existsSync(file)) return file
    }
    return null
  }
  // 현재 폴더에 해당하는 프로젝트 폴더를 먼저 본다 (경로의 영숫자 외 문자는 - 로 바뀐다).
  const slug = process.cwd().replace(/[^0-9a-zA-Z]/g, '-').toLowerCase()
  const mine = all.filter(d => path.basename(d).toLowerCase() === slug)
  return newestJsonl(mine) || newestJsonl(all)
}

// ---------- 기록 읽기 ----------
function readEntries(file) {
  const out = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 쓰는 중인 마지막 줄은 건너뛴다 */ }
  }
  return out
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const AGENT_TOOLS = new Set(['Agent', 'Task'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

const CHECK_RULES = [
  ['테스트', /\b(jest|vitest|pytest|mocha|playwright test|go test|cargo test|dotnet test|phpunit|rspec|gradlew? test|mvn test|(npm|pnpm|yarn|bun)( run)? test\S*)\b/i],
  ['타입', /\b(tsc|mypy|pyright|(npm|pnpm|yarn|bun)( run)? (typecheck|type-check|check-types))\b/i],
  ['린트', /\b(eslint|biome|ruff|flake8|pylint|stylelint|golangci-lint|clippy|(npm|pnpm|yarn|bun)( run)? lint\S*)\b/i],
  ['빌드', /\b(vite build|next build|webpack|cargo build|go build|dotnet build|gradlew? (build|assemble)|mvn (package|install)|(npm|pnpm|yarn|bun)( run)? build\S*)\b/i],
]

function checkKind(command) {
  for (const [label, re] of CHECK_RULES) if (re.test(command)) return label
  return null
}

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

function clip(text, max) {
  const t = String(text || '').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

// 화면에 보일 필요가 없는 시스템 주입 블록을 걷어 낸다.
function cleanPrompt(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(command-[a-z]+|local-command-[a-z]+)>[\s\S]*?<\/\1>/g, '')
    .trim()
}

function parseTodos(input) {
  const list = input && (input.todos || input.items)
  if (!Array.isArray(list) || !list.length) return null
  const items = list
    .filter(t => t && typeof t.content === 'string')
    .map(t => ({ text: t.content, done: t.status === 'completed', active: t.status === 'in_progress', note: '' }))
  return items.length ? items : null
}

function analyze(entries) {
  const s = {
    sessionId: '', title: '', cwd: '', branch: '', model: '', started: '', updated: '',
    turns: [], files: new Map(), agents: [], checks: [], urls: new Map(), todos: null,
    context: { tokens: 0, input: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: 0, toolCalls: 0,
  }
  const pending = new Map() // tool_use_id -> 기록 대상
  const outputByMessage = new Map()
  let turn = null

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
        const target = pending.get(r.tool_use_id)
        if (!target) continue
        pending.delete(r.tool_use_id)
        const failed = r.is_error === true
        if (target.kind === 'agent') {
          target.ref.status = failed ? 'failed' : 'done'
          target.ref.result = clip(resultText(r), 1200)
          target.ref.finished = e.timestamp || ''
        } else if (target.kind === 'check') {
          target.ref.status = failed ? 'fail' : 'pass'
          if (failed) target.ref.output = clip(resultText(r), 600)
        } else if (target.kind === 'edit' && failed) {
          const f = s.files.get(target.ref)
          if (f) { f.count--; if (f.count <= 0) s.files.delete(target.ref) }
          if (turn) turn.files.delete(target.ref)
        }
      }
      if (results.length || e.isMeta) continue
      const text = cleanPrompt(blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'))
      if (!text) continue
      turn = { at: e.timestamp || '', prompt: clip(text, 400), report: '', tools: 0, files: new Set(), checks: [] }
      s.turns.push(turn)
      continue
    }

    if (e.type !== 'assistant') continue
    const m = e.message || {}
    if (m.model && !/synthetic/.test(m.model)) s.model = m.model
    if (m.usage) {
      const u = m.usage
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      if (ctx > 0) s.context = { tokens: ctx, input: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 }
      // 한 응답이 블록마다 여러 줄로 나뉘어 같은 usage 를 되풀이하므로 응답 ID 별로 한 번만 센다.
      if (m.id) outputByMessage.set(m.id, Math.max(outputByMessage.get(m.id) || 0, u.output_tokens || 0))
    }
    if (!turn) { turn = { at: e.timestamp || '', prompt: '', report: '', tools: 0, files: new Set(), checks: [] }; s.turns.push(turn) }

    for (const b of blocksOf(e)) {
      if (b.type === 'text' && b.text && b.text.trim()) {
        turn.report = b.text.trim()
        for (const hit of b.text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
          const url = hit[0].replace(/[.,;:!?*]+$/, '')
          if (!s.urls.has(url)) s.urls.set(url, { url, at: e.timestamp || '', local: /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(url) })
        }
      }
      if (b.type !== 'tool_use') continue
      s.toolCalls++
      turn.tools++
      const input = b.input || {}
      if (EDIT_TOOLS.has(b.name)) {
        const file = input.file_path || input.notebook_path
        if (file) {
          const f = s.files.get(file) || { path: file, count: 0, created: false, last: '' }
          f.count++
          if (b.name === 'Write' && f.count === 1) f.created = true
          f.last = e.timestamp || ''
          s.files.set(file, f)
          turn.files.add(file)
          pending.set(b.id, { kind: 'edit', ref: file })
        }
      } else if (AGENT_TOOLS.has(b.name)) {
        const agent = {
          name: input.description || input.subagent_type || '에이전트', type: input.subagent_type || 'general-purpose',
          prompt: clip(input.prompt, 1200), status: 'running', result: '', started: e.timestamp || '', finished: '',
        }
        s.agents.push(agent)
        pending.set(b.id, { kind: 'agent', ref: agent })
      } else if (SHELL_TOOLS.has(b.name) && typeof input.command === 'string') {
        const kind = checkKind(input.command)
        if (kind) {
          const check = { kind, command: clip(input.command, 300), status: 'running', output: '', at: e.timestamp || '' }
          s.checks.push(check)
          turn.checks.push(check)
          pending.set(b.id, { kind: 'check', ref: check })
        }
      } else {
        const todos = parseTodos(input)
        if (todos) s.todos = todos
        else if (input.advance === true && s.todos) {
          // 목록 전체를 다시 보내지 않고 다음 단계로 넘기는 호출
          const at = s.todos.findIndex(t => t.active)
          if (at >= 0) { s.todos[at].active = false; s.todos[at].done = true }
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
function readBoard(sessionId) {
  if (!sessionId) return null
  let text
  try { text = fs.readFileSync(path.join(boardDir, `${sessionId}.md`), 'utf8') } catch { return null }
  const board = { goal: '', items: [] }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const head = line.match(/^#+\s+(.*)$/)
    if (head && !board.goal) { board.goal = head[1]; continue }
    const item = line.match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/)
    if (!item) continue
    const cut = item[2].indexOf(' - ')
    board.items.push({
      done: item[1] !== ' ', active: false,
      text: cut > 0 ? item[2].slice(0, cut) : item[2],
      note: cut > 0 ? item[2].slice(cut + 3) : '',
    })
  }
  return board.items.length || board.goal ? board : null
}

function buildData(file, opt) {
  const s = analyze(readEntries(file))
  if (!s.sessionId) s.sessionId = path.basename(file, '.jsonl')
  let board = readBoard(s.sessionId)
  let boardSource = 'file'
  if (!board && s.todos) { board = { goal: '', items: s.todos }; boardSource = 'todos' }
  const done = board ? board.items.filter(i => i.done).length : 0
  return {
    generated: new Date().toISOString(),
    session: { id: s.sessionId, title: s.title, cwd: s.cwd, branch: s.branch, model: s.model, started: s.started, updated: s.updated, transcript: file },
    board: board ? { ...board, source: boardSource, done, total: board.items.length } : null,
    reports: s.turns.filter(t => t.tools > 0 && t.report).map(t => ({
      at: t.at, prompt: t.prompt, report: clip(t.report, 4000), tools: t.tools,
      files: [...t.files], checks: t.checks.map(c => ({ kind: c.kind, status: c.status })),
    })).reverse(),
    agents: s.agents.slice().reverse(),
    files: [...s.files.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)),
    checks: s.checks.slice().reverse(),
    urls: [...s.urls.values()].sort((a, b) => Number(b.local) - Number(a.local)),
    context: { ...s.context, window: opt.window || null, percent: opt.window ? Math.round((s.context.tokens / opt.window) * 1000) / 10 : null, output: s.outputTokens },
    counts: { turns: s.turns.filter(t => t.prompt).length, tools: s.toolCalls },
  }
}

// ---------- 텍스트 출력 ----------
const num = n => Number(n || 0).toLocaleString('en-US')
const when = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString() }

function renderText(d) {
  const L = []
  L.push(`# 세션 보드: ${d.session.title || d.session.id}`)
  L.push(`폴더 ${d.session.cwd || '-'} · 모델 ${d.session.model || '-'} · 요청 ${d.counts.turns}회 · 도구 ${d.counts.tools}회 · 마지막 활동 ${when(d.session.updated)}`)
  L.push('', '## 진행판')
  if (d.board) {
    if (d.board.goal) L.push(`목표: ${d.board.goal}`)
    L.push(`진행 ${d.board.done}/${d.board.total}`)
    for (const i of d.board.items) L.push(`- [${i.done ? 'x' : ' '}] ${i.text}${i.note ? ' - ' + i.note : ''}${i.active ? ' (진행 중)' : ''}`)
  } else L.push('(보드 파일이 없습니다)')
  L.push('', `## 바뀐 파일 (${d.files.length})`)
  for (const f of d.files.slice(0, 40)) L.push(`- ${f.path} · ${f.count}회${f.created ? ' · 새 파일' : ''}`)
  L.push('', `## 검사 (${d.checks.length})`)
  for (const c of d.checks.slice(0, 20)) L.push(`- [${c.status === 'pass' ? '통과' : c.status === 'fail' ? '실패' : '실행 중'}] ${c.kind}: ${c.command}`)
  L.push('', `## 에이전트 (${d.agents.length})`)
  for (const a of d.agents.slice(0, 20)) L.push(`- [${a.status === 'done' ? '완료' : a.status === 'failed' ? '실패' : '진행 중'}] ${a.name} (${a.type})`)
  L.push('', `## 주소 (${d.urls.length})`)
  for (const u of d.urls.slice(0, 30)) L.push(`- ${u.url}${u.local ? ' (로컬)' : ''}`)
  L.push('', '## 컨텍스트')
  L.push(`현재 ${num(d.context.tokens)} 토큰${d.context.percent != null ? ` (${d.context.percent}%)` : ''} · 새 입력 ${num(d.context.input)} · 캐시 읽기 ${num(d.context.cacheRead)} · 캐시 쓰기 ${num(d.context.cacheWrite)} · 누적 출력 ${num(d.context.output)}`)
  L.push('', `## 결과보고 (${d.reports.length})`)
  for (const r of d.reports.slice(0, 5)) {
    L.push(`### ${when(r.at)} · 도구 ${r.tools}회 · 파일 ${r.files.length}개`)
    if (r.prompt) L.push(`요청: ${clip(r.prompt, 160)}`)
    L.push(clip(r.report, 700), '')
  }
  return L.join('\n')
}

// ---------- HTML 출력 ----------
function renderHtml(d) {
  const json = JSON.stringify(d).split('<').join(String.fromCharCode(92) + 'u003c')
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>세션 보드</title>
<style>
:root { --bg:#f6f5f1; --card:#ffffff; --ink:#1d1c1a; --sub:#6b6862; --line:#e3e0d8; --accent:#2f6f5e; --ok:#2f7d4f; --bad:#b3402e; --warn:#a36a12; --chip:#eeece6; }
@media (prefers-color-scheme: dark) { :root { --bg:#161614; --card:#1f1f1c; --ink:#ecebe6; --sub:#9c988f; --line:#33322e; --accent:#7cc4ae; --ok:#79c995; --bad:#ee8b78; --warn:#e0b060; --chip:#2a2926; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 system-ui, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; }
main { max-width: 920px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; text-wrap: balance; }
.meta { color: var(--sub); font-size: 13px; overflow-wrap: anywhere; }
nav { display:flex; gap:6px; flex-wrap:wrap; margin: 20px 0 14px; position: sticky; top: 0; background: var(--bg); padding: 8px 0; z-index: 1; }
nav button { font: inherit; font-size: 14px; border:1px solid var(--line); background:var(--card); color:var(--ink); padding:6px 12px; border-radius:999px; cursor:pointer; }
nav button[aria-selected="true"] { background: var(--accent); border-color: var(--accent); color: var(--bg); }
nav button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
nav .n { opacity:.7; font-variant-numeric: tabular-nums; margin-left: 4px; }
section { display:none; } section.on { display:block; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:10px; overflow-wrap:anywhere; }
.empty { color:var(--sub); padding: 28px 0; text-align:center; }
.bar { height:10px; background:var(--chip); border-radius:999px; overflow:hidden; margin:10px 0 14px; }
.bar i { display:block; height:100%; background:var(--accent); }
ul.steps { list-style:none; margin:0; padding:0; }
ul.steps li { display:flex; gap:10px; padding:8px 0; border-top:1px solid var(--line); }
ul.steps li:first-child { border-top:0; }
.box { flex:none; width:18px; height:18px; margin-top:2px; border:2px solid var(--sub); border-radius:5px; display:grid; place-items:center; font-size:12px; line-height:1; }
.done .box { background:var(--ok); border-color:var(--ok); color:var(--card); }
.done .t { color: var(--sub); }
.active .box { border-color: var(--warn); }
.note { color:var(--sub); font-size:13px; }
.chip { display:inline-block; background:var(--chip); border-radius:6px; padding:1px 8px; font-size:12px; margin:0 4px 4px 0; }
.chip.ok { color:var(--ok); } .chip.bad { color:var(--bad); } .chip.run { color:var(--warn); }
.row { display:flex; justify-content:space-between; gap:12px; align-items:baseline; }
.path { font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
.cnt { color:var(--sub); font-variant-numeric: tabular-nums; white-space:nowrap; font-size:13px; }
pre { white-space:pre-wrap; margin:8px 0 0; font: 13px/1.5 ui-monospace, Consolas, monospace; overflow-wrap:anywhere; }
.body { white-space:pre-wrap; margin-top:8px; }
details summary { cursor:pointer; color:var(--sub); font-size:13px; margin-top:6px; }
a { color: var(--accent); }
.stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:10px; }
.stat b { display:block; font-size:22px; font-variant-numeric: tabular-nums; }
.stat span { color:var(--sub); font-size:13px; }
footer { color:var(--sub); font-size:12px; margin-top:28px; text-align:center; }
</style>
</head>
<body>
<main>
  <h1 id="title"></h1>
  <div class="meta" id="meta"></div>
  <nav id="tabs" role="tablist"></nav>
  <div id="panes"></div>
  <footer id="foot"></footer>
</main>
<script id="data" type="application/json">${json}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent)
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
const num = n => Number(n || 0).toLocaleString()
const when = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString() }
const empty = text => el('div', 'empty', text)

document.getElementById('title').textContent = D.session.title || '세션 보드'
document.title = '세션 보드 · ' + (D.session.title || D.session.id.slice(0, 8))
document.getElementById('meta').textContent = [D.session.cwd, D.session.branch && D.session.branch !== 'HEAD' ? '브랜치 ' + D.session.branch : '', D.session.model, '요청 ' + D.counts.turns + '회', '도구 ' + D.counts.tools + '회', '마지막 활동 ' + when(D.session.updated)].filter(Boolean).join(' · ')
document.getElementById('foot').textContent = '세션 ' + D.session.id + ' · 만든 시각 ' + when(D.generated)

function board() {
  const w = el('div')
  if (!D.board) { w.append(empty('아직 진행판이 없습니다.')); return w }
  const c = el('div', 'card')
  if (D.board.goal) c.append(el('strong', '', D.board.goal))
  const pct = D.board.total ? Math.round(D.board.done / D.board.total * 100) : 0
  c.append(el('div', 'note', D.board.done + ' / ' + D.board.total + ' 단계 (' + pct + '%)' + (D.board.source === 'todos' ? ' · 할 일 목록에서 가져옴' : '')))
  const bar = el('div', 'bar'); const fill = el('i'); fill.style.width = pct + '%'; bar.append(fill); c.append(bar)
  const ul = el('ul', 'steps')
  for (const i of D.board.items) {
    const li = el('li', i.done ? 'done' : i.active ? 'active' : '')
    li.append(el('span', 'box', i.done ? '✓' : ''))
    const t = el('div'); t.append(el('div', 't', i.text)); if (i.note) t.append(el('div', 'note', i.note)); if (i.active) t.append(el('div', 'note', '진행 중'))
    li.append(t); ul.append(li)
  }
  c.append(ul); w.append(c); return w
}

function reports() {
  const w = el('div')
  if (!D.reports.length) w.append(empty('도구를 쓴 턴의 보고가 아직 없습니다.'))
  for (const r of D.reports) {
    const c = el('div', 'card')
    c.append(el('div', 'note', when(r.at) + ' · 도구 ' + r.tools + '회'))
    if (r.prompt) c.append(el('div', '', '요청: ' + r.prompt))
    const chips = el('div'); chips.style.marginTop = '6px'
    for (const k of r.checks) chips.append(el('span', 'chip ' + (k.status === 'pass' ? 'ok' : k.status === 'fail' ? 'bad' : 'run'), k.kind + ' ' + (k.status === 'pass' ? '통과' : k.status === 'fail' ? '실패' : '실행 중')))
    if (r.files.length) chips.append(el('span', 'chip', '파일 ' + r.files.length + '개'))
    if (chips.childNodes.length) c.append(chips)
    c.append(el('div', 'body', r.report))
    if (r.files.length) { const d = el('details'); d.append(el('summary', '', '이 턴에 바꾼 파일')); d.append(el('pre', '', r.files.join('\\n'))); c.append(d) }
    w.append(c)
  }
  return w
}

function agents() {
  const w = el('div')
  if (!D.agents.length) w.append(empty('띄운 하위 에이전트가 없습니다.'))
  for (const a of D.agents) {
    const c = el('div', 'card'); const row = el('div', 'row')
    row.append(el('strong', '', a.name))
    row.append(el('span', 'chip ' + (a.status === 'done' ? 'ok' : a.status === 'failed' ? 'bad' : 'run'), a.status === 'done' ? '완료' : a.status === 'failed' ? '실패' : '진행 중'))
    c.append(row); c.append(el('div', 'note', a.type + ' · ' + when(a.started)))
    if (a.prompt) { const d = el('details'); d.append(el('summary', '', '받은 지시')); d.append(el('pre', '', a.prompt)); c.append(d) }
    if (a.result) { const d = el('details'); d.append(el('summary', '', '최종 보고')); d.append(el('pre', '', a.result)); c.append(d) }
    w.append(c)
  }
  return w
}

function files() {
  const w = el('div')
  if (!D.files.length) { w.append(empty('바뀐 파일이 없습니다.')); return w }
  const c = el('div', 'card')
  for (const f of D.files) {
    const row = el('div', 'row'); row.style.padding = '5px 0'
    row.append(el('span', 'path', f.path))
    row.append(el('span', 'cnt', (f.created ? '새 파일 · ' : '') + f.count + '회'))
    c.append(row)
  }
  w.append(c); return w
}

function checks() {
  const w = el('div')
  if (!D.checks.length) w.append(empty('빌드, 린트, 테스트 실행 기록이 없습니다.'))
  for (const k of D.checks) {
    const c = el('div', 'card'); const row = el('div', 'row')
    row.append(el('strong', '', k.kind))
    row.append(el('span', 'chip ' + (k.status === 'pass' ? 'ok' : k.status === 'fail' ? 'bad' : 'run'), k.status === 'pass' ? '통과' : k.status === 'fail' ? '실패' : '실행 중'))
    c.append(row); c.append(el('pre', '', k.command))
    if (k.output) { const d = el('details'); d.append(el('summary', '', '실패 출력')); d.append(el('pre', '', k.output)); c.append(d) }
    w.append(c)
  }
  return w
}

function urls() {
  const w = el('div')
  if (!D.urls.length) { w.append(empty('대화에 나온 주소가 없습니다.')); return w }
  const c = el('div', 'card')
  for (const u of D.urls) {
    const row = el('div', 'row'); row.style.padding = '5px 0'
    const a = el('a', 'path', u.url); a.href = u.url; a.target = '_blank'; a.rel = 'noreferrer noopener'
    row.append(a); if (u.local) row.append(el('span', 'chip', '로컬'))
    c.append(row)
  }
  w.append(c); return w
}

function context() {
  const w = el('div'); const c = el('div', 'card')
  const x = D.context
  if (x.percent != null) { c.append(el('div', 'note', '컨텍스트 창 ' + num(x.window) + ' 토큰 중 ' + x.percent + '% 사용')); const bar = el('div', 'bar'); const fill = el('i'); fill.style.width = Math.min(100, x.percent) + '%'; bar.append(fill); c.append(bar) }
  const g = el('div', 'stats')
  for (const [label, value] of [['현재 컨텍스트', x.tokens], ['새 입력', x.input], ['캐시 읽기', x.cacheRead], ['캐시 쓰기', x.cacheWrite], ['누적 출력', x.output]]) {
    const s = el('div', 'stat'); s.append(el('b', '', num(value))); s.append(el('span', '', label + ' 토큰')); g.append(s)
  }
  c.append(g); w.append(c)
  w.append(el('div', 'note', '가장 최근 응답의 사용량 기준입니다. 창 크기는 --window 옵션으로 주면 사용률이 함께 나옵니다.'))
  return w
}

const TABS = [
  ['진행판', board, D.board ? D.board.done + '/' + D.board.total : ''],
  ['결과보고', reports, D.reports.length],
  ['에이전트', agents, D.agents.length],
  ['바뀐 파일', files, D.files.length],
  ['검사', checks, D.checks.length],
  ['주소', urls, D.urls.length],
  ['컨텍스트', context, ''],
]
const tabs = document.getElementById('tabs'), panes = document.getElementById('panes')
TABS.forEach(([name, build, count], i) => {
  const b = el('button', '', name); b.setAttribute('role', 'tab')
  if (count !== '' && count !== 0) b.append(el('span', 'n', String(count)))
  const pane = el('section'); pane.setAttribute('role', 'tabpanel'); pane.append(build())
  b.onclick = () => {
    tabs.querySelectorAll('button').forEach(x => x.setAttribute('aria-selected', 'false'))
    panes.querySelectorAll('section').forEach(x => x.classList.remove('on'))
    b.setAttribute('aria-selected', 'true'); pane.classList.add('on')
  }
  tabs.append(b); panes.append(pane)
  if (i === 0) b.onclick()
})
</script>
</body>
</html>
`
}

// ---------- 실행 ----------
function openFile(file) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
    : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]]
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref() } catch {}
}

function main() {
  const opt = parseArgs(process.argv.slice(2))
  if (opt.help) { console.log(HELP); return }
  if (!['html', 'text', 'json'].includes(opt.format)) { console.error(`알 수 없는 형식: ${opt.format}\n${HELP}`); process.exit(2) }
  const file = findTranscript(opt)
  if (!file || !fs.existsSync(file)) {
    console.error(`세션 기록을 찾지 못했습니다${opt.session ? ` (세션 ${opt.session})` : ''}. --transcript <파일> 로 직접 지정해 주세요. 찾은 위치: ${projectsDir}`)
    process.exit(1)
  }
  const data = buildData(file, opt)
  if (opt.format === 'json') { console.log(JSON.stringify(data, null, 2)); return }
  if (opt.format === 'text') { console.log(renderText(data)); return }
  const out = path.resolve(opt.out || path.join(os.tmpdir(), `session-board-${data.session.id}.html`))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, renderHtml(data))
  console.log(`세션 보드를 만들었습니다: ${out}`)
  if (data.board) console.log(`진행판 ${data.board.done}/${data.board.total}`)
  const failed = data.checks.filter(c => c.status === 'fail').length
  console.log(`결과보고 ${data.reports.length} · 에이전트 ${data.agents.length} · 바뀐 파일 ${data.files.length} · 검사 ${data.checks.length}${failed ? ` (실패 ${failed})` : ''} · 주소 ${data.urls.length}`)
  if (opt.open) openFile(out)
}

main()
