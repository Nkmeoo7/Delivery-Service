import { minimatch } from 'minimatch';

//now we check if event type matched with the filter.writtern the filter rules as well

export function matchPattern(eventType: string, filter: string,): boolean {
  if (filter === '*') return true;
  if (filter === eventType) return true;
  return minimatch(eventType, filter);
}

