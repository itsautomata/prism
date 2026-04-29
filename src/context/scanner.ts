/**
 * project context scanner.
 * runs once on first prompt. pure read-only. no LLM. no side effects.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { execSync } from 'child_process'
import { join, basename, extname } from 'path'
import { homedir } from 'os'
import type {
  ProjectContext,
  StructureInfo,
  GitInfo,
  DepsInfo,
  PrismState,
  RuntimeInfo,
} from './types.js'

const LANG_MAP: Record<string, string> = {
  // scripting
  '.py': 'python', '.pyw': 'python', '.pyx': 'python',
  '.rb': 'ruby', '.erb': 'ruby',
  '.pl': 'perl', '.pm': 'perl',
  '.php': 'php',
  '.lua': 'lua',
  '.r': 'r', '.R': 'r',
  '.jl': 'julia',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell',
  // web
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.less': 'less', '.sass': 'sass',
  '.svelte': 'svelte', '.vue': 'vue', '.astro': 'astro',
  // systems
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
  '.rs': 'rust',
  '.go': 'go',
  '.zig': 'zig',
  '.nim': 'nim',
  '.d': 'd',
  // jvm
  '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.scala': 'scala',
  '.groovy': 'groovy',
  '.clj': 'clojure', '.cljs': 'clojure', '.cljc': 'clojure',
  // dotnet
  '.cs': 'csharp',
  '.fs': 'fsharp',
  '.vb': 'vb',
  // mobile
  '.swift': 'swift',
  '.dart': 'dart',
  // functional
  '.hs': 'haskell',
  '.ex': 'elixir', '.exs': 'elixir',
  '.erl': 'erlang',
  '.ml': 'ocaml', '.mli': 'ocaml',
  // data / config
  '.sql': 'sql',
  '.graphql': 'graphql', '.gql': 'graphql',
  '.proto': 'protobuf',
  // markup
  '.md': 'markdown', '.mdx': 'mdx',
  '.tex': 'latex',
  '.typ': 'typst',
}

const FRAMEWORK_MAP: Record<string, string> = {
  // python
  fastapi: 'fastapi', flask: 'flask', django: 'django',
  typer: 'typer', click: 'click', streamlit: 'streamlit',
  gradio: 'gradio', panel: 'panel', dash: 'dash',
  celery: 'celery', scrapy: 'scrapy',
  pytest: 'pytest', unittest: 'unittest',
  sqlalchemy: 'sqlalchemy', tortoise: 'tortoise-orm',
  pydantic: 'pydantic',
  // javascript / typescript
  express: 'express', fastify: 'fastify', hono: 'hono', koa: 'koa',
  next: 'nextjs', nuxt: 'nuxt', remix: 'remix', astro: 'astro',
  react: 'react', vue: 'vue', angular: 'angular', svelte: 'svelte',
  solid: 'solid', preact: 'preact', qwik: 'qwik',
  electron: 'electron', tauri: 'tauri',
  jest: 'jest', vitest: 'vitest', mocha: 'mocha',
  prisma: 'prisma', drizzle: 'drizzle',
  tailwindcss: 'tailwind',
  // go
  gin: 'gin', echo: 'echo-go', fiber: 'fiber',
  // rust
  actix: 'actix', axum: 'axum', rocket: 'rocket', tokio: 'tokio',
  // ruby
  rails: 'rails', sinatra: 'sinatra',
  // java / kotlin
  spring: 'spring', quarkus: 'quarkus', ktor: 'ktor',
  // dart
  flutter: 'flutter',
  // swift
  vapor: 'vapor',
  // elixir
  phoenix: 'phoenix',
}

const CONFIG_FILES = [
  // containers
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.dockerignore',
  'Containerfile', 'devcontainer.json',
  // build
  'Makefile', 'CMakeLists.txt', 'build.gradle', 'build.gradle.kts',
  'pom.xml', 'build.zig', 'meson.build', 'Justfile', 'Taskfile.yml',
  // env / secrets
  '.env', '.env.example', '.env.local', '.env.development', '.env.production',
  // git
  '.gitignore', '.gitmodules', '.gitattributes',
  // ci/cd
  '.github/workflows', '.gitlab-ci.yml', '.circleci/config.yml',
  'Jenkinsfile', '.travis.yml', 'azure-pipelines.yml',
  // linting / formatting
  '.eslintrc.json', '.eslintrc.js', 'eslint.config.js', 'eslint.config.mjs',
  '.prettierrc', '.prettierrc.json', 'biome.json',
  '.editorconfig', '.clang-format', 'rustfmt.toml',
  'ruff.toml', 'pyproject.toml', 'setup.cfg', '.flake8', '.pylintrc',
  // typescript / javascript
  'tsconfig.json', 'jsconfig.json',
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'vite.config.ts', 'vite.config.js', 'webpack.config.js', 'rollup.config.js',
  'next.config.js', 'next.config.mjs', 'nuxt.config.ts', 'astro.config.mjs',
  'tailwind.config.js', 'tailwind.config.ts', 'postcss.config.js',
  // python
  'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt',
  'Pipfile', 'Pipfile.lock', 'poetry.lock', 'uv.lock',
  'tox.ini', 'noxfile.py', 'mypy.ini',
  // go
  'go.mod', 'go.sum',
  // rust
  'Cargo.toml', 'Cargo.lock',
  // ruby
  'Gemfile', 'Gemfile.lock', 'Rakefile',
  // java / kotlin
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'gradlew',
  // dart
  'pubspec.yaml',
  // elixir
  'mix.exs',
  // prism
  'lens.md', 'README.md',
]

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', 'env',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  'dist', 'build', 'out', 'target', '_build',
  '.next', '.nuxt', '.svelte-kit', '.astro',
  '.cache', '.parcel-cache', '.turbo',
  'vendor', 'deps', '_deps',
  'coverage', '.nyc_output',
  '.idea', '.vscode', '.fleet',
  '.egg-info', '.eggs', '*.egg-info',
  '.tox', '.nox',
])

export function scanProject(cwd: string): ProjectContext {
  // single pass: compute structure and deps once, share across detections
  const structure = detectStructure(cwd)
  const deps = detectDeps(cwd)
  const language = detectLanguage(structure.filesByType)

  return {
    project: {
      name: basename(cwd),
      language,
      framework: detectFramework(deps.names),
      entryPoint: detectEntryPoint(cwd, language),
    },
    structure,
    git: detectGit(cwd),
    deps,
    prism: detectPrismState(cwd),
    runtime: detectRuntime(),
  }
}
function detectLanguage(filesByType: Record<string, number>): string | null {
  let best: string | null = null
  let bestCount = 0

  for (const [ext, count] of Object.entries(filesByType)) {
    const lang = LANG_MAP[ext]
    if (lang && count > bestCount) {
      best = lang
      bestCount = count
    }
  }

  return best
}

function detectFramework(depNames: string[]): string | null {
  for (const dep of depNames) {
    const lower = dep.toLowerCase()
    for (const [marker, framework] of Object.entries(FRAMEWORK_MAP)) {
      if (lower === marker) return framework
    }
  }
  return null
}

function detectEntryPoint(cwd: string, language: string | null): string | null {
  // check pyproject.toml scripts
  const pyproject = join(cwd, 'pyproject.toml')
  if (existsSync(pyproject)) {
    try {
      const text = readFileSync(pyproject, 'utf-8')
      const match = text.match(/\[project\.scripts\]\s*\n\w+\s*=\s*"([^"]+)"/)
      if (match) {
        return match[1]!.split(':')[0]!.replace(/\./g, '/') + '.py'
      }
    } catch {}
  }

  // check package.json main
  const pkgJson = join(cwd, 'package.json')
  if (existsSync(pkgJson)) {
    try {
      const data = JSON.parse(readFileSync(pkgJson, 'utf-8'))
      if (data.main) return data.main
    } catch {}
  }

  // common filenames
  const candidates: Record<string, string[]> = {
    python: ['main.py', 'app.py', 'server.py', 'cli.py'],
    typescript: ['src/index.ts', 'index.ts', 'src/main.ts', 'main.ts'],
    javascript: ['src/index.js', 'index.js', 'main.js'],
    go: ['main.go', 'cmd/main.go'],
    rust: ['src/main.rs'],
  }

  for (const candidate of candidates[language || ''] || []) {
    if (existsSync(join(cwd, candidate))) return candidate
  }

  return null
}

function detectStructure(cwd: string): StructureInfo {
  const filesByType: Record<string, number> = {}
  const directories: string[] = []
  const configFiles: string[] = []
  let totalFiles = 0

  // check config files
  for (const cf of CONFIG_FILES) {
    if (existsSync(join(cwd, cf))) configFiles.push(cf)
  }

  // scan top-level directories
  try {
    for (const entry of readdirSync(cwd)) {
      const path = join(cwd, entry)
      try {
        const stat = statSync(path)
        if (stat.isDirectory() && !entry.startsWith('.') && !IGNORE_DIRS.has(entry)) {
          directories.push(entry)
        }
      } catch {}
    }
  } catch {}

  // count files by type (max 2 levels deep)
  countFiles(cwd, filesByType, 0, 2)
  for (const count of Object.values(filesByType)) {
    totalFiles += count
  }

  return { totalFiles, filesByType, directories, configFiles }
}

function countFiles(dir: string, counts: Record<string, number>, depth: number, maxDepth: number): void {
  if (depth > maxDepth) return

  try {
    for (const entry of readdirSync(dir)) {
      if (IGNORE_DIRS.has(entry) || entry.startsWith('.')) continue

      const path = join(dir, entry)
      try {
        const stat = statSync(path)
        if (stat.isFile()) {
          const ext = extname(entry)
          if (ext) {
            counts[ext] = (counts[ext] || 0) + 1
          }
        } else if (stat.isDirectory()) {
          countFiles(path, counts, depth + 1, maxDepth)
        }
      } catch {}
    }
  } catch {}
}

function detectGit(cwd: string): GitInfo | null {
  if (!existsSync(join(cwd, '.git'))) return null

  try {
    const branch = exec(cwd, 'git branch --show-current').trim()
    const status = exec(cwd, 'git status --porcelain')
    const clean = status.trim() === ''
    const statusLines = status.trim().split('\n').filter(Boolean).slice(0, 10)
    const log = exec(cwd, 'git log --oneline -5 2>/dev/null')
    const recentCommits = log.trim().split('\n').filter(Boolean)

    let remote: string | null = null
    try {
      remote = exec(cwd, 'git remote get-url origin 2>/dev/null').trim() || null
    } catch {}

    let diffStat: string | null = null
    if (!clean) {
      try {
        const stat = exec(cwd, 'git diff --stat 2>/dev/null').trim()
        if (stat) diffStat = stat.split('\n').pop()?.trim() || null
      } catch {}
    }

    return { branch, clean, recentCommits, remote, statusLines, diffStat }
  } catch {
    return null
  }
}

function detectDeps(cwd: string): DepsInfo {
  // python
  const reqTxt = join(cwd, 'requirements.txt')
  if (existsSync(reqTxt)) {
    try {
      const lines = readFileSync(reqTxt, 'utf-8').split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && !l.startsWith('-'))
        .map(l => l.split(/[><=!~]/)[0]!.trim())
      return { file: 'requirements.txt', count: lines.length, names: lines }
    } catch {}
  }

  // pyproject.toml
  const pyproject = join(cwd, 'pyproject.toml')
  if (existsSync(pyproject)) {
    try {
      const text = readFileSync(pyproject, 'utf-8')
      const names: string[] = []
      let inDeps = false
      for (const line of text.split('\n')) {
        if (line.trim() === 'dependencies = [') { inDeps = true; continue }
        if (inDeps && line.trim() === ']') break
        if (inDeps) {
          const match = line.match(/"([a-zA-Z0-9_.-]+)/)
          if (match) names.push(match[1]!)
        }
      }
      if (names.length > 0) return { file: 'pyproject.toml', count: names.length, names }
    } catch {}
  }

  // package.json
  const pkgJson = join(cwd, 'package.json')
  if (existsSync(pkgJson)) {
    try {
      const data = JSON.parse(readFileSync(pkgJson, 'utf-8'))
      const names = [
        ...Object.keys(data.dependencies || {}),
        ...Object.keys(data.devDependencies || {}),
      ]
      return { file: 'package.json', count: names.length, names }
    } catch {}
  }

  return { file: null, count: 0, names: [] }
}

function detectPrismState(_cwd: string): PrismState {
  // lens.md loading moved to src/memory/lens.ts (memory module).
  let learnedRules = 0
  try {
    const modelsDir = join(homedir(), '.prism', 'models')
    if (existsSync(modelsDir)) {
      for (const file of readdirSync(modelsDir)) {
        if (file.endsWith('.json')) {
          const data = JSON.parse(readFileSync(join(modelsDir, file), 'utf-8'))
          learnedRules += (data.rules || []).length
        }
      }
    }
  } catch {}

  return { learnedRules }
}

function detectRuntime(): RuntimeInfo {
  const shell = process.env.SHELL || 'unknown'
  const node = tryVersion('node --version')
  const python = tryVersion('python3 --version') || tryVersion('python --version')
  const docker = tryVersion('docker --version') !== null

  return { shell, node, python, docker }
}

function exec(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] })
}

function tryVersion(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}
