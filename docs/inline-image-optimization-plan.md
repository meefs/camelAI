# Inline Image Optimization Plan

## Goal

Simplify and harden inline image reads for Pi tool results by leaning on the Cloudflare Images binding for resizing/compression while avoiding extra original-image inspection or Worker-side decoding.

## Scope

Implement the remaining low-risk improvements discussed for PR #811, excluding WebP output normalization.

## Planned Improvements

1. **Disable animated output for inline reads**
   - Set Cloudflare Images output `anim: false` for inline image reads.
   - Rationale: agent context needs a visual preview, not animation frames. Cloudflare recommends disabling animation for arbitrary user-uploaded content to reduce output size.

2. **Bound transformed base64 reads**
   - Stop reading the transformed base64 stream once it exceeds the inline image cap.
   - Rationale: even after Images optimization, outputs can still be too large. Cancelling early protects Worker memory instead of accumulating an oversized base64 string before rejecting it.

3. **Clarify optimized image note**
   - Update tool-result text to say inline images may be scaled/compressed from the source.
   - Rationale: the tool intentionally returns an optimized model-context representation, not source-identical bytes or dimensions.

## Explicit Non-goal

- Do not normalize all outputs to WebP in this pass. Keep the existing output format selection behavior.

## Verification

- Run focused Worker tests covering R2 and project-VM image reads.
- Run typecheck.
