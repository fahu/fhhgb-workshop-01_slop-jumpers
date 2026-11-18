// Public name-frequency data from the U.S. Social Security Administration and Census Bureau.
// Combining names creates fictional aliases, not records of actual individuals.
import names from '../../../shared/fake-names.json' with { type: 'json' };
const { givenNames, familyNames } = names;

/** Pick from 10,000 combinations without repeating an alias within a batch. */
export function fakeNames(count: number): string[] {
  const pool = givenNames.flatMap(first => familyNames.map(last => `${first} ${last}`));
  if (!Number.isInteger(count) || count < 0 || count > pool.length) {
    throw new Error('Choose between 0 and 10,000 names.');
  }
  for (let i = 0; i < count; i++) {
    const selected = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[selected]] = [pool[selected], pool[i]];
  }
  return pool.slice(0, count);
}
