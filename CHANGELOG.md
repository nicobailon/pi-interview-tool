# Changelog

## Unreleased

### Added
- Per-question image attachments for non-image questions
  - Subtle "+ attach" button at bottom-right of each question
  - Press `a` key to toggle attach panel
  - Tab navigation within attach area, Esc to close
- Keyboard shortcuts bar showing all available shortcuts
- Session timeout with countdown badge and activity-based refresh
- Progress persistence via localStorage
- Image upload via drag-drop, file picker, or path/URL input

### Fixed
- Space/Enter in attach area no longer triggers option selection
- Duplicate response entries for image questions
- ArrowLeft/Right navigation in textarea and path inputs
- Focus management when closing attach panel
- Hover feedback and tick loop race conditions

### Changed
- MAX_IMAGES increased from 2 to 12
- Timeout default is 600 seconds (10 minutes)

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
