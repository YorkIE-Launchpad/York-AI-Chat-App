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
      introduction: null,
      name: 'Ada Lovelace',
      email: 'ada@york.ie',
    });
  });

  it('reads GET /api/auth/me designation, squad.function, and introduction', () => {
    const fields = extractHubProfileFields({
      first_name: 'Kalrav',
      last_name: 'Parsana',
      email: 'kalrav@york.ie',
      designation: { id: 'd1', name: 'Product Manager', level: 'L4' },
      squad: {
        id: 's1',
        name: 'Growth',
        function: { id: 'f1', name: 'GTM' },
      },
      guild: { id: 'g1', name: 'Builders' },
      introduction: 'Shipped pricing and onboarding.',
    });

    expect(fields).toEqual({
      title: 'Product Manager',
      functionName: 'GTM',
      squad: 'Growth',
      department: null,
      introduction: 'Shipped pricing and onboarding.',
      name: 'Kalrav Parsana',
      email: 'kalrav@york.ie',
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
