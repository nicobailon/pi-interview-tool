# Changelog

## 2026-01-02

### Added
- **Multi-agent queue detection**: When another interview is active, new interviews print URL instead of auto-opening browser, preventing focus stealing
- **Session heartbeat system**: Browser sends heartbeat every 5s; server tracks active sessions
- **Abandoned interview recovery**: Questions saved to `~/.pi/interview-recovery/` on timeout or stale detection
- **Server watchdog**: Detects lost heartbeats (60s grace) and saves recovery before closing
- **Tab close detection**: Best-effort cancel via `pagehide` + `sendBeacon` API
- **Reload protection**: Cmd+R / F5 detected to prevent false cancel on refresh
- **Queued interview toast**: Active interviews show a top-right toast with a dropdown to open queued sessions
- **Queued tool panel output**: Queued interview details render in the tool result panel with a single-line transcript summary
- **Sessions endpoint**: `GET /sessions` returns active/waiting sessions for in-form queue UI
- "Other..." text input option for single/multi select questions
  - Keyboard selection (Enter/Space) auto-focuses the text input
  - Value restoration from localStorage
- Session status bar at top of form
  - Shows cwd path with `~` home directory normalization (cross-platform)
  - Git branch detection via `git rev-parse`
  - Short session ID for identification
- Dynamic document title: `projectName (branch) | sessionId` for tab identification
- `--bg-active-tint` CSS variable for theme-aware active question styling
- Recovery file auto-cleanup (files older than 7 days)

### Changed
- Active question focus styling uses gradient background tint instead of border-only
- Path normalization moved server-side using `os.homedir()` for cross-platform support
- Session registration uses upsert pattern (handles re-registration after prune)
- Cancel endpoint accepts `reason` field: "timeout", "user", or "stale"
- Queue toast position moved to top-right with compact layout

### Fixed
- "Other" option keyboard selection now focuses text input instead of advancing to next question
- "Other" option accepts typing immediately when focused via keyboard
- Light mode active question gradient visibility (increased tint opacity)
- Question focus scroll uses nearest positioning to avoid jarring jumps
- Server-side timeout only starts when browser auto-opens (not for queued interviews)
- `formatTimeAgo` handles negative timestamps (clock skew)
- Race conditions prevented via `completed` flag on server
- Duplicate cancel requests prevented via `cancelSent` flag on client

---

## Unreleased

### Added
- Theme system with light/dark mode support
  - Built-in themes: `default` (monospace, IDE-style) and `tufte` (serif, book-style)
  - Mode options: `dark` (default), `light`, or `auto` (follows OS preference)
  - Custom theme CSS paths via `lightPath` / `darkPath` config
  - Optional toggle hotkey (e.g., `mod+shift+l`) with localStorage persistence
  - OS theme change detection in auto mode
  - Theme toggle appears in the shortcuts bar when configured
- Paste to attach: Cmd+V pastes clipboard image or file path to current question
- Drag & drop anywhere on question card to attach images
- Path normalization for shell-escaped paths and macOS screenshot filenames
- Per-question image attachments for non-image questions
  - Subtle "+ attach" button at bottom-right of each question
  - Tab navigation within attach area, Esc to close
- Keyboard shortcuts bar showing all available shortcuts
- Session timeout with countdown badge and activity-based refresh
- Progress persistence via localStorage
- Image upload via drag-drop, file picker, or path/URL input

### Removed
- "A" keyboard shortcut for attach (conflicted with typing in text areas)

### Fixed
- Space/Enter in attach area no longer triggers option selection
- Duplicate response entries for image questions
- ArrowLeft/Right navigation in textarea and path inputs
- Focus management when closing attach panel
- Hover feedback and tick loop race conditions
- Paste attaching to wrong question when clicking options across questions

### Changed
- MAX_IMAGES increased from 2 to 12
- Timeout default is 600 seconds (10 minutes)
- Replaced TypeBox with plain TypeScript interfaces in schema.ts
- Consolidated code with reusable helpers (handleFileChange, setupDropzone, setupEdgeNavigation, getQuestionValue)

## Initial Release

### Features
- Single-select, multi-select, text, and image question types
- Recommended option indicator (`*`)
- Full keyboard navigation (arrows, Tab, Enter/Space)
- Question-centric navigation (left/right between questions, up/down between options)
- "Done" button for multi-select questions
- Submit with Cmd+Enter
- Session expiration overlay with Stay Here / Close Now options
- Dark IDE-inspired theme
