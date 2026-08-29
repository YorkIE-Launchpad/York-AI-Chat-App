import { describe, expect, it } from 'vitest';
import {
  extractHubProfileFields,
  mergeHubProfileFields,
} from '../../main/welcome/extract-hub-profile';
import { formatWelcomeProfileSummary } from '../../shared/welcome-actions';

describe('extractHubProfileFields', () => {
  it('reads designation / function / squad from nested employeeData', () => {
    const fields = extractHubProfileFields({
      data: {
        employeeData: {
          first_name: 'Ada',
          last_name: 'Lovelace',
          email: 'ada@york.ie',
          designation: 'Engineering Manager',
          function: { name: 'Engineering' },
          squad: 'Platform',
          department: 'Product',
        },
      },
    });

    expect(fields).toEqual({
      title: 'Engineering Manager',
      functionName: 'Engineering',
      squad: 'Platform',
      department: 'Product',
      name: 'Ada Lovelace',
      email: 'ada@york.ie',
    });
  });

  it('merges preferring next non-null fields', () => {
    const merged = mergeHubProfileFields(
      { title: 'IC', functionName: null },
      { title: null, functionName: 'GTM', squad: 'Growth' }
    );
    expect(merged.title).toBe('IC');
    expect(merged.functionName).toBe('GTM');
    expect(merged.squad).toBe('Growth');
  });
});

describe('formatWelcomeProfileSummary', () => {
  it('joins known profile fields', () => {
    expect(
      formatWelcomeProfileSummary({
        email: 'ada@york.ie',
        name: 'Ada',
        title: 'EM',
        functionName: 'Engineering',
        squad: null,
        department: null,
      })
    ).toBe('Ada · ada@york.ie · EM · Engineering');
  });
});
