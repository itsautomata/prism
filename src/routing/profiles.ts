/**
 * task prompt profiles.
 * each task type gets additional instructions
 * injected into the system prompt.
 *
 * same model, different behavior per task.
 * routing without swapping models.
 */

import type { TaskType } from './classifier.js'

const PROFILES: Record<TaskType, string> = {

  code: `# task mode: code

you are writing or editing code. be precise.

- read the existing code before modifying it
- match the style of the surrounding code (indentation, naming, patterns)
- use the Edit tool for modifications, not Write (preserves what's there)
- use Read to understand context before making changes
- if the change spans multiple files, do them in dependency order
- run tests or checks after editing if a test command is available
- never guess file paths. use Glob to find files first.
- when a tool succeeds, tell the user what happened and STOP. do not repeat the same tool call.
- only continue calling tools if there are more steps the user asked for.`,

  reasoning: `# task mode: reasoning

you are analyzing, explaining, or debugging. think carefully.

- break the problem into parts before answering
- consider edge cases and counterexamples
- if debugging, read the error message carefully before acting
- if comparing approaches, list concrete tradeoffs, not vague opinions
- use tools to verify claims. don't guess what code does, read it.
- if you're unsure, say so. uncertainty is more useful than a wrong answer.`,

  search: `# task mode: search

you are finding things in the codebase. be efficient.

- use Grep for content search (fastest for known strings or patterns)
- use Glob for file name search (fastest for finding files by extension or name)
- use Read only after you've found the right file
- don't use Bash for search (Grep and Glob are faster and more precise)
- show results concisely. file paths and line numbers, not full file contents.
- if the first search doesn't find it, try different terms before giving up.`,

  conversation: `# task mode: conversation

the user is talking, not requesting an action.

- respond naturally and directly
- if the user is greeting you, greet back
- if the user asks a knowledge question, answer from what you know
- you still have access to tools if the conversation turns into a task`,

  simple: `# task mode: simple

the user wants one quick action.

- one tool call, minimal explanation
- don't over-explain what you're about to do
- execute and show the result
- if it fails, diagnose briefly and retry once
- after a successful tool call, respond with the result and STOP. do not call more tools.`,
}

/**
 * get the prompt profile for a task type.
 */
export function getTaskProfile(taskType: TaskType): string {
  return PROFILES[taskType]
}
