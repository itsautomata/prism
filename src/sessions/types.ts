/**
 * session types.
 */

import type { Message } from '../types/index.js'

export interface Session {
  id: string
  model: string
  provider: string
  cwd: string
  createdAt: string
  updatedAt: string
  messages: Message[]
}
