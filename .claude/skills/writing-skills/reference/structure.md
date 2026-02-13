# Skill Structure Reference

## Directory Location

Skills live in `.claude/skills/` directories:
- **Project skills**: `.claude/skills/skill-name/SKILL.md` (shared via git)
- **User skills**: `~/.claude/skills/skill-name/SKILL.md` (personal, all projects)

## YAML Frontmatter Requirements

Every SKILL.md must start with YAML frontmatter:

```yaml
---
name: your-skill-name
description: Brief description of what this Skill does and when to use it.
---
```

### `name` Field

| Requirement | Detail |
|-------------|--------|
| Max length | 64 characters |
| Allowed chars | Lowercase letters, numbers, hyphens |
| Forbidden | XML tags, spaces, underscores |
| Reserved words | Cannot contain "anthropic" or "claude" |

**Good names:**
- `processing-pdfs`
- `analyzing-spreadsheets`
- `git-commit-helper`
- `api-testing`

**Bad names:**
- `PDF_Helper` (uppercase, underscore)
- `claude-assistant` (reserved word)
- `my cool skill` (spaces)
- `utils` (too vague)

### `description` Field

| Requirement | Detail |
|-------------|--------|
| Max length | 1024 characters |
| Min length | Non-empty |
| Forbidden | XML tags |
| Point of view | Third person only |

## File Organization Patterns

### Simple Skill (single file)

```
.claude/skills/commit-helper/
└── SKILL.md
```

Use when content fits under 500 lines.

### Multi-File Skill

```
.claude/skills/pdf-processing/
├── SKILL.md              # Main instructions (loaded when triggered)
├── FORMS.md              # Form-filling guide (loaded as needed)
├── REFERENCE.md          # API reference (loaded as needed)
└── scripts/
    └── validate.py       # Utility script (executed, not read)
```

Use when:
- Content exceeds 500 lines
- Multiple distinct workflows exist
- Reference material is extensive

### Domain-Organized Skill

```
.claude/skills/data-analysis/
├── SKILL.md
└── reference/
    ├── finance.md
    ├── sales.md
    └── product.md
```

Use when skill covers multiple domains that are accessed independently.
