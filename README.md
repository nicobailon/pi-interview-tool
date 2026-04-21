<p>
  <img src="https://raw.githubusercontent.com/nicobailon/pi-interview-tool/main/banner.png" alt="pi-interview" width="1100">
</p>

# Interview Tool

A custom tool for pi-agent that opens an interactive form to gather user responses to clarification questions. On macOS, uses [Glimpse](https://github.com/hazat/glimpse) to render in a native WKWebView window; falls back to a browser tab on other platforms.

https://github.com/user-attachments/assets/52285bd9-956e-4020-aca5-9fbd82916934

## Installation

```bash
pi install npm:pi-interview
```

Restart pi to load the extension.

**Requirements:**
- pi-agent v0.35.0 or later (extensions API)
- For native macOS window: `pi install npm:glimpseui` (optional, falls back to browser if not installed)

## Features

- **Question Types**: Single-select, multi-select, text input, image upload, and info panels
- **Rich Media**: Embed images, Chart.js charts, Mermaid diagrams, tables, and HTML in questions
- **Pre-selection**: Recommended options show a "Recommended" badge and are pre-checked on load
- **Conviction & Weight**: Control recommendation strength (`conviction`) and visual prominence (`weight`)
- **"Other" Option**: Single/multi select questions support custom text input
- **Per-Question Attachments**: Attach images to any question via button or drag & drop
- **Keyboard Navigation**: Full keyboard support with arrow keys, Tab, Enter
- **Auto-save**: Responses saved to localStorage, restored on reload
- **Session Timeout**: Configurable timeout with countdown badge, refreshes on activity
- **Multi-Agent Support**: Queue detection prevents focus stealing when multiple agents run interviews
- **Queue Toast Switcher**: Active interviews show a top-right toast with a dropdown to open queued sessions
- **Session Recovery**: Abandoned/timed-out interviews save questions for later retry
- **Save Snapshots**: Save interview state to HTML for later review or revival
- **Session Status Bar**: Shows project path, git branch, and session ID for identification
- **Image Support**: Drag & drop anywhere on question, file picker, or paste a path into the dedicated path field
- **Path Normalization**: Handles shell-escaped paths (`\ `) and macOS screenshot filenames (narrow no-break space before AM/PM)
- **Generate & Review Options**: Single/multi-select questions, including rich-option questions with inline content blocks, show "✦ Generate more" (appends new choices) and "↻ Review options" (reviews options and rewrites the question for clarity) buttons powered by an LLM
- **Ask About an Option**: Single/multi options, including rich options with inline content blocks, can open an inline assistant panel with prompt chips, freeform follow-up questions, provider/model overrides under Advanced, and actions like pinning analysis or applying a suggested rewrite
- **Option Clarifications**: Plain string single/multi options can reveal a separate inline `Optional clarification...` field when selected, letting users attach a short note to a choice without using `Ask`
- **Tool Discoverability (pi v0.59+)**: Registers a `promptSnippet` so `interview` remains eligible for inclusion in pi's default `Available tools` prompt section
- **Themes**: Built-in default + optional light/dark + custom theme CSS

## How It Works

```
┌─────────┐      ┌──────────────────────────────────────────┐      ┌─────────┐
│  Agent  │      │        Glimpse / Browser Form             │      │  Agent  │
│ invokes ├─────►│                                          ├─────►│receives │
│interview│      │  answer → answer → attach img → answer   │      │responses│
└─────────┘      │     ↑                                    │      └─────────┘
                 │     └── auto-save, timeout resets ───────┤
                 └──────────────────────────────────────────┘
```

**Lifecycle:**
1. Agent calls `interview()` → local server starts → Glimpse window opens (macOS) or browser tab (elsewhere)
2. User answers at their own pace; each change auto-saves and resets the timeout
3. Session ends via:
   - **Submit** (`⌘+Enter`) → responses returned to agent
   - **Timeout** → warning overlay, option to stay or close
   - **Escape × 2** → quick cancel
4. Window closes automatically; agent receives responses (or `null` if cancelled)

**Timeout behavior:** The countdown (visible in corner) resets on any activity - typing, clicking, or mouse movement. When it expires, an overlay appears giving the user a chance to continue. Progress is never lost thanks to localStorage auto-save.

**Multi-agent behavior:** When multiple agents run interviews simultaneously, only the first auto-opens the window. Subsequent interviews are queued and shown as a URL in the tool output, preventing focus stealing. When you submit the active interview, the window automatically redirects to the next queued interview. Active interviews also surface a top-right toast with a dropdown to open queued sessions. A session status bar at the top of each form shows the project path, git branch, and session ID for easy identification.

## Usage

The interview tool is invoked by pi-agent, not imported directly:

```javascript
// Create a questions JSON file, then call the tool
await interview({
  questions: '/path/to/questions.json',
  timeout: 600,  // optional, seconds (default: 600)
  verbose: false // optional, debug logging
});
```

## Question Schema

```json
{
  "title": "Project Setup",
  "description": "Review my suggestions and adjust as needed.",
  "questions": [
    {
      "id": "context",
      "type": "info",
      "question": "Architecture context",
      "context": "This project needs SSR and edge deployment support."
    },
    {
      "id": "framework",
      "type": "single",
      "question": "Which framework?",
      "options": ["React", "Vue", "Svelte"],
      "recommended": "React",
      "conviction": "strong",
      "weight": "critical"
    },
    {
      "id": "features",
      "type": "multi",
      "question": "Which features?",
      "context": "Select all that apply",
      "options": ["Auth", "Database", "API"],
      "recommended": ["Auth", "Database"]
    },
    {
      "id": "indent",
      "type": "single",
      "question": "Indent style?",
      "options": ["Tabs", "Spaces (2)", "Spaces (4)"],
      "recommended": "Spaces (2)",
      "weight": "minor"
    },
    {
      "id": "notes",
      "type": "text",
      "question": "Additional requirements?"
    },
    {
      "id": "mockup",
      "type": "image",
      "question": "Upload a design mockup"
    }
  ]
}
```

### Question Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `type` | string | `single`, `multi`, `text`, `image`, or `info` |
| `question` | string | Question text |
| `options` | string[] or object[] | Choices (required for single/multi). Can be strings or `{ label, content? }` objects |
| `recommended` | string or string[] | Shows "Recommended" badge and pre-selects option(s) |
| `conviction` | string | `"strong"` or `"slight"`. Slight opts out of pre-selection. Requires `recommended` |
| `weight` | string | `"critical"` (prominent card) or `"minor"` (compact card) |
| `context` | string | Help text shown below question |
| `content` | object | Content block displayed below question text (`lang: "md"|"markdown"` previews Markdown by default) |
| `media` | object or object[] | Media content: image, chart, mermaid, table, or html |

### Content Blocks

Questions and options can include `content` blocks for code snippets, diffs, and Markdown.

**Question-level code content** (displayed above options):
```json
{
  "id": "review",
  "type": "single",
  "question": "Review this implementation",
  "content": {
    "source": "function add(a, b) {\n  return a + b;\n}",
    "lang": "ts",
    "file": "src/math.ts",
    "lines": "10-12",
    "highlights": [2]
  },
  "options": ["Approve", "Request changes"]
}
```

**Options with content blocks**:
```json
{
  "options": [
    {
      "label": "Use async/await",
      "content": { "source": "const data = await fetch(url);", "lang": "ts" }
    },
    {
      "label": "Use promises",
      "content": { "source": "fetch(url).then(data => ...);", "lang": "ts" }
    },
    "Keep current implementation"
  ]
}
```

**Diff display** (`lang: "diff"`):
```json
{
  "content": {
    "source": "--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,4 @@\n const x = 1;\n+const y = 2;\n const z = 3;",
    "lang": "diff",
    "file": "src/file.ts"
  }
}
```

**Markdown preview by default** (`lang: "md"` or `"markdown"`):
```json
{
  "content": {
    "source": "# Release notes\n\n- Added preview mode\n- Fixed wrapping",
    "lang": "md"
  }
}
```

Set `showSource: true` on Markdown content to show raw Markdown instead of preview.

| Content Field | Type | Description |
|---------------|------|-------------|
| `source` | string | Content text (required) |
| `lang` | string | Language hint (e.g., `ts`, `diff`, `md`) |
| `file` | string | File path shown in the header |
| `lines` | string | Line range shown in the header (code content only) |
| `highlights` | number[] | Line highlights (code content only) |
| `title` | string | Optional title above content |
| `showSource` | boolean | Markdown only: `true` forces raw source instead of preview |

Rules:
- `lang: "md"` or `"markdown"`: preview by default, `showSource: true` shows raw source.
- Any other `lang`: renders as raw source; `showSource` is not allowed.

### Info Panels

Use `type: "info"` for non-interactive context panels. They display a title, context text, and optional media but have no input — they're skipped during keyboard navigation and excluded from responses.

```json
{
  "id": "overview",
  "type": "info",
  "question": "Architecture Overview",
  "context": "The system uses a microservices architecture with three main services.",
  "media": { "type": "mermaid", "mermaid": "graph LR\n  A[API] --> B[Auth]\n  A --> C[Data]" }
}
```

### Media Blocks

Questions can embed media via the `media` field (single object or array). Supported types:

| Type | Fields | Description |
|------|--------|-------------|
| `image` | `src`, `alt?`, `caption?` | Image (local path, URL, or data URI) |
| `table` | `table: { headers, rows, highlights? }`, `caption?` | Data table with optional row highlighting |
| `chart` | `chart: { type, data, options? }`, `caption?` | Chart.js chart (bar, line, pie, etc.) |
| `mermaid` | `mermaid: "graph LR\n..."`, `caption?` | Mermaid diagram |
| `html` | `html: "<div>...</div>"`, `caption?` | Raw HTML content |

All media types support `position`: `"above"` (default), `"below"`, or `"side"` (two-column layout).

```json
{
  "id": "db-choice",
  "type": "single",
  "question": "Which database?",
  "media": {
    "type": "table",
    "table": {
      "headers": ["Database", "Latency", "Cost"],
      "rows": [["PostgreSQL", "~5ms", "$50/mo"], ["DynamoDB", "~2ms", "$80/mo"]],
      "highlights": [0]
    },
    "caption": "Benchmark results from staging"
  },
  "options": ["PostgreSQL", "DynamoDB"],
  "recommended": "PostgreSQL"
}
```

### Conviction & Weight

**Conviction** controls how strongly a recommendation is presented:
- Omitted (default): shows "Recommended" badge, pre-selects the option
- `"strong"`: same as default (use when very confident)
- `"slight"`: shows "Recommended" badge but does NOT pre-select (use when unsure)

**Weight** controls visual prominence:
- `"critical"`: thick accent border, tinted background — for decisions that matter most
- `"minor"`: compact card with smaller text and padding — for low-stakes preferences

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `↑` `↓` | Navigate options |
| `←` `→` | Navigate between questions |
| `Tab` | Cycle through options |
| `Enter` / `Space` | Select option |
| `⌘+V` | Paste image or file path |
| `⌘+Enter` | Submit form |
| `Esc` | Show exit overlay (press twice to quit) |
| `⌘+Shift+L` | Toggle theme (if enabled; appears in shortcuts bar) |

## Configuration

Settings in `~/.pi/agent/settings.json`:

```json
{
  "interview": {
    "timeout": 600,
    "port": 19847,
    "snapshotDir": "~/.pi/interview-snapshots/",
    "autoSaveOnSubmit": true,
    "generateModel": "anthropic/claude-haiku-4-5",
    "theme": {
      "mode": "auto",
      "name": "default",
      "lightPath": "/path/to/light.css",
      "darkPath": "/path/to/dark.css",
      "toggleHotkey": "mod+shift+l"
    }
  }
}
```

**Timeout precedence**: params > settings > default (600s)

**Snapshot settings:**
- `snapshotDir`: Directory for saved interview snapshots (default: `~/.pi/interview-snapshots/`)
- `autoSaveOnSubmit`: Automatically save snapshot on successful submit (default: `true`)

**Port setting**: Set a fixed `port` (e.g., `19847`) to use a consistent port across sessions.

**Generate model**: `generateModel` sets the model for the generate/review option actions (e.g., `"anthropic/claude-haiku-4-5"`). Defaults to the agent's current model, then falls back to a cheap available model. If an explicitly configured generate model fails at request time and the current session is using a different model, interview retries once with the current session model.

**Theme notes:**
- `mode`: `dark` (default), `light`, or `auto` (follows OS unless overridden)
- `name`: built-in themes are `default` and `tufte`
- `lightPath` / `darkPath`: optional CSS file paths (absolute or relative to cwd)
- `toggleHotkey`: optional; when set, toggles light/dark and persists per browser profile

## Theming

The interview form supports light/dark themes with automatic OS detection and user override.

### Built-in Themes

| Theme | Description |
|-------|-------------|
| `default` | Monospace, IDE-inspired aesthetic |
| `tufte` | Serif fonts (Instrument Serif), book-like feel |

### Theme Modes

- **`dark`** (default): Dark background, light text
- **`light`**: Light background, dark text  
- **`auto`**: Follows OS preference, user can toggle and override persists in localStorage

### Custom Themes

Create custom CSS files that override the default variables:

```css
:root {
  --bg-body: #f8f8f8;
  --bg-card: #ffffff;
  --bg-elevated: #f0f0f0;
  --bg-selected: #d0d0e0;
  --bg-hover: #e8e8e8;
  --fg: #1a1a1a;
  --fg-muted: #6c6c6c;
  --fg-dim: #8a8a8a;
  --accent: #5f8787;
  --accent-hover: #4a7272;
  --accent-muted: rgba(95, 135, 135, 0.15);
  --border: #5f87af;
  --border-muted: #b0b0b0;
  --border-focus: #8a8a9a;
  --border-active: #9090a0;
  --success: #87af87;
  --warning: #d7af5f;
  --error: #af5f5f;
  --focus-ring: rgba(95, 135, 175, 0.2);
}
```

Then reference in settings or params:

```json
{
  "interview": {
    "theme": {
      "mode": "auto",
      "lightPath": "~/my-themes/light.css",
      "darkPath": "~/my-themes/dark.css",
      "toggleHotkey": "mod+shift+l"
    }
  }
}
```

### Toggle Hotkey

When `toggleHotkey` is set (e.g., `"mod+shift+l"`), users can switch between light/dark modes. The preference persists in the browser's localStorage across sessions.

## Response Format

```typescript
interface Response {
  id: string;
  value: string | string[];
  attachments?: string[];  // image paths attached to non-image questions
}
```

Example:
```
- framework: React [attachments: /path/to/diagram.png]
- features: Auth, Database
- notes: Need SSO support
- mockup: /tmp/uploaded-image.png
```

## File Structure

```
interview/
├── index.ts       # Tool entry point, parameter schema
├── settings.ts    # Shared settings module
├── server.ts      # HTTP server, request handling
├── schema.ts      # TypeScript interfaces for questions/responses
└── form/
    ├── index.html # Form template
    ├── styles.css # Base styles (dark tokens)
    ├── themes/    # Theme overrides (light/dark)
    └── script.js  # Form logic, keyboard nav, image handling
```

## Session Recovery

If an interview times out or is abandoned (tab closed, lost connection), the questions are automatically saved to `~/.pi/interview-recovery/` for later retry.

**Recovery files:**
- Location: `~/.pi/interview-recovery/`
- Format: `{date}_{time}_{project}_{branch}_{sessionId}.json`
- Example: `2026-01-02_093000_myproject_main_65bec3f4.json`
- Auto-cleanup: Files older than 7 days are deleted

**To retry an abandoned interview:**
```javascript
interview({ questions: "~/.pi/interview-recovery/2026-01-02_093000_myproject_main_65bec3f4.json" })
```

## Saving Interviews

Save a snapshot of your interview at any time for later review or to resume.

**Manual Save:**
- Click the Save button (header or footer)
- Saves to `~/.pi/interview-snapshots/` by default
- Creates folder with `index.html` + `images/` subfolder

**Auto-save on Submit:**
- Enabled by default (`autoSaveOnSubmit: true` in settings)
- Automatically saves after successful submission
- Folder name includes `-submitted` suffix

**Reviving a Saved Interview:**
```javascript
interview({ questions: "~/.pi/interview-snapshots/project-setup-myapp-main-2026-01-20-141523/index.html" })
```
The form opens with answers pre-populated. Edit and submit as normal.

**Configuration:**
```json
{
  "interview": {
    "snapshotDir": "~/.pi/interview-snapshots/",
    "autoSaveOnSubmit": true
  }
}
```

**Snapshot Structure:**
```
~/.pi/interview-snapshots/
  {title}-{project}-{branch}-{timestamp}[-submitted]/
    index.html          # Human-readable + embedded JSON for revival
    images/
      mockup.png        # Uploaded images (relative paths in HTML)
```

## Limits

- Max 12 images total per submission
- Max 5MB per image
- Max 4096x4096 pixels per image
- Allowed types: PNG, JPG, GIF, WebP
