import { describe, expect, it } from 'vitest';
import {
  buildSlugMap,
  expandMentions,
  parseMentions,
  rankMentionableConnections,
  slug,
  slugForIntegration,
  stripMentionAnnotationsWithMetadata,
  type MentionableIntegration,
} from '@/lib/connection-mentions';

function fix(
  fields: Partial<MentionableIntegration> & { id: string; name: string },
): MentionableIntegration {
  return {
    integration_type: 'postgres',
    created_at: 0,
    ...fields,
  };
}

describe('slug', () => {
  it('lowercases and replaces non-alphanumerics with underscores', () => {
    expect(slug('My Prod DB')).toBe('my_prod_db');
    expect(slug('Stripe (Live)')).toBe('stripe_live');
    expect(slug('  trim  ')).toBe('trim');
    expect(slug('123 Main')).toBe('123_main');
  });

  it('returns an empty string for non-alphanumeric-only input', () => {
    expect(slug('!!!')).toBe('');
    expect(slug('')).toBe('');
  });
});

describe('buildSlugMap', () => {
  it('assigns the base slug to a single integration', () => {
    const map = buildSlugMap([fix({ id: '1', name: 'My Prod DB' })]);
    expect([...map.keys()]).toEqual(['my_prod_db']);
  });

  it('disambiguates collisions deterministically by created_at', () => {
    const map = buildSlugMap([
      fix({ id: 'b', name: 'Prod', created_at: 200 }),
      fix({ id: 'a', name: 'Prod', created_at: 100 }),
      fix({ id: 'c', name: 'Prod', created_at: 300 }),
    ]);
    expect(map.get('prod')?.id).toBe('a');
    expect(map.get('prod-2')?.id).toBe('b');
    expect(map.get('prod-3')?.id).toBe('c');
  });

  it('skips integrations whose name slugs to empty', () => {
    const map = buildSlugMap([fix({ id: '1', name: '!!!' })]);
    expect(map.size).toBe(0);
  });
});

describe('slugForIntegration', () => {
  it('returns the slug an integration was assigned in the map', () => {
    const a = fix({ id: 'a', name: 'Prod', created_at: 1 });
    const b = fix({ id: 'b', name: 'Prod', created_at: 2 });
    const map = buildSlugMap([a, b]);
    expect(slugForIntegration(a, map)).toBe('prod');
    expect(slugForIntegration(b, map)).toBe('prod-2');
  });
});

describe('rankMentionableConnections', () => {
  const integrations = [
    fix({ id: 'stripe', name: 'Stripe Live', integration_type: 'stripe' }),
    fix({ id: 'sales', name: 'Sales DB', integration_type: 'postgres' }),
    fix({ id: 'post', name: 'Post Analytics', integration_type: 'stripe' }),
    fix({ id: 'inventory', name: 'Inventory DB', integration_type: 'postgres' }),
  ];

  it('sorts alphabetically for an empty query', () => {
    expect(rankMentionableConnections(integrations, '').map((item) => item.id))
      .toEqual(['inventory', 'post', 'sales', 'stripe']);
  });

  it('ranks name prefixes before integration type/display name prefixes', () => {
    expect(rankMentionableConnections(integrations, 'post').map((item) => item.id))
      .toEqual(['post', 'inventory', 'sales']);
  });

  it('matches registry display names', () => {
    expect(rankMentionableConnections(integrations, 'postgresql').map((item) => item.id))
      .toEqual(['inventory', 'sales']);
  });
});

describe('parseMentions', () => {
  const map = buildSlugMap([
    fix({ id: '1', name: 'My DB' }),
    fix({ id: '2', name: 'Stripe' }),
  ]);

  it('matches @<slug> at start of input', () => {
    const matches = parseMentions('@my_db hello', map);
    expect(matches.map((m) => m.slug)).toEqual(['my_db']);
    expect(matches[0]!.integration?.id).toBe('1');
  });

  it('matches @<slug> after whitespace and newlines', () => {
    expect(parseMentions('hi @stripe', map).map((m) => m.slug)).toEqual(['stripe']);
    expect(parseMentions('hi\n@stripe', map).map((m) => m.slug)).toEqual(['stripe']);
  });

  it('does not match mid-word @ (email-like)', () => {
    expect(parseMentions('email@example.com', map)).toEqual([]);
    expect(parseMentions('foo@bar', map)).toEqual([]);
  });

  it('returns unmatched slugs with integration=null', () => {
    const matches = parseMentions('use @unknown_db', map);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.slug).toBe('unknown_db');
    expect(matches[0]!.integration).toBeNull();
  });

  it('returns multiple matches in order', () => {
    const matches = parseMentions('@my_db then @stripe', map);
    expect(matches.map((m) => m.slug)).toEqual(['my_db', 'stripe']);
    expect(matches.map((m) => m.index).every((i, k, arr) => k === 0 || i > arr[k - 1]!))
      .toBe(true);
  });
});

describe('expandMentions', () => {
  const integrations = [
    fix({ id: 'abc123', name: 'My Prod DB', integration_type: 'postgres' }),
    fix({ id: 'stripe1', name: 'Stripe Live', integration_type: 'stripe' }),
  ];
  const map = buildSlugMap(integrations);

  it('annotates known slugs with ⟦ref: …⟧', () => {
    const out = expandMentions('hi @my_prod_db', map);
    expect(out).toBe('hi @my_prod_db ⟦ref: postgres "My Prod DB" id=abc123⟧');
  });

  it('leaves unknown slugs unchanged', () => {
    expect(expandMentions('hi @ghost', map)).toBe('hi @ghost');
  });

  it('expands multiple matches without disturbing earlier indices', () => {
    const out = expandMentions('use @my_prod_db and @stripe_live now', map);
    expect(out).toBe(
      'use @my_prod_db ⟦ref: postgres "My Prod DB" id=abc123⟧ and @stripe_live ⟦ref: stripe "Stripe Live" id=stripe1⟧ now',
    );
  });

  it('does not annotate mid-word @ (email-like)', () => {
    expect(expandMentions('user@my_prod_db.example.com', map))
      .toBe('user@my_prod_db.example.com');
  });

  it('returns input unchanged for empty body or empty map', () => {
    expect(expandMentions('', map)).toBe('');
    expect(expandMentions('hi @x', new Map())).toBe('hi @x');
  });
});

describe('stripMentionAnnotationsWithMetadata', () => {
  it('strips annotations and remembers the annotated slug', () => {
    const result = stripMentionAnnotationsWithMetadata(
      'hi @my_prod_db ⟦ref: postgres "My Prod DB" id=abc123⟧ now',
    );

    expect(result.displayText).toBe('hi @my_prod_db now');
    expect(result.annotatedMentions).toEqual([
      { slug: 'my_prod_db', id: 'abc123' },
    ]);
  });

  it('does not mark random text before annotations as a mention slug', () => {
    const result = stripMentionAnnotationsWithMetadata(
      'hi my_prod_db ⟦ref: postgres "My Prod DB" id=abc123⟧ now',
    );

    expect(result.displayText).toBe('hi my_prod_db now');
    expect(result.annotatedMentions).toEqual([]);
  });

  it('uses null ids for malformed legacy annotations', () => {
    const result = stripMentionAnnotationsWithMetadata(
      'hi @my_prod_db ⟦ref: postgres "My Prod DB"⟧ now',
    );

    expect(result.displayText).toBe('hi @my_prod_db now');
    expect(result.annotatedMentions).toEqual([
      { slug: 'my_prod_db', id: null },
    ]);
  });
});
