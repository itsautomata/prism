/**
 * prism green theme.
 * every color in one place.
 */

export const theme = {
  // primary
  primary: '#00ff88',        // bright green — the prism color
  primaryDim: '#00cc66',     // muted green
  primaryBright: '#33ffaa',  // highlight green

  // text
  text: '#e0e0e0',          // default text
  textDim: '#888888',        // secondary text
  textMuted: '#555555',      // very dim

  // accents
  accent: '#00ddff',         // cyan for tool names
  warning: '#ffaa00',        // amber for shell mode and warnings
  planMode: '#a78bfa',       // soft violet for plan mode (cool, contemplative)
  error: '#ff4444',          // red for errors
  success: '#00ff88',        // same as primary

  // UI elements
  border: '#00cc66',         // borders
  prompt: '#00ff88',         // prompt character
  cursor: '#00ff88',         // cursor
  spinner: '#00ff88',        // loading spinner

  // tool results
  toolName: '#00ddff',       // tool name highlight
  toolOutput: '#aaaaaa',     // tool output text
  toolError: '#ff4444',      // tool error text

  // thinking
  thinking: '#666666',       // thinking text (dim)
} as const
