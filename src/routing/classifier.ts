/**
 * task classifier.
 * no LLM needed. rule-based classification of user intent.
 * determines which prompt profile to use per task.
 *
 * this is prism's routing on 16GB:
 * same model, different prompts per task type.
 */

export type TaskType = 'code' | 'reasoning' | 'search' | 'conversation' | 'simple'

interface ClassificationResult {
  type: TaskType
  confidence: number  // 0-1
}

// patterns that indicate code tasks
const CODE_PATTERNS = [
  /\b(?:refactor|implement|write|create|add|build|fix|patch|update)\b.*\b(?:function|class|method|component|module|file|test|api|endpoint)\b/i,
  /\b(?:import|export|const|let|var|def|class|function|async|return)\b/i,
  /\b(?:typescript|javascript|python|rust|go|java|react|vue|angular)\b/i,
  /\b(?:bug|error|fix|broken|crash|fail|issue)\b.*\b(?:code|function|file|line|module)\b/i,
  /\b(?:edit|change|modify|replace|rename|move)\b.*\b(?:file|function|variable|class)\b/i,
  /\.(?:ts|js|py|rs|go|java|tsx|jsx|cpp|c|rb)\b/,
  /```/,  // code blocks in message
]

// patterns that indicate reasoning/analysis tasks
const REASONING_PATTERNS = [
  /\b(?:why|how|explain|analyze|compare|evaluate|think|consider|reason)\b/i,
  /\b(?:architecture|design|pattern|tradeoff|approach|strategy|decision)\b/i,
  /\b(?:debug|diagnose|investigate|root cause|figure out)\b/i,
  /\b(?:what happens if|what would|should i|is it better)\b/i,
  /\b(?:pros? and cons?|advantages?|disadvantages?|benefits?)\b/i,
  /\bwhy\b.*\b(?:not|doesn't|isn't|won't|can't)\b/i,
]

// patterns that indicate search/exploration tasks
const SEARCH_PATTERNS = [
  /\b(?:find|search|look for|locate|where is|grep|glob)\b/i,
  /\b(?:which files?|show me|list all|how many)\b.*\b(?:files?|functions?|classes?|imports?|references?)\b/i,
  /\b(?:codebase|repo|project|directory)\b.*\b(?:structure|layout|overview)\b/i,
  /\b(?:who|what|where)\b.*\b(?:uses?|calls?|imports?|defines?|declares?)\b/i,
]

// patterns that indicate simple/quick tasks
const SIMPLE_PATTERNS = [
  /^(?:pwd|ls|cd|cat|echo|date|whoami)\b/,
  /^(?:git\s+(?:status|log|diff|branch))\b/,
  /^(?:run|execute|do)\s+\S+$/i,
  /^(?:show|print|display)\s+\S+$/i,
]

// patterns that indicate conversation (no tools needed)
const CONVERSATION_PATTERNS = [
  /^(?:hello|hi|hey|thanks|thank you|bye|goodbye|ok|okay|sure|yes|no|yeah|nah)\s*[.!?]?$/i,
  /^(?:how are you|what's up|good morning|good night)\b/i,
  /^(?:what is|what are|define|tell me about)\b(?!.*\b(?:file|code|function|error)\b)/i,
  /^(?:can you|do you|are you)\b/i,
  /\?$/, // ends with question mark and no code/file indicators
]

/**
 * classify user input into a task type.
 * returns type + confidence score.
 */
export function classifyTask(input: string): ClassificationResult {
  const trimmed = input.trim()

  // short messages are usually conversation
  if (trimmed.length < 10 && !trimmed.startsWith('/') && !trimmed.startsWith('!')) {
    const isConvo = CONVERSATION_PATTERNS.some(p => p.test(trimmed))
    if (isConvo) return { type: 'conversation', confidence: 0.95 }
  }

  // score each category
  const scores: Record<TaskType, number> = {
    code: scorePatterns(trimmed, CODE_PATTERNS),
    reasoning: scorePatterns(trimmed, REASONING_PATTERNS),
    search: scorePatterns(trimmed, SEARCH_PATTERNS),
    conversation: scorePatterns(trimmed, CONVERSATION_PATTERNS),
    simple: scorePatterns(trimmed, SIMPLE_PATTERNS),
  }

  // find the highest scoring type
  let bestType: TaskType = 'conversation'
  let bestScore = 0

  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score
      bestType = type as TaskType
    }
  }

  // if nothing scored well, check message length
  // long messages with no clear pattern are likely reasoning
  if (bestScore === 0) {
    if (trimmed.length > 100) return { type: 'reasoning', confidence: 0.4 }
    return { type: 'conversation', confidence: 0.5 }
  }

  // normalize confidence
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0)
  const confidence = totalScore > 0 ? bestScore / totalScore : 0.5

  return { type: bestType, confidence }
}

function scorePatterns(text: string, patterns: RegExp[]): number {
  let score = 0
  for (const pattern of patterns) {
    if (pattern.test(text)) score++
  }
  return score
}
