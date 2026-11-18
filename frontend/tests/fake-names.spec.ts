import { test, expect } from '@playwright/test';
import { fakeNames } from '../src/workshop/fake-names';

test('the bundled pool contains 10,000 distinct realistic aliases accepted by the game', () => {
  const names = fakeNames(10000);
  expect(new Set(names).size).toBe(10000);
  expect(names.every(name => name.length <= 20 && /^[A-Za-z]+ [A-Za-z]+$/.test(name))).toBe(true);
  expect(names).toContain('Mary Smith');
  expect(names).toContain('Michael Johnson');
  const batch = fakeNames(1000);
  expect(batch).toHaveLength(1000);
  expect(new Set(batch).size).toBe(1000);
  expect(new Set(batch)).not.toEqual(new Set(fakeNames(1000)));
});
