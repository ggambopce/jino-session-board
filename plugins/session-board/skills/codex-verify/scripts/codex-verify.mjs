#!/usr/bin/env node
// codex-verify: 프로젝트 파일을 Codex CLI 에게 읽기 전용으로 넘겨 독립 검토를 받는다.
// Copyright (c) 2026 JINO. MIT License. 의존성 없음 (Node 18+, codex CLI 필요).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { buildData, codexDir, findTranscript, validSession } from '../../session-board/scripts/core.mjs'

const HELP = `사용법: node codex-verify.mjs [대상] [옵션]

대상 (하나만 고른다. 없으면 git 변경분 -> 세션에서 바꾼 파일 -> 프로젝트 전체 순으로 고른다)
  --paths <파일|폴더> ...   지정한 파일과 폴더
  --diff [기준]             git 변경분 (기준 기본값 HEAD, 추적 안 된 새 파일 포함)
  --session-changes         이 Claude 세션에서 고친 파일
  --all                     프로젝트 전체

옵션
  --focus "<문장>"          특히 봐 달라는 점 (예: "결제 금액 계산이 맞는지")
  --cwd <폴더>              프로젝트 폴더 (기본 현재 폴더)
  --session <id>            결과를 묶을 Claude 세션
  --model <이름>            Codex 모델
  --timeout <초>            제한 시간 (기본 900)
  --dry-run                 Codex 를 부르지 않고 보낼 지시문만 출력`

function parseArgs(argv) {
  const opt = { paths: [], timeout: 900 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : undefined)
    if (a === '--paths') { let v; while ((v = value()) !== undefined) opt.paths.push(v) }
    else if (a === '--diff') { opt.diff = value() || 'HEAD' }
    else if (a === '--session-changes') opt.sessionChanges = true
    else if (a === '--all') opt.all = true
    else if (a === '--focus') opt.focus = value()
    else if (a === '--cwd') opt.cwd = value()
    else if (a === '--session') opt.session = validSession(value())
    else if (a === '--model') opt.model = value()
    else if (a === '--timeout') opt.timeout = Number(value()) || 900
    else if (a === '--dry-run') opt.dryRun = true
    else if (a === '--help' || a === '-h') opt.help = true
    else { console.error(`알 수 없는 옵션: ${a}\n${HELP}`); process.exit(2) }
  }
  return opt
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  return r.status === 0 ? r.stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean) : null
}

function sessionFiles(opt, cwd) {
  const transcript = findTranscript({ session: opt.session, cwd })
  if (!transcript || !fs.existsSync(transcript)) return { files: [], session: opt.session }
  const data = buildData(transcript)
  return { files: data.files.map(f => f.path).filter(p => fs.existsSync(p)), session: data.session.id }
}

function resolveTargets(opt, cwd) {
  if (opt.paths.length) {
    const missing = opt.paths.filter(p => !fs.existsSync(path.resolve(cwd, p)))
    if (missing.length) { console.error(`찾을 수 없는 경로: ${missing.join(', ')}`); process.exit(2) }
    return { mode: 'paths', targets: opt.paths.map(p => path.relative(cwd, path.resolve(cwd, p)) || '.') }
  }
  if (opt.all) return { mode: 'all', targets: [] }
  if (opt.sessionChanges) {
    const { files } = sessionFiles(opt, cwd)
    if (!files.length) { console.error('이 세션에서 고친 파일을 찾지 못했습니다. --paths 로 대상을 지정해 주세요.'); process.exit(2) }
    return { mode: 'session-changes', targets: files }
  }
  if (opt.diff) {
    const changed = git(cwd, ['diff', '--name-only', opt.diff])
    if (!changed) { console.error('git 저장소가 아니거나 기준을 찾지 못했습니다. --paths 나 --all 을 써 주세요.'); process.exit(2) }
    const fresh = git(cwd, ['ls-files', '--others', '--exclude-standard']) || []
    const targets = [...new Set([...changed, ...fresh])]
    if (!targets.length) { console.error(`${opt.diff} 기준으로 바뀐 파일이 없습니다.`); process.exit(2) }
    return { mode: `diff ${opt.diff}`, targets }
  }
  // 대상 지정이 없을 때: 변경분 -> 세션에서 바꾼 파일 -> 전체
  const changed = git(cwd, ['diff', '--name-only', 'HEAD'])
  if (changed) {
    const targets = [...new Set([...changed, ...(git(cwd, ['ls-files', '--others', '--exclude-standard']) || [])])]
    if (targets.length) return { mode: 'diff HEAD', targets }
  }
  const { files } = sessionFiles(opt, cwd)
  const inside = files.filter(p => !path.relative(cwd, p).startsWith('..'))
  if (inside.length) return { mode: 'session-changes', targets: inside }
  return { mode: 'all', targets: [] }
}

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'summary', 'findings', 'checked'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'concerns', 'fail'] },
    summary: { type: 'string' },
    checked: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'file', 'line', 'title', 'detail', 'suggestion'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'note'] },
          file: { type: 'string' }, line: { type: 'integer' },
          title: { type: 'string' }, detail: { type: 'string' }, suggestion: { type: 'string' },
        },
      },
    },
  },
}

function buildPrompt({ mode, targets }, opt) {
  const scope = mode === 'all'
    ? '이 프로젝트 전체를 살펴본다. 진입점과 핵심 로직부터 읽고, 생성물이나 의존성 폴더(node_modules, dist, build, .git 등)는 건너뛴다.'
    : `다음 대상을 검토한다 (${mode}). 필요하면 이 대상이 의존하는 주변 파일도 읽는다.\n${targets.slice(0, 200).map(t => `- ${t}`).join('\n')}${targets.length > 200 ? `\n- 그 밖에 ${targets.length - 200}개` : ''}`
  return [
    '너는 다른 AI(Claude)가 작성하거나 고친 코드를 독립적으로 교차검증하는 두 번째 검토자다.',
    '파일은 읽기만 한다. 아무것도 고치거나 만들지 말고, 네트워크를 쓰는 명령도 실행하지 않는다.',
    '', scope, '',
    opt.focus ? `특히 확인할 점: ${opt.focus}\n` : '',
    '확인할 것: 실제로 틀리게 동작하는 버그, 처리되지 않는 예외와 경계값, 보안 문제, 데이터 손실 위험, 코드와 문서 또는 주석의 불일치, 빠진 검증.',
    '취향 차이나 사소한 스타일은 적지 않는다. 직접 파일을 읽어 확인한 것만 적고, 추측이면 detail 에 추측이라고 밝힌다.',
    '',
    '답은 한국어로, 지정된 JSON 형식으로만 낸다.',
    '- verdict: 문제 없음은 pass, 고칠 점이 있으면 concerns, 그대로 쓰면 안 되면 fail',
    '- summary: 전체 판단 두세 문장',
    '- checked: 실제로 읽은 파일 경로',
    '- findings: 문제마다 severity(critical, major, minor, note), file, line(모르면 0), title, detail(왜 문제인지와 재현 조건), suggestion(고치는 방향)',
  ].filter(x => x !== '').join('\n')
}

function runCodex(prompt, cwd, opt, schemaFile, outFile) {
  const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never', '-C', cwd, '--output-schema', schemaFile, '-o', outFile]
  if (opt.model) args.push('-m', opt.model)
  args.push('-')
  const win = process.platform === 'win32'
  // 윈도우의 codex 는 .cmd 래퍼라 셸을 거쳐야 하므로 인자를 직접 따옴표로 감싼다.
  const quoted = win ? args.map(a => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '')}"` : a)) : args
  return new Promise(resolve => {
    let child
    try { child = spawn('codex', quoted, { cwd, shell: win, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) }
    catch (err) { return resolve({ code: -1, log: String(err && err.message || err) }) }
    let log = ''
    const keep = chunk => { log = (log + chunk).slice(-6000) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => { keep('\n[제한 시간을 넘겨 중단함]'); child.kill() }, opt.timeout * 1000)
    child.on('error', err => { clearTimeout(timer); resolve({ code: -1, log: log + String(err.message) }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, log }) })
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}

const SEVERITY = { critical: '치명', major: '중요', minor: '경미', note: '참고' }
const VERDICT = { pass: '통과', concerns: '고칠 점 있음', fail: '불합격' }

function report(rec) {
  const L = [`# Codex 교차검증: ${VERDICT[rec.verdict] || rec.verdict}`, '', rec.summary || '', '']
  L.push(`대상: ${rec.mode}${rec.targets.length ? ` (${rec.targets.length}개)` : ''} · 읽은 파일 ${rec.checked.length}개 · ${Math.round(rec.durationMs / 1000)}초`)
  if (rec.focus) L.push(`중점: ${rec.focus}`)
  L.push('', `## 지적 사항 (${rec.findings.length})`)
  if (!rec.findings.length) L.push('없음')
  rec.findings.forEach((f, i) => {
    L.push('', `${i + 1}. [${SEVERITY[f.severity] || f.severity}] ${f.title}`, `   위치: ${f.file}${f.line ? ':' + f.line : ''}`, `   내용: ${f.detail}`)
    if (f.suggestion) L.push(`   제안: ${f.suggestion}`)
  })
  L.push('', `기록: ${rec.file}`)
  return L.join('\n')
}

async function main() {
  const opt = parseArgs(process.argv.slice(2))
  if (opt.help) { console.log(HELP); return }
  const cwd = path.resolve(opt.cwd || process.cwd())
  if (!fs.existsSync(cwd)) { console.error(`폴더가 없습니다: ${cwd}`); process.exit(2) }
  const target = resolveTargets(opt, cwd)
  const prompt = buildPrompt(target, opt)
  if (opt.dryRun) { console.log(`[대상] ${target.mode} ${target.targets.length}개\n[폴더] ${cwd}\n\n${prompt}`); return }

  const probe = spawnSync('codex', ['--version'], { shell: process.platform === 'win32', encoding: 'utf8', windowsHide: true })
  if (probe.status !== 0) { console.error('codex CLI 를 찾지 못했습니다. Codex CLI 를 설치하고 codex login 으로 로그인한 뒤 다시 실행해 주세요.'); process.exit(3) }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-verify-'))
  const schemaFile = path.join(tmp, 'schema.json')
  const outFile = path.join(tmp, 'answer.json')
  fs.writeFileSync(schemaFile, JSON.stringify(SCHEMA))
  const started = Date.now()
  console.error(`Codex 에게 검토를 맡겼습니다 (${target.mode}${target.targets.length ? ` ${target.targets.length}개` : ''}). 몇 분 걸릴 수 있습니다.`)
  const run = await runCodex(prompt, cwd, opt, schemaFile, outFile)

  let answer = null
  try { answer = JSON.parse(fs.readFileSync(outFile, 'utf8')) } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  if (!answer) {
    const limit = run.log.match(/usage limit[^\n]*/i)
    if (limit) { console.error(`Codex 계정 사용 한도에 걸려 검토를 마치지 못했습니다. Codex 안내: ${limit[0].trim()}`); process.exit(5) }
    if (/not logged in|login required|401 Unauthorized/i.test(run.log)) { console.error('Codex 에 로그인되어 있지 않습니다. 터미널에서 codex login 을 실행해 주세요.'); process.exit(3) }
    console.error(`Codex 가 결과를 내지 못했습니다 (종료 코드 ${run.code}). 마지막 출력:\n${run.log.slice(-2000)}`)
    process.exit(4)
  }

  const session = opt.session || sessionFiles(opt, cwd).session || ''
  const at = new Date().toISOString()
  const dir = path.join(codexDir, session || 'adhoc')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${at.replace(/[:.]/g, '-')}.json`)
  const rec = {
    at, session, cwd, mode: target.mode, targets: target.targets, focus: opt.focus || '', model: opt.model || '',
    codexVersion: (probe.stdout || '').trim(), durationMs: Date.now() - started,
    verdict: answer.verdict, summary: answer.summary || '', checked: answer.checked || [], findings: answer.findings || [], file,
  }
  fs.writeFileSync(file, JSON.stringify(rec, null, 2))
  console.log(report(rec))
}

main()
