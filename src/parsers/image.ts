/**
 * image encoder.
 * reads image files and returns base64 for vision models.
 */

import { readFileSync } from 'fs'
import { extname } from 'path'

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
}

export function parseImage(filePath: string): {
  mediaType: string
  base64: string
  description: string
} {
  const ext = extname(filePath).toLowerCase()
  const mediaType = MIME_TYPES[ext] || 'image/png'
  const buffer = readFileSync(filePath)
  const base64 = buffer.toString('base64')
  const sizeKB = Math.round(buffer.length / 1024)

  return {
    mediaType,
    base64,
    description: `image: ${filePath} (${mediaType}, ${sizeKB}KB)`,
  }
}

export function isImageFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return ext in MIME_TYPES
}
