---
name: testing-debugging
description: Debug issues and write tests for deployed applications. Use this skill when the user reports bugs, wants to add tests, or needs help troubleshooting. Covers unit testing for rapid iteration, browser console debugging, and systematic bug reproduction.
license: Complete terms in LICENSE.txt
---

# Testing and Debugging

This skill guides debugging deployed applications and writing tests for rapid iteration. The key insight: **unit tests are the fastest way to reproduce and fix bugs**.

## Bug Reports from the Preview Pane

Users can report bugs directly from the app preview. In the preview pane on the right side of the screen, there's a **toolbar above the preview** with a **bug icon**. Clicking this icon opens a bug report dialog where users can:

- Describe the issue they encountered
- Capture a screenshot of the current state
- Include console errors automatically

When a user submits a bug report, use it as a starting point for investigation.

## Capturing Bug Reports Programmatically

You can trigger a bug report capture using the `capture_bug_report` MCP tool. This captures the current state of the deployed app **automatically** without requiring user interaction. This is useful when:

- You want to see the current state of the deployed app
- You need to debug an issue and want to capture console logs and DOM state
- You want a screenshot of the app to verify visual changes

```bash
# Use the MCP tool to capture a bug report (happens automatically)
capture_bug_report(message: "Capturing the current state to debug the login issue")
```

The captured bug report includes:
- **Screenshot** - Visual capture of the current app state
- **DOM snapshot** - Complete HTML structure
- **Console logs** - All console.log, warn, and error messages
- **Network requests** - API calls and their responses
- **Session recording** - User interactions leading up to the capture

The tool returns paths to the captured files which you can read to investigate the issue.

## The Unit Test Debugging Workflow

**This is the most effective debugging workflow.** Instead of repeatedly deploying and manually testing in the browser, write a unit test that reproduces the bug:

### Why Unit Tests for Debugging?

| Approach | Cycle Time | Reliability |
|----------|------------|-------------|
| Deploy → Browser → Manual test | 30-60 seconds | Variable |
| Run unit test | 1-2 seconds | Consistent |

A 30x speedup means you can iterate 30 times faster. This compounds: what takes an hour with manual testing takes 2 minutes with unit tests.

### The Workflow

1. **Understand the bug** - Read the bug report, check console errors, understand expected vs actual behavior

2. **Write a failing test** - Create a test that reproduces the exact failure
   ```typescript
   // Example: User reports "discount not applied to cart total"
   test('applies discount code to cart total', () => {
     const cart = createCart([
       { name: 'Widget', price: 100 },
       { name: 'Gadget', price: 50 }
     ]);

     cart.applyDiscount('SAVE20'); // 20% off

     expect(cart.total).toBe(120); // Was returning 150
   });
   ```

3. **Run the test to confirm it fails** - Verify you've reproduced the bug
   ```bash
   bun test
   ```

4. **Fix the code** - Make changes to fix the failing test

5. **Run the test again** - Confirm the fix works
   ```bash
   bun test
   ```

6. **Deploy** - Once tests pass, deploy with confidence
   ```bash
   bun deploy
   ```

### Test File Location

Place test files next to the code they test:

```
src/
  cart.ts
  cart.test.ts      # Tests for cart.ts
  utils/
    discount.ts
    discount.test.ts
```

Or use a `__tests__` directory:

```
src/
  cart.ts
  __tests__/
    cart.test.ts
```

## Writing Effective Debug Tests

### Isolate the Problem

Test the smallest unit that could be failing:

```typescript
// Bad: Tests too much, hard to pinpoint failure
test('checkout flow works', async () => {
  await addToCart(item);
  await applyDiscount('CODE');
  await enterShipping(address);
  await processPayment(card);
  expect(order.status).toBe('complete');
});

// Good: Isolates the discount logic
test('applyDiscount calculates percentage correctly', () => {
  const subtotal = 100;
  const result = applyDiscount(subtotal, { type: 'percent', value: 20 });
  expect(result).toBe(80);
});
```

### Test Edge Cases

Bugs often hide in edge cases:

```typescript
test('handles empty cart', () => {
  const cart = createCart([]);
  expect(cart.total).toBe(0);
});

test('handles negative quantities', () => {
  const cart = createCart([{ name: 'Widget', price: 100, quantity: -1 }]);
  expect(cart.total).toBe(0); // Should not allow negative
});

test('handles very large numbers', () => {
  const cart = createCart([{ name: 'Widget', price: 999999.99, quantity: 1000 }]);
  expect(cart.total).toBeCloseTo(999999990); // Check for floating point issues
});
```

### Mock External Dependencies

Isolate your code from APIs and databases:

```typescript
import { vi } from 'vitest';

test('displays error when API fails', async () => {
  // Mock the fetch to simulate API failure
  vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

  const result = await loadUserData('user-123');

  expect(result.error).toBe('Failed to load user data');
});
```

## Browser Console Debugging

When you need to debug in the browser:

### Check Console Errors

Open browser DevTools (F12) and look for:
- Red error messages
- Failed network requests (Network tab)
- Uncaught exceptions

### Add Strategic Console Logs

```typescript
function calculateTotal(items: Item[], discount?: Discount) {
  console.log('calculateTotal called with:', { items, discount });

  const subtotal = items.reduce((sum, item) => {
    console.log('Processing item:', item, 'Running sum:', sum);
    return sum + item.price * item.quantity;
  }, 0);

  console.log('Subtotal:', subtotal);

  if (discount) {
    const discounted = applyDiscount(subtotal, discount);
    console.log('After discount:', discounted);
    return discounted;
  }

  return subtotal;
}
```

### Use Debugger Statement

Add `debugger;` to pause execution:

```typescript
function processOrder(order: Order) {
  debugger; // Browser will pause here when DevTools is open
  // ... rest of function
}
```

## Common Bug Patterns

### Off-by-One Errors

```typescript
// Bug: Loop skips last item
for (let i = 0; i < items.length - 1; i++) { ... }

// Fix: Include last item
for (let i = 0; i < items.length; i++) { ... }
```

### Async/Await Issues

```typescript
// Bug: Not awaiting async function
function loadData() {
  const data = fetchData(); // Returns Promise, not data!
  return processData(data);
}

// Fix: Await the promise
async function loadData() {
  const data = await fetchData();
  return processData(data);
}
```

### Type Coercion

```typescript
// Bug: String concatenation instead of addition
const total = price + tax; // "100" + "10" = "10010"

// Fix: Parse numbers
const total = Number(price) + Number(tax); // 110
```

### Null/Undefined Access

```typescript
// Bug: Accessing property on undefined
const name = user.profile.name; // Crashes if profile is undefined

// Fix: Optional chaining
const name = user?.profile?.name ?? 'Unknown';
```

## Test Commands

```bash
# Run all tests
bun test

# Run tests in watch mode (re-runs on file changes)
bun test --watch

# Run a specific test file
bun test src/cart.test.ts

# Run tests matching a pattern
bun test -t "discount"

# Run with coverage report
bun test --coverage
```

## Debugging Checklist

When investigating a bug:

1. [ ] Read the bug report carefully
2. [ ] Check browser console for errors
3. [ ] Identify the smallest reproducible case
4. [ ] Write a failing unit test
5. [ ] Fix the code
6. [ ] Verify test passes
7. [ ] Check for similar bugs elsewhere
8. [ ] Deploy and verify in production
