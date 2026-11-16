// 켜져 있는 Claude 세션의 프로세스를 찾아 끈다 (프로젝트 보드의 「끄기」 단추).
// Claude Code 는 켜져 있는 세션마다 <설정 폴더>/sessions/<pid>.json 에 세션 ID 와 프로세스 시작 시각을 적어 둔다.
// 같은 번호를 다른 프로세스가 물려받았을 수 있으니, 끄기 전에 시작 시각과 실행 파일 이름을 다시 맞춰 본다.
import { execFile } from 'node:child_process'
import { runningSessions } from './core.mjs'

const win = process.platform === 'win32'
const run = (cmd, args) => new Promise(resolve => execFile(cmd, args, { windowsHide: true, maxBuffer: 32 << 20, timeout: 30000 }, (err, out) => resolve(err && !out ? null : String(out || ''))))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

// 모든 프로세스의 번호, 부모, 시작 시각(Windows FILETIME), 메모리, 이름.
async function processTable() {
  const rows = new Map()
  if (win) {
    const ps = "Get-CimInstance Win32_Process | ForEach-Object { $t = 0; if ($_.CreationDate) { $t = $_.CreationDate.ToFileTimeUtc() }; '{0} {1} {2} {3} {4}' -f $_.ProcessId, $_.ParentProcessId, $t, $_.WorkingSetSize, $_.Name }"
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps])
    for (const line of (out || '').split(/\r?\n/)) {
      const m = line.match(/^(\d+) (\d+) (\d+) (\d+) (.+)$/)
      if (m) rows.set(+m[1], { pid: +m[1], ppid: +m[2], start: BigInt(m[3]), mem: +m[4], name: m[5].trim() })
    }
  } else {
    const out = await run('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='])
    for (const line of (out || '').split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
      if (m) rows.set(+m[1], { pid: +m[1], ppid: +m[2], start: null, mem: +m[3] * 1024, name: m[4].trim() })
    }
  }
  return rows
}

// 부모 번호가 가리키는 프로세스가 자식보다 늦게 떴으면 번호만 같은 남이다 (Windows 는 부모가 죽어도 번호를 남긴다).
const parentOf = (rows, r) => {
  const p = rows.get(r.ppid)
  if (!p || p.pid === r.pid) return null
  if (p.start != null && r.start != null && p.start > r.start) return null
  return p
}

// 끌 대상: 세션 프로세스와 그 아래 프로세스. 이 보드 서버와 그 위아래 프로세스는 남긴다.
async function plan(id) {
  const rec = runningSessions().map.get(id)
  if (!rec) return { error: '켜져 있지 않은 세션입니다.' }
  const rows = await processTable()
  if (!rows.size) return { error: '프로세스 목록을 읽지 못했습니다.' }
  const me = rows.get(rec.pid)
  if (!me || !/claude|node|bun/i.test(me.name)) return { error: '세션 프로세스를 찾지 못했습니다.' }
  if (rec.procStart && me.start != null) {
    let d
    try { d = me.start - BigInt(rec.procStart) } catch { d = 0n }
    if (d > 10000000n || d < -10000000n) return { error: '같은 번호의 다른 프로세스라 끄지 않았습니다.' }
  }
  const kids = new Map()
  for (const r of rows.values()) {
    const p = parentOf(rows, r)
    if (p) (kids.get(p.pid) || kids.set(p.pid, []).get(p.pid)).push(r)
  }
  const keep = new Set()
  for (let r = rows.get(process.pid), n = 0; r && n < 64; r = parentOf(rows, r), n++) keep.add(r.pid)
  const mine = [process.pid]
  for (let i = 0; i < mine.length; i++) for (const c of kids.get(mine[i]) || []) { keep.add(c.pid); mine.push(c.pid) }
  const below = [], seen = new Set([me.pid])
  const walk = p => { for (const c of kids.get(p) || []) if (!seen.has(c.pid)) { seen.add(c.pid); below.push(c); walk(c.pid) } }
  walk(me.pid)
  const kill = below.filter(r => !keep.has(r.pid))
  return { rec, me, kill, hostsBoard: keep.has(me.pid), mem: me.mem + kill.reduce((a, r) => a + r.mem, 0) }
}

const summary = p => ({ pid: p.me.pid, children: p.kill.length, mem: p.mem, hostsBoard: p.hostsBoard, entry: p.rec.entry || '' })

// 끄기 전에 보여 줄 내용 (무엇을 몇 개, 메모리 얼마).
export async function inspectSession(id) {
  const p = await plan(id)
  return p.error ? { ok: false, error: p.error } : { ok: true, ...summary(p) }
}

export async function stopSession(id) {
  const p = await plan(id)
  if (p.error) return { ok: false, error: p.error }
  const pids = [p.me.pid, ...p.kill.map(r => r.pid)]
  if (win) await run('taskkill', ['/F', ...pids.flatMap(x => ['/PID', String(x)])])
  else {
    for (const x of pids) try { process.kill(x, 'SIGTERM') } catch {}
    for (let i = 0; i < 15 && alive(p.me.pid); i++) await sleep(200)
    for (const x of pids) if (alive(x)) try { process.kill(x, 'SIGKILL') } catch {}
  }
  for (let i = 0; i < 15 && alive(p.me.pid); i++) await sleep(200)
  if (alive(p.me.pid)) return { ok: false, error: '프로세스가 아직 남아 있습니다.' }
  return { ok: true, ...summary(p) }
}
