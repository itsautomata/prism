/**
 * context-aware spinner phrase selection. local signals only.
 *
 * priority (first match wins):
 *   plan-mode + thinking → planMode
 *   thinking + ≥30s      → stuck
 *   running + known tool → tool bucket
 *   after-tool           → afterTool
 *   default              → thinking
 */

export type Phase = 'thinking' | 'running' | 'after-tool'

export interface SelectionContext {
  phase: Phase
  tool?: string
  inPlanMode: boolean
  elapsedSec: number
  /** recent picks to exclude. selector falls back to full pool if filter empties it. */
  recentPhrases?: readonly string[]
}

export const STUCK_THRESHOLD_SEC = 30

export const PHRASES: Record<string, readonly string[]> = {
  planMode: [
    'mapping it out',
    'drafting the approach',
    'tracing the seam',
    'weighing the options',
    'before committing',
    'sketching the shape',
  ],
  stuck: [
    'still working',
    'taking longer than usual',
    'pushing through',
    'still cooking',
    'this one is a puzzle',
    'sticking with it',
  ],

  thinking: [
    'thinkering',
    'considering',
    'thinking',
    'give me a moment',
    'hold on lemme think',
    'figuring it out',
    'reasoning through',
    'cooking',
    'consulting the vibes',
  ],
  Read: [
    'reading',
    'pulling up the file',
    'scanning the source',
    'peeking',
    'taking a look',
  ],
  Edit: [
    'editing',
    'applying the patch',
    'rewriting in place',
    'tweaking it',
    'making the change',
  ],
  Write: [
    'writing',
    'saving to disk',
    'putting it down',
    'committing the file',
  ],
   Bash: [
    'running the shell',
    'firing the command',
    'on the terminal',
    'invoking the command',
  ],
  Verify: [
    'running tests',
    'confirming the change',
    'asking the suite',
    'checking the work',
  ],
  Agent: [
    'briefing a subagent to help me out',
    'delegating the work',
    'splitting the work with a team mate',
    'passing it down to someone else',
  ],
  Glob: [
    'globbing',
    'finding files',
    'walking the tree',
    'looking around',
  ],
  Grep: [
    'grepping',
    'searching the source',
    'pattern matching',
  ],
  WebFetch: [
    'fetching',
    'reading the page',
  ],
  WebSearch: [
    'searching the web',
    'looking it up',
    'consulting the world wide web',
  ],
  useSkill: [
    'loading the skill',
    'invoking the routine',
  ],
  afterTool: [
    'piecing it together',
    'reading the result',
    'connecting it back',
    'making sense of it',
    'looking at what came back',
  ],
}

export function chooseBucket(ctx: SelectionContext): string {
  if (ctx.inPlanMode && ctx.phase === 'thinking') return 'planMode'
  if (ctx.phase === 'thinking' && ctx.elapsedSec >= STUCK_THRESHOLD_SEC) return 'stuck'
  if (ctx.phase === 'running' && ctx.tool && ctx.tool in PHRASES) return ctx.tool
  if (ctx.phase === 'after-tool') return 'afterTool'
  return 'thinking'
}

/** pick one phrase from the routed bucket, excluding anything in recentPhrases. */
export function pickPhrase(ctx: SelectionContext, random: () => number = Math.random): string {
  const bucket = chooseBucket(ctx)
  const pool = PHRASES[bucket] ?? PHRASES.thinking!
  const recent = ctx.recentPhrases
  let candidates: readonly string[] = pool
  if (recent && recent.length > 0) {
    const filtered = pool.filter(p => !recent.includes(p))
    if (filtered.length > 0) candidates = filtered
  }
  const idx = Math.floor(random() * candidates.length)
  return candidates[idx] ?? candidates[0]!
}
