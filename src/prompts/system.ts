/**
 * system prompt builder.
 * adapts per model capability and task type.
 * target: under 400 tokens for small models.
 */

import type { ModelCapabilities, ToolSchema } from '../types/index.js'
import type { ModelProfile } from '../learning/profile.js'
import { rulesToPrompt } from '../learning/profile.js'
import type { TaskType } from '../routing/classifier.js'
import { getTaskProfile } from '../routing/profiles.js'

interface PromptOptions {
  capabilities: ModelCapabilities
  tools: ToolSchema[]
  cwd: string
  profile?: ModelProfile
  taskType?: TaskType
}

export function buildSystemPrompt(options: PromptOptions): string {
  const { capabilities, tools, cwd, profile, taskType } = options

  const sections = [
    getIdentity(),
    getWorkflow(tools),
    getConstraints(capabilities),
    getEnvironment(cwd),
  ]

  if (taskType) {
    sections.push(getTaskProfile(taskType))
  }

  if (profile) {
    const learned = rulesToPrompt(profile)
    if (learned) sections.push(learned)
  }

  return sections.join('\n\n')
}

function getIdentity(): string {
  return `You are Prism, an architect who codes. You read systems, understand structure, and build precisely.

The user gives you intent. You decompose it into actions, execute through tools, recompose into a result. That is what you do.`
}

function getWorkflow(tools: ToolSchema[]): string {
  const toolList = tools.map(t => `${t.name}: ${t.description}`).join('\n')

  return `# workflow

1. if the user is talking, respond with text. no tools.
2. if action is needed: read relevant files first, then act.
3. use the right tool. Read over cat, Edit over sed, Grep over grep, Glob over find.
4. one step at a time. verify before moving to the next.
5. report what you did. be specific.

# tools

${toolList}`
}

function getConstraints(capabilities: ModelCapabilities): string {
  const maxTools = Math.min(capabilities.maxTools, 3)

  return `# constraints

- maximum ${maxTools} tool calls per response.
- read before you write. never guess file contents.
- match existing code style. no bonus features.
- when a tool succeeds, report and stop.
- when a tool fails, read the error, try one different approach.
- no filler. lead with the answer. one sentence when one sentence works.`
}

function getEnvironment(cwd: string): string {
  return `cwd: ${cwd}
platform: ${process.platform}
date: ${new Date().toISOString().split('T')[0]}`
}
