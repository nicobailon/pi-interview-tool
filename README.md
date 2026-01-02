# Interview Tool

A custom tool for pi-agent that opens a web-based form to gather user responses to clarification questions.

## Features

- **Question Types**: Single-select, multi-select, text input, and image upload
- **Per-Question Attachments**: Attach images to any question via `a` key
- **Keyboard Navigation**: Full keyboard support with arrow keys, Tab, Enter
- **Auto-save**: Responses saved to localStorage, restored on reload
- **Session Timeout**: Configurable timeout with countdown badge, refreshes on activity
- **Image Support**: Drag-drop, file picker, or paste paths/URLs
- **Dark Theme**: IDE-inspired dark theme

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
| `A` | Toggle attach image panel |
| `⌘+Enter` | Submit form |
| `Esc` | Show exit overlay / close attach panel |

## Configuration

Settings in `~/.pi/agent/settings.json`:

```json
{
  "interview": {
    "timeout": 600
  }
}
```

Precedence: params > settings > default (600s)

## Response Format

```typescript
interface Response {
  id: string;
  value: string | string[];
  attachments?: string[];  // paths/URLs attached via 'a' key
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
├── index.ts       # Tool entry point
├── server.ts      # HTTP server
├── schema.ts      # TypeBox validation
└── form/
    ├── index.html
    ├── styles.css
    └── script.js
```

## Limits

- Max 12 images total per submission
- Max 5MB per image
- Max 4096x4096 pixels per image
- Allowed types: PNG, JPG, GIF, WebP
