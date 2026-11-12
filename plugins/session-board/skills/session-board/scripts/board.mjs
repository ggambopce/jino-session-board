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
import { buildData, clip, findTranscript, projectsDir, validSession } from './core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HELP = `사용법: node board.mjs [--session <id>] [--transcript <파일>] [--format html|text|json]
                     [--out <파일>] [--open] [--window <토큰수>]
                     [--serve] [--port <번호>] [--ttl <분>]

  --serve   실시간 보드. 127.0.0.1 에서만 열리고 주소에 든 열쇠가 있어야 접근된다.
            세션이 진행되는 대로 화면이 갱신되고, 파일 열기와 로컬 주소 생존 확인이 된다.`

function parseArgs(argv) {
  const opt = { format: 'html', open: false, port: 0, ttl: 120 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--session') opt.session = validSession(next())
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
  return {
    ...data,
    images: data.images.map(img => ({ ...img, src: srcOf.get(img.path) })),
    reports: data.reports.map(r => ({ ...r, images: r.images.map(p => ({ path: p, src: srcOf.get(p) || '' })) })),
  }
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

function serve(file, opt) {
  const key = crypto.randomBytes(16).toString('hex')
  let cache = { mtime: -1, at: 0, data: null }
  let alive = new Map()
  let lastHit = Date.now()

  const current = () => {
    let mtime = 0
    try { mtime = fs.statSync(file).mtimeMs } catch {}
    // 보드 파일이나 교차검증 기록은 세션 기록과 따로 바뀌므로 5초마다는 다시 읽는다.
    if (!cache.data || mtime !== cache.mtime || Date.now() - cache.at > 5000) cache = { mtime, at: Date.now(), data: buildData(file, opt) }
    return cache.data
  }
  const payload = () => {
    const d = withSources(current(), (p, i) => `/img/${i}?k=${key}`)
    return { ...d, lan: lanAddress(), urls: d.urls.map(u => ({ ...u, alive: u.local ? alive.get(originOf(u.url)) : undefined })) }
  }
  // 대화에 나온 로컬 주소가 지금 떠 있는지 주기적으로 확인한다 (http 로컬 주소만).
  const refreshAlive = async () => {
    const origins = [...new Set(current().urls.filter(u => u.local).map(u => originOf(u.url)).filter(o => o.startsWith('http://')))]
    const next = new Map()
    await Promise.all(origins.slice(0, 20).map(async o => next.set(o, await probe(o))))
    alive = next
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const host = String(req.headers.host || '').replace(/:\d+$/, '')
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(body) }
    // 다른 사이트가 이 서버를 부르지 못하게 호스트와 열쇠를 모두 확인한다.
    if (!['127.0.0.1', 'localhost'].includes(host) || url.searchParams.get('k') !== key) return send(403, 'text/plain; charset=utf-8', '접근할 수 없습니다.')
    lastHit = Date.now()
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(200, 'text/html; charset=utf-8', page({ live: true, key, data: payload() }))
      if (req.method === 'GET' && url.pathname === '/data') return send(200, 'application/json; charset=utf-8', JSON.stringify(payload()))
      const img = url.pathname.match(/^\/img\/(\d+)$/)
      if (req.method === 'GET' && img) {
        const item = current().images[Number(img[1])]
        const type = item && MIME[path.extname(item.path).toLowerCase()]
        if (!item || !type || !fs.existsSync(item.path)) return send(404, 'text/plain; charset=utf-8', '없음')
        // SVG 안의 스크립트가 돌지 않게 막는다.
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" })
        return fs.createReadStream(item.path).pipe(res)
      }
      const open = url.pathname.match(/^\/open\/(file|image)\/(\d+)$/)
      if (req.method === 'POST' && open) {
        // 세션 기록에 실제로 나온 파일만 번호로 열 수 있다.
        const list = open[1] === 'file' ? current().files : current().images
        const item = list[Number(open[2])]
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
    const address = `http://127.0.0.1:${server.address().port}/?k=${key}`
    console.log(`실시간 세션 보드: ${address}`)
    console.log(`${opt.ttl}분 동안 접속이 없으면 스스로 꺼집니다.`)
    if (opt.open) openTarget(address)
    refreshAlive()
  })
  setInterval(refreshAlive, 15000).unref()
  setInterval(() => { if (Date.now() - lastHit > opt.ttl * 60000) process.exit(0) }, 30000)
}

// ---------- 실행 ----------
function main() {
  const opt = parseArgs(process.argv.slice(2))
  if (opt.help) { console.log(HELP); return }
  if (!['html', 'text', 'json'].includes(opt.format)) { console.error(`알 수 없는 형식: ${opt.format}\n${HELP}`); process.exit(2) }
  const file = findTranscript(opt)
  if (!file || !fs.existsSync(file)) {
    console.error(`세션 기록을 찾지 못했습니다${opt.session ? ` (세션 ${opt.session})` : ''}. --transcript <파일> 로 직접 지정해 주세요. 찾은 위치: ${projectsDir}`)
    process.exit(1)
  }
  if (opt.serve) return serve(file, opt)
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

main()
