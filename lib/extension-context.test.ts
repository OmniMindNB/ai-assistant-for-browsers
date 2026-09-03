import { describe, expect, it } from 'vitest';
import { isExtensionContextInvalidatedError } from './extension-context';

describe('isExtensionContextInvalidatedError', () => {
  it('recognizes the exact message Chrome throws after the extension is reloaded', () => {
    expect(isExtensionContextInvalidatedError(new Error('Extension context invalidated.'))).toBe(
      true,
    );
  });

  it('recognizes the message when it is wrapped in a longer sentence', () => {
    expect(
      isExtensionContextInvalidatedError(
        new Error('Uncaught (in promise) Error: Extension context invalidated.'),
      ),
    ).toBe(true);
  });

  it('recognizes a non-Error rejection carrying the same message', () => {
    expect(isExtensionContextInvalidatedError('Extension context invalidated.')).toBe(true);
  });

  it('does not mistake the missing-receiver error for an invalidated context', () => {
    expect(
      isExtensionContextInvalidatedError(
        new Error('Could not establish connection. Receiving end does not exist.'),
      ),
    ).toBe(false);
  });

  it('does not match unrelated failures', () => {
    expect(isExtensionContextInvalidatedError(new Error('network error'))).toBe(false);
    expect(isExtensionContextInvalidatedError(undefined)).toBe(false);
    expect(isExtensionContextInvalidatedError(null)).toBe(false);
  });
});
