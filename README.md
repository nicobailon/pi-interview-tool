# Interview Tool

A custom tool for pi-agent that opens a web-based form to gather user responses to clarification questions.

<video src="https://github.com/nicobailon/pi-interview-tool/raw/main/interview-tool-demo.mp4" controls width="100%"></video>

## Installation

Clone or copy this directory to your pi-agent tools folder:

```bash
# Clone to user tools directory (available in all projects)
git clone https://github.com/nicobailon/pi-interview-tool ~/.pi/agent/tools/interview

# Or copy manually
cp -r /path/to/interview ~/.pi/agent/tools/
```

The tool is automatically discovered on next pi session. No build step required.

**Requirements:**
- pi-agent v0.31.0 or later

## Features

- **Question Types**: Single-select, multi-select, text input, and image upload
- **Per-Question Attachments**: Attach images to any question via button, paste, or drag & drop
- **Keyboard Navigation**: Full keyboard support with arrow keys, Tab, Enter
- **Auto-save**: Responses saved to localStorage, restored on reload
- **Session Timeout**: Configurable timeout with countdown badge, refreshes on activity
- **Image Support**: Drag & drop anywhere on question, file picker, paste image or path
- **Path Normalization**: Handles shell-escaped paths (`\ `) and macOS screenshot filenames (narrow no-break space before AM/PM)
- **Themes**: Built-in default + optional light/dark + custom theme CSS

## How It Works

```
┌─────────┐      ┌──────────────────────────────────────────┐      ┌─────────┐
│  Agent  │      │              Browser Form                │      │  Agent  │
│ invokes ├─────►│                                          ├─────►│receives │
│interview│      │  answer → answer → attach img → answer   │      │responses│
└─────────┘      │     ↑                                    │      └─────────┘
                 │     └── auto-save, timeout resets ───────┤
                 └──────────────────────────────────────────┘
```

**Lifecycle:**
1. Agent calls `interview()` → local server starts → browser opens form
2. User answers at their own pace; each change auto-saves and resets the timeout
3. Session ends via:
   - **Submit** (`⌘+Enter`) → responses returned to agent
   - **Timeout** → warning overlay, option to stay or close
   - **Escape × 2** → quick cancel
4. Window closes automatically; agent receives responses (or `null` if cancelled)

**Timeout behavior:** The countdown (visible in corner) resets on any activity - typing, clicking, or mouse movement. When it expires, an overlay appears giving the user a chance to continue. Progress is never lost thanks to localStorage auto-save.

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
  "description": "Optional description text",
  "questions": [
    {
      "id": "framework",
      "type": "single",
      "question": "Which framework?",
      "options": ["React", "Vue", "Svelte"],
      "recommended": "React"
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
| `type` | string | `single`, `multi`, `text`, or `image` |
| `question` | string | Question text |
| `options` | string[] | Choices (required for single/multi) |
| `recommended` | string or string[] | Highlighted option(s) with `*` indicator |
| `context` | string | Help text shown below question |

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

Precedence: params > settings > default (600s)

Theme notes:
- `mode`: `dark` (default), `light`, or `auto` (follows OS unless overridden)
- `name`: built-in themes are `default` and `tufte`
- `lightPath` / `darkPath`: optional CSS file paths (absolute or relative to cwd)
- `toggleHotkey`: optional; when set, toggles light/dark and persists per browser profile

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
├── server.ts      # HTTP server, request handling
├── schema.ts      # TypeScript interfaces for questions/responses
└── form/
    ├── index.html # Form template
    ├── styles.css # Base styles (dark tokens)
    ├── themes/    # Theme overrides (light/dark)
    └── script.js  # Form logic, keyboard nav, image handling
```

## Limits

- Max 12 images total per submission
- Max 5MB per image
- Max 4096x4096 pixels per image
- Allowed types: PNG, JPG, GIF, WebP
