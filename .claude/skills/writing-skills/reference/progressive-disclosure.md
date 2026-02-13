# Progressive Disclosure

Skills use progressive disclosure to manage context efficiently:

| Level | When Loaded | Token Cost | Content |
|-------|------------|------------|---------|
| **Metadata** | Always (startup) | ~100 tokens | `name` and `description` from YAML |
| **SKILL.md** | When triggered | Under 5k tokens | Main instructions |
| **Reference files** | As needed | Unlimited | Bundled files, scripts |

## When to Split Files

### Keep in SKILL.md

- Core workflow (always needed)
- Quick start / common operations
- Navigation to reference files
- Key decision points

### Move to Reference Files

- Detailed API documentation
- Extensive examples
- Domain-specific schemas
- Advanced features most users won't need
- Historical / legacy information

## Rule of Thumb

**SKILL.md under 500 lines.** If approaching this limit, split content.

## File Organization Strategies

### By Feature

```
skill/
├── SKILL.md (overview + common ops)
├── FORMS.md (form filling)
├── TABLES.md (table extraction)
└── MERGE.md (document merging)
```

### By Domain

```
skill/
├── SKILL.md (overview + navigation)
└── reference/
    ├── finance.md
    ├── sales.md
    └── product.md
```

### By Complexity

```
skill/
├── SKILL.md (basic usage)
├── ADVANCED.md (power user features)
└── REFERENCE.md (complete API docs)
```

## Reference Depth Rule

**Keep references ONE level deep from SKILL.md.**

❌ Bad (too deep):
```
SKILL.md → advanced.md → details.md → actual-info.md
```

✅ Good (flat):
```
SKILL.md → advanced.md
SKILL.md → reference.md
SKILL.md → examples.md
```

Claude may partially read deeply nested files, resulting in incomplete information.

## Long File Strategy

For reference files over 100 lines, include table of contents:

```markdown
# API Reference

## Contents
- Authentication and setup
- Core methods (create, read, update, delete)
- Advanced features
- Error handling
- Code examples

## Authentication and setup
...
```

This ensures Claude sees full scope even when previewing.

## Token Efficiency Tips

1. **Scripts execute, don't load** - Utility scripts run via bash; only output consumes tokens
2. **Large datasets are free until read** - Bundle extensive reference material without penalty
3. **Images work** - Claude can analyze rendered images of layouts, forms, etc.
4. **Grep for discovery** - For large reference files, suggest grep to find relevant sections:

```markdown
## Quick search

Find specific metrics:
```bash
grep -i "revenue" reference/finance.md
grep -i "pipeline" reference/sales.md
```
```
