# Skill Patterns

## Template Pattern

Provide output structure when format consistency matters.

### Strict Template (API responses, data formats)

````markdown
## Report structure

ALWAYS use this exact template:

```markdown
# [Analysis Title]

## Executive summary
[One-paragraph overview]

## Key findings
- Finding 1 with data
- Finding 2 with data

## Recommendations
1. Specific action
2. Specific action
```
````

### Flexible Template (when adaptation is useful)

````markdown
## Report structure

Sensible default format - adapt based on analysis:

```markdown
# [Analysis Title]

## Executive summary
[Overview]

## Key findings
[Adapt sections to discoveries]

## Recommendations
[Tailor to context]
```
````

## Examples Pattern

Show input/output pairs when output quality depends on seeing examples:

````markdown
## Commit message format

**Example 1:**
Input: Added user authentication with JWT tokens
Output:
```
feat(auth): implement JWT-based authentication

Add login endpoint and token validation middleware
```

**Example 2:**
Input: Fixed bug where dates displayed incorrectly
Output:
```
fix(reports): correct date formatting in timezone conversion

Use UTC timestamps consistently across report generation
```

Follow this style: type(scope): brief description, then details.
````

## Workflow Pattern

For complex multi-step tasks, provide checklist:

````markdown
## Research synthesis workflow

Copy and track progress:

```
- [ ] Step 1: Read all source documents
- [ ] Step 2: Identify key themes
- [ ] Step 3: Cross-reference claims
- [ ] Step 4: Create structured summary
- [ ] Step 5: Verify citations
```

**Step 1: Read all source documents**
Review each document. Note main arguments and evidence.

**Step 2: Identify key themes**
Look for patterns. What themes repeat? Where do sources agree/disagree?

[... continue for each step]
````

## Conditional Workflow Pattern

Guide through decision points:

```markdown
## Document modification workflow

1. Determine the modification type:

   **Creating new content?** → Follow "Creation workflow"
   **Editing existing content?** → Follow "Editing workflow"

2. Creation workflow:
   - Use docx-js library
   - Build document from scratch
   - Export to .docx format

3. Editing workflow:
   - Unpack existing document
   - Modify XML directly
   - Validate after each change
```

## Feedback Loop Pattern

For quality-critical output:

```markdown
## Content review process

1. Draft content following STYLE_GUIDE.md
2. Review against checklist:
   - Terminology consistency
   - Example format
   - Required sections present
3. If issues found:
   - Note each with section reference
   - Revise content
   - Review again
4. Only proceed when all requirements met
```

## Reference Pattern

Point to detailed materials without loading them:

````markdown
## PDF Processing

### Quick start

Extract text with pdfplumber:
```python
import pdfplumber
with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```

### Advanced features

**Form filling**: See [FORMS.md](FORMS.md)
**API reference**: See [REFERENCE.md](REFERENCE.md)
**Examples**: See [EXAMPLES.md](EXAMPLES.md)
````

Claude loads referenced files only when needed.
