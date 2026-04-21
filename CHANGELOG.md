# Changelog

## [Unreleased]

### Added
- **Option clarifications for plain choice questions**: Plain string single/multi options can now reveal a separate inline `Optional clarification...` field when selected. Submitted and saved choice responses now use structured `{ option, note? }` objects instead of bare strings.

### Fixed
- **Clarification draft retention**: Switching away from a selected option now hides its clarification field without discarding the typed draft, so switching back restores the earlier text.
- **Clarification preservation during rewrites/review**: `Use rewrite` and question-level `Review options` now preserve structured choice answers and attached clarification notes instead of degrading them into plain strings or dropping them.

## [0.7.0] - 2026-04-16

### Added
- **Per-option Ask flow**: Single and multi-select options, including rich options with inline content blocks, can now open an inline `Ask` panel for option-specific follow-up questions, with prompt chips, freeform prompts, structured analysis responses, and follow-up actions like pinning, replacing text, moving options up, or adding suggested rewrites as new options.
- **Advanced model overrides for option analysis**: The new `Ask` panel shows the default model quietly and exposes provider-first then model selection behind an Advanced section for low-clutter per-request overrides.

### Changed
- **Pinned option analyses persist in drafts and snapshots**: Saved interview snapshots and local autosave state now preserve pinned option analyses so option-level reasoning survives reloads and saved HTML revival, while staying out of submitted response payloads by default.
- **Server-side option state now covers option mutations**: Option rewrites and reordering actions from the Ask flow now update the in-memory interview definition so saves and reopened sessions stay aligned with what the user saw.

## [0.6.2] - 2026-04-16

### Changed
- **Content block API (breaking)**: Replaced question `codeBlock` and rich-option `code` with `content` blocks using `source` + `lang`.
- **Legacy field enforcement (breaking)**: Legacy `codeBlock` and rich-option `code` now fail schema validation with explicit migration errors. Use `content` instead.
- **Markdown-by-default rendering**: `content.lang: "md" | "markdown"` now renders Markdown preview by default. Set `showSource: true` to force raw Markdown source.
- **Rendering parity**: `content` rendering rules now match between the live interview UI and saved interview snapshots.

### Fixed
- Code snippets in the live interview UI and saved interview snapshots now wrap long lines instead of clipping or forcing horizontal overflow.
- `showSource` is now enforced as markdown-only in schema validation and docs, matching runtime behavior.
- Removed an unused client-side `renderedHtml` branch from markdown content rendering.

## [0.6.1] - 2026-04-04

### Fixed
- **Tool discoverability with pi v0.59+**: Added `promptSnippet` to the `interview` tool registration so it remains eligible for inclusion in pi's default `Available tools` system prompt.
- **Review options question rewrite**: `Review options` now also rewrites the question text for clarity while keeping the existing option-review behavior.
- **Generated/reviewed question persistence**: Generated options and reviewed question rewrites now persist in the server-side interview state, so saves, recovery, and reopened snapshots stay in sync with what the user saw in the form.
- **Review-mode recommendation cleanup**: When reviewed options remove or rename previously recommended answers, `recommended` and `conviction` are now cleared or narrowed so saved interviews do not fail validation on reload.
- **Rich option generate/review support**: `Generate more` and `Review options` now work on rich-option questions too. Rich review responses keep structured `{ label, content? }` option objects instead of flattening them, save/reload snapshots preserve the reviewed structure, and surviving option labels keep their existing option keys so pinned Ask insights stay attached when the option genuinely survives a review pass.
- **Saved interview answer integrity**: Reloading saved interview HTML now resolves paths only for image answers and attachments. Text, single-select, and multi-select answers remain literal so forms pre-populate correctly.
- **Submit/save error clarity**: Client-side save/submit failures now include the original error message instead of collapsing to generic text.

## [0.6.0] - 2026-03-30

### Added
- **Generate & review options**: Single and multi-select questions show two LLM-powered buttons: "✦ Generate more" appends new deduplicated choices, and "↻ Review options" validates and rewrites the existing options. Default model is the agent's current model, configurable via `generateModel` in interview settings.

### Fixed
- **Generate model fallback**: When an explicitly configured `generateModel` fails at request time, interview now surfaces the provider error and retries once with the current session model when it differs.
- **Codex-compatible generation requests**: Generate/review requests now include a system prompt, so fallback to `openai-codex` session models works instead of failing with `{"detail":"Instructions are required"}`.

## [0.5.5] - 2026-03-21

### Added
- **Native macOS rendering**: When `glimpseui` is installed separately (`pi install npm:glimpseui`), interviews open in a native WKWebView window instead of a browser tab. Window lifecycle (submit, cancel, timeout) and queue toast session switching work correctly in the native environment. Falls back to browser on other platforms or when Glimpse is not detected.
- **Inline JSON**: Pass questions as a JSON string directly to the `questions` parameter instead of writing a temp file.

### Fixed
- **Queued interview handoff**: When submitting an interview with queued sessions waiting, the Glimpse/browser window now redirects to the next queued interview instead of closing. The submit response includes the oldest queued session's URL, and the client navigates to it directly.
- **Queue ordering stability**: Next-session handoff now uses a deterministic tie-breaker (`startedAt`, then `session id`) so simultaneous starts cannot produce ambiguous promotion order.
- **Settings parse failures are now visible**: Invalid `~/.pi/agent/settings.json` JSON no longer silently falls back to defaults; the tool now throws with parse context so config errors are debuggable.
- **Submit response parsing**: Client submit flow now preserves JSON parse failures from `/submit` instead of replacing them with a generic fallback object.
- **Queued session staleness**: Queued interview sessions now stay alive in the sessions registry via a server-side keep-alive interval, so queued sessions without browser heartbeats no longer go stale.

## [0.5.4] - 2026-03-16

### Fixed
- Single-select questions now unwrap `recommended: ["Option"]` to `"Option"` instead of throwing, matching the multi-select coercion that already wraps strings into arrays.

## [0.5.3] - 2026-03-15

### Fixed
- **LLM JSON repair**: When an LLM produces slightly malformed inline JSON (trailing commas, markdown code fences, single-line comments, curly smart quotes), `loadQuestions` now attempts a sanitized re-parse before failing. Valid JSON is unaffected — the repair only runs as a fallback when `JSON.parse` already failed. Saves agents a retry round-trip on common generation hiccups.

## [0.5.1] - 2026-02-15

### Added
- Schema validation unit tests (`schema.test.ts`) covering all validation rules, field types, media blocks, conviction/weight semantics, codeBlock validation, and edge cases.

### Fixed
- Saved HTML snapshots now copy local media images to the `images/` subfolder and rewrite `src` paths. Previously, `media: { type: "image", src: "/local/path.png" }` embedded the absolute path, which broke when the server wasn't running.
- `copyMediaImages` now resolves relative paths against the server's explicit `cwd`, not `process.cwd()`, matching the `/media` route's path resolution.
- Badge rendering uses `badgeNumber !== null` instead of a truthiness check that would silently skip badge 0 if numbering were ever changed to 0-indexed.
- `loadProgress` fresh-load branch now matches `createQuestionCard`'s pre-selection logic exactly (`recs.length > 0` instead of `q.recommended` truthiness, which incorrectly passed for empty arrays).

## [0.5.0] - 2026-02-15

### Added
- **Visual redesign**: New typography system with Google Fonts (Outfit, Space Mono, Instrument Serif, JetBrains Mono). Granular CSS variables for font sizes, card spacing, and a 6-color question palette (`--q-color-1` through `--q-color-6`). Each question card gets a colored left border, numbered badge, and staggered fadeUp entrance animation with `prefers-reduced-motion` support. Radial gradient background atmosphere. Container widened to 740px.
- **Rich media content**: New `MediaBlock` type supporting image, chart (Chart.js), mermaid diagram, table, and HTML content in questions. Optional caption, position (`above`, `below`, `side` two-column grid), and maxHeight. CDN scripts for Chart.js and Mermaid injected only when needed.
- **Info question type**: Non-interactive content panel for displaying context alongside media. Visually distinct from questions: uniform neutral border, no shadow, muted title. Skipped during keyboard navigation; excluded from responses and persistence.
- **Conviction signals**: Optional `conviction` field on questions with `recommended`. All recommended options show a "Recommended" pill badge. `conviction: "slight"` opts out of pre-selection; `"strong"` and default (omitted) pre-select.
- **Question weight**: Optional `weight` field. `"critical"` renders a prominent card (5px accent border, tinted background). `"minor"` renders a compact card (smaller padding, text, and gaps; no shadow).
- **Pre-selection**: Recommended options are pre-checked on load unless `conviction: "slight"`. Saved state and savedAnswers override pre-selection.
- **Media serving**: `/media` GET route serves local images with path security (resolve normalization, directory-boundary checks against cwd/homedir/tmpdir).
- **Saved HTML**: Media blocks, context text, info panels, conviction indicators, and weight styling all render in saved interview HTML snapshots.
- `test-media.json` and `test-taste.json` fixtures for testing.

### Changed
- Replaced `--font-ui` with explicit `--font-body` or `--font-mono` references throughout CSS.
- Tufte themes now use Instrument Serif + JetBrains Mono instead of Cormorant Garamond + IBM Plex Mono.
- All four theme files updated with per-theme `--q-color-*` palettes.
- Option items have visible borders and accent-colored focus rings instead of background-only hover.
- Active card styling uses box-shadow lift instead of gradient tint + border color.
- Responsive breakpoint changed from 720px to 768px.
- `focusQuestion()` returns boolean to signal whether a valid card was found.
- Badge numbering skips info panels (not questions) with a separate counter (no gaps).
- Tool description updated with conviction, weight, and pre-filled form guidance.

### Fixed
- **Paste not working in text inputs**: Clipboard data with both text and image representations (common when copying from web pages) caused `handlePaste` to intercept the image and swallow the text. Text inputs now let native paste through when clipboard has text data.
- Paste handler `isTextInput` check narrowed to `textarea` and `input[type="text"]` only — radio, checkbox, and file inputs no longer falsely trigger the text-paste early return.
- Responsive bottom padding removed at 768px and 480px breakpoints where shortcuts bar is hidden.
- Path traversal in `/media` route: absolute paths with `..` segments bypassed `startsWith` check. Fixed with `resolve()` normalization.
- Prefix collision in `/media` route: `/Users/nick` matched `/Users/nick2/secrets`. Fixed with `dir + "/"` boundary check.
- HTTP/HTTPS/data URI images no longer proxied through `/media` endpoint (caused silent 404s).
- Saved HTML now includes `context` text for regular questions (was only rendered for info panels).
- `loadProgress` fresh-load branch (enabling Done buttons for pre-selected multi questions) was unreachable when `localStorage.getItem` throws. Restructured with a `loaded` flag so the branch runs outside the try/catch.

## [0.4.5] - 2026-02-01

### Fixed
- Adapt execute signature to pi v0.51.0: reorder signal, onUpdate, ctx parameters

## [0.4.4] - 2026-01-27

### Fixed
- Google API compatibility: Use `StringEnum` for theme mode instead of `Type.String()` (thanks @Whamp, PR #3)

## [0.4.3] - 2026-01-27

### Fixed
- Success overlay now centered in viewport when scrolled down (changed `position: absolute` to `position: fixed`)

### Changed
- Removed unused `startedAt` variable from script.js
- Removed unused `resp.type` property assignment in `collectResponses()`

## [0.4.2] - 2026-01-26

### Fixed
- Install script now copies `package.json` with `pi.extensions` declaration for auto-discovery

## [0.4.1] - 2026-01-26

### Changed
- Added `pi-package` keyword for npm discoverability (pi v0.50.0 package system)

## 0.4.0 - 2026-01-24

### Added
- **Save snapshots**: Save interview state to HTML files for later review or revival
  - Manual save via Save button (header and footer)
  - Auto-save on submit (enabled by default, configurable via `autoSaveOnSubmit`)
  - Snapshots saved to `~/.pi/interview-snapshots/` (configurable via `snapshotDir`)
  - Self-contained HTML with embedded JSON data for revival
  - Images copied to `images/` subfolder with relative paths
  - Folder naming: `{title}-{project}-{branch}-{timestamp}[-submitted]/`
- **Revival from saved interviews**: Pass saved HTML path to `interview()` to reopen with pre-populated answers
  - Supports editing and re-submitting saved interviews
  - Image paths resolved relative to snapshot location
- **New settings**: `snapshotDir` and `autoSaveOnSubmit` in interview settings
- Save toast notification shows save location on success/failure

### Changed
- `loadQuestions()` now accepts both JSON and HTML files
- Questions parameter can be a path to a saved interview HTML

---

## 0.3.2 - 2026-01-18

### Changed
- **Skip-friendly cancel behavior**: When user cancels/dismisses the interview, the tool now returns context-aware messages:
  - No answers provided → "User skipped the interview without providing answers. Proceed with your best judgment - use recommended options where specified, make reasonable choices elsewhere. Don't ask for clarification unless absolutely necessary."
  - Partial answers provided → "User cancelled the interview with partial responses: [responses]. Proceed with these inputs and use your best judgment for unanswered questions."
- **Timeout preserves partial answers**: If the interview times out with partial responses, they're now included in the result message
- Cancel and timeout requests now include current form responses so the agent can use partial input

---

## 0.3.1 - 2026-01-17

### Changed
- **Other input**: Changed from single-line text input to auto-growing textarea with line wrapping

### Fixed
- **Overflow layout bug**: Code blocks no longer expand beyond container and break page layout
  - Added `min-width: 0` to flex containers to allow proper shrinking
  - Fixed `.code-block-lines-container` to use `min-width: 100%` instead of `width: 100%`
- **Done button alignment**: Added missing `display: flex` to `.done-item` (flex properties were being ignored)
- **Session bar responsive margin**: Fixed 4px gap at 720px breakpoint where margin didn't match container padding

---

## 0.3.0 - 2026-01-17

### Added
- **Code blocks**: Display code snippets in questions and options
  - Question-level `codeBlock` field shown below question text, above options
  - Rich options: options can be `{ label, code? }` objects instead of plain strings
  - Syntax highlighting for diff (`lang: "diff"`) with green/red line coloring
  - Optional file path and line range display in header
  - Line highlighting via `highlights` array
  - Line numbers shown when `file` or `lines` specified
- **Light markdown in questions**: Question titles and context now render `**bold**`, `` `code` ``, and auto-break numbered lists
- **Default theme toggle hotkey**: `Cmd+Shift+L` (Mac) / `Ctrl+Shift+L` (Windows/Linux) now works out of the box
- **Fixed port setting**: Configure `port` in settings to use a consistent port across sessions
- Shared settings module (`settings.ts`) for consistent settings access across tool and server

### Removed
- **Voice mode**: Removed ElevenLabs voice interview integration entirely
  - Deleted `elevenlabs.ts`, `form/voice.js`, `form/settings.js`
  - Removed voice toggle button, voice indicator, settings modal, API key modal from HTML
  - Removed all voice-related CSS styles and CSS variables
  - Removed `v` keyboard shortcut for voice toggle
  - Simplified settings.ts (removed voice settings and updateVoiceSettings)
  - Removed transcript handling from server and responses

### Changed
- Migrated from `~/.pi/agent/tools/` to `~/.pi/agent/extensions/` folder structure (pi-mono v0.35.0)
- Updated to new extension API: `CustomToolFactory` -> `ExtensionAPI` with `pi.registerTool()`
- Options can now be strings OR objects with `{ label, code? }` structure

### Fixed
- Radio/checkbox alignment on multi-line option text (now aligns to top)
- `fileInput is not defined` error in keyboard handler
- `pi.cwd` changed to `ctx.cwd` in tool execute function
- **Paste handling**: Regular text no longer intercepted as image attachment; only paths ending with image extensions (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) are treated as attachments
- **Image limit enforcement**: `MAX_IMAGES` limit now consistently enforced for both question images and attachments (was only checking question images)

---

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

## 2026-01-01

### Added
- **Voice interview mode**: Natural voice-based interviewing powered by ElevenLabs Conversational AI
  - Questions read aloud, answers captured via speech
  - Bidirectional sync: click/keyboard navigate to any question, AI adapts
  - Intelligent cycling through unanswered questions
  - Hybrid mode: type/click anytime during voice session
  - Visual indicators: voice-focus styling, status indicator with progress
  - Full transcript returned with responses
  - Activation via URL param (`?voice=true`), toggle button, or schema config
- Voice controller state machine with WebRTC connection management
- `window.__INTERVIEW_API__` bridge for cross-module communication
- `getAnsweredQuestionIds()` and `getAllUnanswered()` helper functions
- `focusQuestion()` now accepts `source` parameter ('user' | 'voice')
- Voice-specific CSS variables in all theme files
- ElevenLabs agent auto-creation from interview questions
- API key input UI with localStorage persistence

### Changed
- `InterviewServerOptions` extended with `voiceApiKey`
- `InterviewServerCallbacks.onSubmit` now accepts optional transcript
- `InterviewDetails` extended with `transcript` field
- `buildPayload()` includes transcript when voice mode used

---

## 2026-01-02

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
