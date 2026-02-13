# Writing Effective Descriptions

The description field is critical for skill discovery. Claude uses it to decide which skill to invoke from potentially 100+ available skills.

## Formula

```
[What it does] + [When to use it / trigger keywords]
```

## Rules

1. **Always third person** - "Processes files", not "I process files" or "You can use this to process files"
2. **Be specific** - Include keywords users would say
3. **Include triggers** - When should Claude activate this skill?

## Examples

### Good Descriptions

**PDF Processing:**
```yaml
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
```

**Excel Analysis:**
```yaml
description: Analyze Excel spreadsheets, create pivot tables, generate charts. Use when analyzing Excel files, spreadsheets, tabular data, or .xlsx files.
```

**Git Commit Helper:**
```yaml
description: Generate descriptive commit messages by analyzing git diffs. Use when the user asks for help writing commit messages or reviewing staged changes.
```

**Code Review:**
```yaml
description: Reviews code for bugs, security issues, and style. Use when asked to review, audit, or critique code changes.
```

### Bad Descriptions

```yaml
# Too vague - won't trigger correctly
description: Helps with documents

# No trigger context
description: Processes data

# First person - causes discovery problems
description: I can help you process Excel files

# Second person - also problematic
description: You can use this to process Excel files
```

## Trigger Keywords Strategy

Think about what words users say when they need this skill:

| Skill Type | Trigger Words to Include |
|------------|-------------------------|
| File processing | file type (.pdf, .xlsx), "extract", "convert", "parse" |
| Code tasks | "review", "refactor", "test", "debug", language names |
| Writing | "draft", "write", "document", content type names |
| Analysis | "analyze", "report", "summarize", domain terms |

## Testing Your Description

Ask: If a user said "[request]", would Claude know to use this skill?

Example test for a PDF skill:
- "Extract text from this PDF" → Should trigger
- "Fill out this form" → Should trigger
- "Merge these documents" → Should trigger
- "Read this spreadsheet" → Should NOT trigger (different skill)
