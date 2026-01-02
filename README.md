# Interview Tool

A custom tool for pi-agent that opens a web-based form to gather user responses to clarification questions.

## Features

- **Question Types**: Single-select, multi-select, text input, and image upload
- **Keyboard Navigation**: Full keyboard support with arrow keys, Tab, Enter
- **Auto-save**: Responses saved to localStorage, restored on reload
- **Session Timeout**: Configurable timeout with countdown badge, refreshes on user activity
- **Image Support**: File upload (drag-and-drop) or paste paths/URLs as tags
- **Responsive**: Mobile-friendly layout
- **Dark Theme**: Aligned with pi-mono dark theme colors

## Usage

```typescript
import { interview } from './interview';

const result = await interview({
  questions: '/path/to/questions.json',
  timeout: 300,  // optional, seconds (default: 300)
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
      "recommended": ["React"]
    },
    {
      "id": "features",
      "type": "multi",
      "question": "Which features?",
      "description": "Select all that apply",
      "options": ["Auth", "Database", "API"],
      "recommended": ["Database"]
    },
    {
      "id": "notes",
      "type": "text",
      "question": "Additional requirements?"
    },
    {
      "id": "mockup",
      "type": "image",
      "question": "Upload a design mockup",
      "description": "PNG, JPG, GIF, or WebP. Max 5MB."
    }
  ]
}
```

## Keyboard Shortcuts

### Form Navigation
| Key | Action |
|-----|--------|
| `↑` `↓` | Navigate options within question |
| `←` `→` | Navigate between questions |
| `Tab` | Cycle through options |
| `Enter` | Select option / advance |
| `⌘/Ctrl+Enter` | Submit form |
| `Esc` | Show exit overlay |

### Session Overlay
| Key | Action |
|-----|--------|
| `Tab` | Switch between Stay/Close |
| `Enter` | Confirm focused button |
| `Esc` | Close immediately |

## Configuration

Settings can be configured in `~/.pi/agent/settings.json`:

```json
{
  "interview": {
    "timeout": 300
  }
}
```

Timeout precedence: params > settings > default (300s)

## File Structure

```
interview/
├── index.ts          # Tool definition and entry point
├── server.ts         # HTTP server for form
├── schema.ts         # Zod schemas for validation
├── form/
│   ├── index.html    # Form template
│   ├── styles.css    # Dark theme styles
│   └── script.js     # Form logic and keyboard handling
├── example-questions.json
└── README.md
```

## Response Format

The tool returns responses as an array:

```typescript
{
  status: 'success' | 'cancelled' | 'timeout',
  responses: [
    { id: 'framework', value: 'React' },
    { id: 'features', value: ['Auth', 'Database'] },
    { id: 'notes', value: 'Some text...' },
    { id: 'mockup', value: ['path/to/image.png'], type: 'paths' }
  ],
  images: [
    { id: 'mockup', filename: 'upload.png', data: 'base64...' }
  ]
}
```
