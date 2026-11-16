#!/usr/bin/env node
// session-board: Claude Code 세션 현황판 (HTML 한 장, 텍스트 요약, 실시간 서버).
// Copyright (c) 2026 JINO. MIT License. 의존성 없음 (Node 18+).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { boardDir, buildData, clip, findTranscript, listSessions, normalizeLabel, projectDirs, projectsDir, readHidden, readLabels, sessionFile, validSession, writeHidden, writeLabels } from './core.mjs'
import { inspectSession, stopSession } from './procs.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HELP = `사용법: node board.mjs [--session <id>] [--transcript <파일>] [--format html|text|json]
                     [--out <파일>] [--open] [--window <토큰수>]
                     [--serve] [--project [작업 경로]] [--port <번호>] [--ttl <분>]

  --serve     실시간 보드. 127.0.0.1 에서만 열리고 주소에 든 열쇠가 있어야 접근된다.
              세션이 진행되는 대로 화면이 갱신되고, 파일 열기와 로컬 주소 생존 확인이 된다.
  --project   --serve 와 함께 쓰면 프로젝트 보드. 서버 하나, 탭 하나로 그 프로젝트의 세션들을 골라 본다.
              작업 경로를 빼면 --session 이 든 프로젝트, 그것도 없으면 지금 폴더의 프로젝트다.
              같은 프로젝트 보드가 이미 떠 있으면 새로 띄우지 않고 그 주소를 알려 준다.`

function parseArgs(argv) {
  const opt = { format: 'html', open: false, port: 0, ttl: 120 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--session') opt.session = validSession(next())
    else if (a === '--project') { opt.project = true; if (argv[i + 1] && !argv[i + 1].startsWith('--')) opt.projectPath = next() }
    else if (a === '--transcript') opt.transcript = next()
    else if (a === '--format') opt.format = next()
    else if (a === '--out') opt.out = next()
    else if (a === '--window') opt.window = Number(next()) || undefined
    else if (a === '--port') opt.port = Number(next()) || 0
    else if (a === '--ttl') opt.ttl = Number(next()) || 120
    else if (a === '--open') opt.open = true
    else if (a === '--serve') opt.serve = true
    else if (a === '--help' || a === '-h') opt.help = true
  }
  return opt
}

// ---------- 텍스트 ----------
const num = n => Number(n || 0).toLocaleString('en-US')
const when = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString() }
const STATUS = { pass: '통과', fail: '실패', done: '완료', failed: '실패', running: '진행 중' }
const VERDICT = { pass: '통과', concerns: '고칠 점 있음', fail: '불합격' }

function renderText(d) {
  const L = [`# 세션 보드: ${d.session.title || d.session.id}`]
  L.push(`폴더 ${d.session.cwd || '-'} · 모델 ${d.session.model || '-'} · 요청 ${d.counts.turns}회 · 도구 ${d.counts.tools}회 · ${d.session.busy ? '작업 중' : '대기 중'} · 마지막 활동 ${when(d.session.updated)}`)
  L.push('', '## 진행판')
  if (d.board) {
    if (d.board.goal) L.push(`목표: ${d.board.goal}`)
    L.push(`진행 ${d.board.done}/${d.board.total}`)
    for (const i of d.board.items) L.push(`- [${i.done ? 'x' : ' '}] ${i.text}${i.note ? ' - ' + i.note : ''}${i.active ? ' (진행 중)' : ''}`)
  } else L.push('(보드 파일이 없습니다)')
  L.push('', `## 바뀐 파일 (${d.files.length})`)
  for (const f of d.files.slice(0, 40)) L.push(`- ${f.path} · ${f.count}회${f.created ? ' · 새 파일' : ''}`)
  L.push('', `## 검사 (${d.checks.length})`)
  for (const c of d.checks.slice(0, 20)) L.push(`- [${STATUS[c.status]}] ${c.kind}: ${c.command}`)
  L.push('', `## 에이전트 (${d.agents.length})`)
  for (const a of d.agents.slice(0, 20)) L.push(`- [${STATUS[a.status]}] ${a.name} (${a.type})`)
  L.push('', `## 코덱스 (교차검증 ${d.codex.verifications.length} · 호출 ${d.codex.calls.length})`)
  for (const v of d.codex.verifications.slice(0, 5)) L.push(`- [${VERDICT[v.verdict] || v.verdict}] ${when(v.at)} · ${v.mode} · 지적 ${v.findings.length}건 · ${clip(v.summary, 140)}`)
  L.push('', `## 결과물 이미지 (${d.images.length})`)
  for (const i of d.images.slice(0, 20)) L.push(`- ${i.path}${i.gone ? ' (지워짐)' : ''}`)
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

// ---------- HTML ----------
function page(boot) {
  const template = fs.readFileSync(path.join(HERE, 'board.html'), 'utf8')
  const json = JSON.stringify(boot).split('<').join(String.fromCharCode(92) + 'u003c')
  return template.replace('/*BOOT*/', () => json)
}

function withSources(data, toSrc) {
  const srcOf = new Map(data.images.map((img, i) => [img.path, img.gone ? '' : toSrc(img.path, i)]))
  const turn = r => ({ ...r, images: r.images.map(p => ({ path: p, src: srcOf.get(p) || '' })) })
  return {
    ...data,
    images: data.images.map(img => ({ ...img, src: srcOf.get(img.path) })),
    reports: data.reports.map(turn),
    replies: data.replies.map(turn),
  }
}

// 요청 본문(JSON)을 읽는다. 작은 것만 받는다.
function readBody(req) {
  return new Promise(resolve => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk; if (body.length > 65536) { req.destroy(); resolve(null) } })
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}) } catch { resolve({}) } })
    req.on('error', () => resolve(null))
  })
}

function openTarget(target) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
    : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]]
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref() } catch {}
}

// ---------- 실시간 서버 ----------
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' }

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return ''
}

function probe(origin) {
  return new Promise(resolve => {
    let done = false
    const finish = alive => { if (!done) { done = true; resolve(alive) } }
    try {
      const req = http.get(origin, { timeout: 1200 }, res => { res.resume(); finish(true) })
      req.on('timeout', () => { req.destroy(); finish(false) })
      req.on('error', () => finish(false))
    } catch { finish(false) }
  })
}

const originOf = url => { try { return new URL(url).origin } catch { return '' } }

// ---------- 프로젝트 보드 서버 다시 쓰기 ----------
// 프로젝트마다 떠 있는 서버를 파일 하나에 적어 두고, 같은 프로젝트를 다시 열면 그 서버를 쓴다.
const serverFile = name => path.join(boardDir, 'servers', `${String(name).toLowerCase().replace(/[^0-9a-z-]/g, '-')}.json`)
const isAlive = pid => { try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' } }

function request(method, url, timeout = 1500) {
  return new Promise(resolve => {
    try {
      const req = http.request(url, { method, timeout }, res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', c => { body += c })
        res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(body) : null) } catch { resolve(null) } })
      })
      req.on('timeout', () => { req.destroy(); resolve(null) })
      req.on('error', () => resolve(null))
      req.end()
    } catch { resolve(null) }
  })
}

async function findRunning(name) {
  let st
  try { st = JSON.parse(fs.readFileSync(serverFile(name), 'utf8')) } catch { return null }
  if (!st || !st.port || !st.key || !isAlive(st.pid)) return null
  const base = `http://127.0.0.1:${st.port}`
  const ping = await request('GET', `${base}/ping?k=${st.key}`)
  return ping && ping.ok && ping.project === name ? { base, key: st.key, viewing: ping.viewing } : null
}

// src: 한 세션이면 { file }, 프로젝트면 { dirs, name }
function serve(opt, src) {
  const key = crypto.randomBytes(16).toString('hex')
  const proj = !!src.dirs
  const caches = new Map()
  let alive = new Map()
  let lastHit = Date.now()
  let lastFile = src.file
  // 다른 세션에서 같은 보드를 열면 열려 있는 탭이 그 세션으로 넘어가게 한다.
  let focus = { id: '', n: 0 }
  let listCache = { at: 0, list: [], hidden: 0 }

  const refreshList = () => {
    if (Date.now() - listCache.at > 1500) {
      const list = listSessions(src.dirs, 50, readHidden()), labels = readLabels()
      // 아이콘 글자를 정해 둔 세션에는 label 을 단다.
      listCache = { at: Date.now(), list: list.map(s => labels.has(s.id) ? { ...s, label: labels.get(s.id) } : s), hidden: list.hidden || 0 }
    }
    return listCache
  }
  const sessions = () => refreshList().list
  const defaultFile = () => {
    if (!proj) return src.file
    const id = (opt.session && sessionFile(src.dirs, opt.session) && opt.session) || (sessions()[0] || {}).id
    return id ? sessionFile(src.dirs, id) : null
  }
  // 요청이 고른 세션의 기록 파일. 프로젝트 밖 세션은 고를 수 없다.
  const fileFor = url => {
    if (!proj) return src.file
    const id = url.searchParams.get('s')
    return id ? sessionFile(src.dirs, id) : defaultFile()
  }
  const projectInfo = () => {
    const cwd = (sessions().find(s => s.cwd) || {}).cwd || ''
    return { name: path.basename(cwd) || src.name, cwd, key: src.name }
  }

  const current = file => {
    let mtime = 0
    try { mtime = fs.statSync(file).mtimeMs } catch {}
    let c = caches.get(file)
    // 보드 파일이나 교차검증 기록은 세션 기록과 따로 바뀌므로 5초마다는 다시 만든다 (기록은 새 줄만 읽는다).
    if (!c || mtime !== c.mtime || Date.now() - c.at > 5000) {
      c = { mtime, at: Date.now(), data: buildData(file, opt) }
      caches.delete(file)
      caches.set(file, c)
      while (caches.size > 3) caches.delete(caches.keys().next().value)
    }
    lastFile = file
    return c.data
  }
  const payload = file => {
    const d0 = current(file)
    const s = proj ? `&s=${d0.session.id}` : ''
    const d = withSources(d0, (p, i) => `/img/${i}?k=${key}${s}`)
    const out = { ...d, lan: lanAddress(), urls: d.urls.map(u => ({ ...u, alive: u.local ? alive.get(originOf(u.url)) : undefined })) }
    if (!proj) return out
    // 꺼진 세션은 기록이 도구 호출에서 끊겼어도 작업 중이 아니다.
    const me = sessions().find(s => s.id === d.session.id)
    if (me && me.running === false && out.session.busy) out.session = { ...out.session, busy: false }
    return { ...out, sessions: sessions(), hidden: refreshList().hidden, focus }
  }
  // 대화에 나온 로컬 주소가 지금 떠 있는지 주기적으로 확인한다 (http 로컬 주소만, 지금 보는 세션 것).
  const refreshAlive = async () => {
    if (!lastFile) return
    const origins = [...new Set(current(lastFile).urls.filter(u => u.local).map(u => originOf(u.url)).filter(o => o.startsWith('http://')))]
    const next = new Map()
    await Promise.all(origins.slice(0, 20).map(async o => next.set(o, await probe(o))))
    alive = next
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const host = String(req.headers.host || '').replace(/:\d+$/, '')
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(body) }
    // 다른 사이트가 이 서버를 부르지 못하게 호스트와 열쇠를 모두 확인한다.
    if (!['127.0.0.1', 'localhost'].includes(host) || url.searchParams.get('k') !== key) return send(403, 'text/plain; charset=utf-8', '접근할 수 없습니다.')
    // 다시 쓰기 확인과 탭 넘기기는 보는 사람이 아니므로 접속으로 치지 않는다.
    if (req.method === 'GET' && url.pathname === '/ping') return send(200, 'application/json', JSON.stringify({ ok: true, project: proj ? src.name : '', viewing: Date.now() - lastHit < 8000 }))
    if (req.method === 'POST' && url.pathname === '/focus') {
      const id = validSession(url.searchParams.get('s'))
      if (proj && id && sessionFile(src.dirs, id)) focus = { id, n: focus.n + 1 }
      return send(200, 'application/json', '{"ok":true}')
    }
    lastHit = Date.now()
    try {
      // 프로젝트 보드의 「끄기」: 이 프로젝트의 켜져 있는 세션만. 먼저 무엇을 끄는지 보여 주고, 확인을 받으면 끈다.
      if (proj && ((req.method === 'GET' && url.pathname === '/proc') || (req.method === 'POST' && url.pathname === '/stop'))) {
        const id = validSession(url.searchParams.get('s'))
        if (!id || !sessionFile(src.dirs, id)) return send(404, 'application/json', JSON.stringify({ ok: false, error: '이 프로젝트의 세션이 아닙니다.' }))
        const r = url.pathname === '/proc' ? await inspectSession(id) : await stopSession(id)
        if (url.pathname === '/stop') listCache.at = 0
        return send(200, 'application/json; charset=utf-8', JSON.stringify(r))
      }
      // 닫힌 세션을 보드 목록에서 빼거나 되돌린다 (세션 기록은 건드리지 않는다). 이 프로젝트 세션만.
      if (proj && req.method === 'POST' && (url.pathname === '/hide' || url.pathname === '/unhide')) {
        const body = await readBody(req) || {}
        const mine = id => validSession(id) && sessionFile(src.dirs, id)
        const map = readHidden()
        let n = 0
        if (url.pathname === '/hide') {
          const at = new Date().toISOString()
          for (const id of (Array.isArray(body.ids) ? body.ids : []).slice(0, 500)) if (mine(id) && !map.has(id)) { map.set(id, at); n++ }
        } else {
          const ids = body.all === true ? [...map.keys()] : Array.isArray(body.ids) ? body.ids : []
          for (const id of ids) if (map.has(id) && mine(id)) { map.delete(id); n++ }
        }
        if (n) writeHidden(map)
        listCache.at = 0
        return send(200, 'application/json', JSON.stringify({ ok: true, n }))
      }
      // 세션 아이콘 글자를 바꾼다. 비우면 지워서 자동으로 돌아간다. 이 프로젝트 세션만.
      if (proj && req.method === 'POST' && url.pathname === '/label') {
        const body = await readBody(req) || {}
        const id = validSession(body.id)
        if (!id || !sessionFile(src.dirs, id)) return send(404, 'application/json', JSON.stringify({ ok: false, error: '이 프로젝트의 세션이 아닙니다.' }))
        const map = readLabels(), label = normalizeLabel(body.text)
        if (label ? map.get(id) !== label : map.has(id)) {
          if (label) map.set(id, label)
          else map.delete(id)
          writeLabels(map)
        }
        listCache.at = 0
        return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, label }))
      }
      const file = fileFor(url)
      if (!file) return send(404, 'text/plain; charset=utf-8', '이 프로젝트에서 세션을 찾지 못했습니다.')
      if (req.method === 'GET' && url.pathname === '/') return send(200, 'text/html; charset=utf-8', page({ live: true, key, project: proj ? projectInfo() : null, data: payload(file) }))
      if (req.method === 'GET' && url.pathname === '/data') return send(200, 'application/json; charset=utf-8', JSON.stringify(payload(file)))
      const img = url.pathname.match(/^\/img\/(\d+)$/)
      if (req.method === 'GET' && img) {
        const item = current(file).images[Number(img[1])]
        const type = item && MIME[path.extname(item.path).toLowerCase()]
        if (!item || !type || !fs.existsSync(item.path)) return send(404, 'text/plain; charset=utf-8', '없음')
        // SVG 안의 스크립트가 돌지 않게 막는다.
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" })
        return fs.createReadStream(item.path).pipe(res)
      }
      const open = url.pathname.match(/^\/open\/(file|image)\/(\d+)$/)
      if (req.method === 'POST' && open) {
        // 세션 기록에 실제로 나온 파일만 열 수 있다. 경로를 보내면 그 경로로 찾고(목록 순서가 바뀌어도 맞게), 없으면 번호로 찾는다.
        const list = open[1] === 'file' ? current(file).files : current(file).images
        const body = await readBody(req)
        const item = body && typeof body.path === 'string' ? list.find(f => f.path === body.path) : list[Number(open[2])]
        if (!item || !fs.existsSync(item.path)) return send(404, 'application/json', '{"ok":false}')
        openTarget(item.path)
        return send(200, 'application/json', '{"ok":true}')
      }
      send(404, 'text/plain; charset=utf-8', '없음')
    } catch (err) {
      send(500, 'text/plain; charset=utf-8', String(err && err.message || err))
    }
  })

  server.on('error', err => { console.error(`서버를 열지 못했습니다: ${err.message}`); process.exit(1) })
  server.listen(opt.port, '127.0.0.1', () => {
    const port = server.address().port
    const first = proj ? (opt.session && sessionFile(src.dirs, opt.session) ? opt.session : '') : ''
    const address = `http://127.0.0.1:${port}/?k=${key}${first ? `#session=${first}` : ''}`
    if (proj) {
      // 이 프로젝트 보드가 떠 있다고 적어 두고, 꺼질 때 지운다 (다른 서버가 덮어썼으면 건드리지 않는다).
      const f = serverFile(src.name)
      try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ pid: process.pid, port, key, project: src.name, at: new Date().toISOString() })) } catch {}
      const clear = () => { try { if (JSON.parse(fs.readFileSync(f, 'utf8')).pid === process.pid) fs.unlinkSync(f) } catch {} }
      process.on('exit', clear)
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0))
    }
    console.log(`${proj ? '프로젝트' : '실시간 세션'} 보드: ${address}`)
    console.log(`${opt.ttl}분 동안 접속이 없으면 스스로 꺼집니다.`)
    if (opt.open) openTarget(address)
    refreshAlive()
  })
  setInterval(refreshAlive, 15000).unref()
  setInterval(() => { if (Date.now() - lastHit > opt.ttl * 60000) process.exit(0) }, 30000)
}

// 프로젝트 보드: 같은 프로젝트 서버가 떠 있으면 그 주소를 알려 주고, 열린 탭이 있으면 이 세션으로 넘긴다.
async function serveProject(opt) {
  const dirs = projectDirs({ project: opt.projectPath, session: opt.session })
  if (!dirs.length) {
    console.error(`프로젝트의 세션 기록 폴더를 찾지 못했습니다. 찾은 위치: ${projectsDir}`)
    process.exit(1)
  }
  const name = path.basename(dirs[0]).toLowerCase()
  const running = await findRunning(name)
  if (running) {
    const sel = opt.session && sessionFile(dirs, opt.session) ? opt.session : ''
    if (sel) await request('POST', `${running.base}/focus?k=${running.key}&s=${sel}`)
    const address = `${running.base}/?k=${running.key}${sel ? `#session=${sel}` : ''}`
    console.log(`프로젝트 보드: ${address}`)
    console.log(running.viewing ? '이미 떠 있는 보드입니다. 열려 있는 탭이 이 세션으로 넘어갑니다.' : '이미 떠 있는 보드입니다.')
    if (opt.open && !running.viewing) openTarget(address)
    return
  }
  if (!listSessions(dirs, 1).length) {
    console.error(`이 프로젝트에서 세션을 찾지 못했습니다: ${dirs.join(', ')}`)
    process.exit(1)
  }
  serve(opt, { dirs, name })
}

// ---------- 실행 ----------
async function main() {
  const opt = parseArgs(process.argv.slice(2))
  if (opt.help) { console.log(HELP); return }
  if (!['html', 'text', 'json'].includes(opt.format)) { console.error(`알 수 없는 형식: ${opt.format}\n${HELP}`); process.exit(2) }
  if (opt.serve && opt.project && !opt.transcript) return serveProject(opt)
  const file = findTranscript(opt)
  if (!file || !fs.existsSync(file)) {
    console.error(`세션 기록을 찾지 못했습니다${opt.session ? ` (세션 ${opt.session})` : ''}. --transcript <파일> 로 직접 지정해 주세요. 찾은 위치: ${projectsDir}`)
    process.exit(1)
  }
  if (opt.serve) return serve(opt, { file })
  const data = buildData(file, opt)
  if (opt.format === 'json') { console.log(JSON.stringify(data, null, 2)); return }
  if (opt.format === 'text') { console.log(renderText(data)); return }
  const out = path.resolve(opt.out || path.join(os.tmpdir(), `session-board-${data.session.id}.html`))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, page({ live: false, key: '', data: withSources(data, p => pathToFileURL(p).href) }))
  console.log(`세션 보드를 만들었습니다: ${out}`)
  if (data.board) console.log(`진행판 ${data.board.done}/${data.board.total}`)
  const failed = data.checks.filter(c => c.status === 'fail').length
  console.log(`결과보고 ${data.reports.length} · 에이전트 ${data.agents.length} · 코덱스 ${data.codex.verifications.length + data.codex.calls.length} · 결과물 ${data.images.length} · 바뀐 파일 ${data.files.length} · 검사 ${data.checks.length}${failed ? ` (실패 ${failed})` : ''} · 주소 ${data.urls.length}`)
  if (opt.open) openTarget(out)
}

main().catch(err => { console.error(String(err && err.stack || err)); process.exit(1) })
