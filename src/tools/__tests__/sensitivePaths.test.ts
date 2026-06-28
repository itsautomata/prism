import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { classifyRead } from '../sensitivePaths.js'
import { ReadTool } from '../read.js'
import { GrepTool } from '../grep.js'
import { BashTool } from '../bash.js'
import { WriteTool } from '../write.js'
import { EditTool } from '../edit.js'

describe('classifyRead', () => {
  it('allows reads inside the project tree', () => {
    expect(classifyRead('src/x.ts', '/project').allow).toBe(true)
    expect(classifyRead('/project/a/b/c.ts', '/project').allow).toBe(true)
  })

  it('asks for reads outside the project tree', () => {
    expect(classifyRead('/etc/passwd', '/project').allow).toBe(false)
    expect(classifyRead('../sibling/x.ts', '/project').allow).toBe(false)
    expect(classifyRead('/project/../other', '/project').allow).toBe(false)
  })

  it('expands ~ so home paths are treated as outside', () => {
    const c = classifyRead('~/.ssh/id_rsa', '/project')
    expect(c.allow).toBe(false)
    expect(c.reason).toBe('outside-project')
  })

  it('treats ~user/ (shell-expanded to that user home) as outside', () => {
    // the shell expands ~dora/ to /Users/dora; the classifier can't resolve
    // that portably, so it must not be mistaken for an in-project literal.
    expect(classifyRead('~root/.ssh/id_rsa', '/project').allow).toBe(false)
    expect(classifyRead('~dora/proj/x.ts', '/project').allow).toBe(false)
    // bare ~ and ~/ are still handled (home → outside the project)
    expect(classifyRead('~', '/project').allow).toBe(false)
  })

  it('asks for in-project secret files by name/extension', () => {
    expect(classifyRead('/project/.env', '/project')).toMatchObject({ allow: false, reason: 'secret-name' })
    expect(classifyRead('/project/config/.env.production', '/project').allow).toBe(false)
    expect(classifyRead('/project/keys/server.pem', '/project').allow).toBe(false)
    expect(classifyRead('/project/id_ed25519', '/project').allow).toBe(false)
  })
})

describe('classifyRead: symlink escape', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'prism-sp-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('follows a symlink that points outside the project and asks', () => {
    const proj = join(root, 'proj')
    mkdirSync(proj)
    const secret = join(root, 'secret.txt')
    writeFileSync(secret, 'TOP SECRET')
    const link = join(proj, 'innocent.txt')
    symlinkSync(secret, link) // ./innocent.txt -> ../secret.txt
    // lexically the link is inside proj; resolved, it escapes — must ask
    const c = classifyRead(link, proj)
    expect(c.allow).toBe(false)
    // and the resolved field names the real target, not the in-project alias
    expect(c.resolved).toContain('secret.txt')
  })
})

describe('Write/Edit checkPermissions: the prompt names the resolved target', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'prism-we-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  function plantSymlinkProject() {
    const proj = join(root, 'proj')
    mkdirSync(proj)
    const secret = join(root, 'secret.txt')
    writeFileSync(secret, 'x')
    const link = join(proj, 'config.json')
    symlinkSync(secret, link) // in-project alias pointing outside
    return { proj, link }
  }

  it('Write flags a symlink that escapes and names the real target', () => {
    const { proj, link } = plantSymlinkProject()
    const perm = WriteTool.checkPermissions({ file_path: link, content: 'y' }, { cwd: proj })
    expect(perm.behavior).toBe('ask')
    expect(perm.behavior === 'ask' && perm.message).toContain('OUTSIDE')
    expect(perm.behavior === 'ask' && perm.message).toContain('secret.txt')
  })

  it('Edit flags the same escape', () => {
    const { proj, link } = plantSymlinkProject()
    const perm = EditTool.checkPermissions({ file_path: link, old_string: 'a', new_string: 'b' }, { cwd: proj })
    expect(perm.behavior).toBe('ask')
    expect(perm.behavior === 'ask' && perm.message).toContain('OUTSIDE')
  })

  it('a normal in-project write keeps the plain message', () => {
    const proj = join(root, 'proj')
    mkdirSync(proj)
    const perm = WriteTool.checkPermissions({ file_path: 'src/x.ts', content: 'y' }, { cwd: proj })
    expect(perm.behavior === 'ask' && perm.message).toBe('write to src/x.ts')
  })
})

describe('tool checkPermissions: read confinement', () => {
  const cwd = process.cwd() // the repo root — a real, existing project

  it('Read auto-allows an in-project file, asks for an outside one', () => {
    expect(ReadTool.checkPermissions({ file_path: 'package.json' }, { cwd }).behavior).toBe('allow')
    expect(ReadTool.checkPermissions({ file_path: '/etc/hosts' }, { cwd }).behavior).toBe('ask')
    expect(ReadTool.checkPermissions({ file_path: join(homedir(), '.ssh/id_rsa') }, { cwd }).behavior).toBe('ask')
  })

  it('Grep asks when searching outside the project', () => {
    expect(GrepTool.checkPermissions({ pattern: 'x', path: 'src' }, { cwd }).behavior).toBe('allow')
    expect(GrepTool.checkPermissions({ pattern: 'x', path: homedir() }, { cwd }).behavior).toBe('ask')
  })

  it('Bash safe read command asks when a path argument escapes the project', () => {
    expect(BashTool.checkPermissions({ command: 'cat package.json' }, { cwd }).behavior).toBe('allow')
    expect(BashTool.checkPermissions({ command: 'cat ~/.ssh/id_rsa' }, { cwd }).behavior).toBe('ask')
    expect(BashTool.checkPermissions({ command: 'cat /etc/passwd' }, { cwd }).behavior).toBe('ask')
    // ~user form must not bypass — the shell expands it to that user's home
    expect(BashTool.checkPermissions({ command: 'cat ~root/.ssh/id_rsa' }, { cwd }).behavior).toBe('ask')
  })
})
