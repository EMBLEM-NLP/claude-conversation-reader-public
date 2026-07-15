import { describe, it, expect } from 'vitest';
import { extractTitle } from '../src/importers/conversation-renamer.js';

describe('extractTitle', () => {
  it('returns null for empty input', () => {
    expect(extractTitle('')).toBeNull();
  });

  it('returns null for very short text', () => {
    expect(extractTitle('Hi')).toBeNull();
  });

  it('strips fenced code blocks', () => {
    const result = extractTitle('```js\nconsole.log("test")\n```\nThis is the real content.');
    // Code block replaced with space; remainder is the sentence
    expect(result).toBeTruthy();
    expect(result).not.toContain('console.log');
    expect(result).toContain('This is the real content');
  });

  it('strips inline code', () => {
    const result = extractTitle('Use `npm install` to install dependencies in your project.');
    expect(result).not.toContain('`');
  });

  it('strips markdown header markers', () => {
    // Note: ## text is stripped but the line is NOT treated as a sentence boundary —
    // whitespace collapse joins it with the next line. The title includes the header text.
    const result = extractTitle('## Section Title\nSome actual content here.');
    expect(result).toBeTruthy();
    expect(result).not.toContain('##');
    expect(result).toContain('Section Title');
  });

  it('strips bold markers', () => {
    const result = extractTitle('**Bold text** in the sentence for context.');
    expect(result).not.toContain('**');
  });

  it('truncates long text at 80 chars with ellipsis', () => {
    const long = 'This is a very long sentence that definitely exceeds eighty characters in length for testing.';
    const result = extractTitle(long);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(82); // 80 + ellipsis char
    expect(result).toMatch(/…$/);
  });

  it('capitalizes first letter', () => {
    const result = extractTitle('hello world sentence that is long enough.');
    expect(result!.charAt(0)).toBe('H');
  });

  it('skips boilerplate when skipBoilerplate=true', () => {
    const text = "Sure, I'd be happy to help you with that. The actual answer is here.";
    const result = extractTitle(text, { skipBoilerplate: true });
    // extractTitle splits on '.' so trailing period is stripped from each sentence
    expect(result).toBe('The actual answer is here');
  });

  it('returns first sentence of reasonable length', () => {
    const text = 'TypeScript generics allow you to write reusable code. More stuff follows.';
    const result = extractTitle(text);
    expect(result).toBe('TypeScript generics allow you to write reusable code');
  });
});
