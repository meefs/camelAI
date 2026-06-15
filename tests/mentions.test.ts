import { describe, expect, it } from 'vitest';
import {
  buildSlugMap,
  expandMentions,
  filterMentionables,
  parseMentions,
  projectsToMentionables,
  rankMentionables,
  slug,
  slugForMentionable,
  stripMentionAnnotationsWithMetadata,
  type MentionableConnection,
  type MentionableProject,
} from '@/lib/mentions';

function fix(
  fields: Partial<MentionableConnection> & { id: string; name: string },
): MentionableConnection {
  return {
    kind: 'connection',
    integration_type: 'postgres',
    created_at: 0,
    ...fields,
  };
}

function project(
  fields: Partial<MentionableProject> & { id: string; name: string },
): MentionableProject {
  return {
    kind: 'project',
    description: 'Project description',
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

  it('preserves connection slugs when projects collide across kinds', () => {
    const connection = fix({ id: 'conn', name: 'Stripe', created_at: 2 });
    const projectItem = project({ id: 'proj', name: 'stripe', created_at: 1 });

    for (const input of [
      [connection, projectItem],
      [projectItem, connection],
    ]) {
      const map = buildSlugMap(input);
      expect(map.get('stripe')?.id).toBe('conn');
      expect(map.get('stripe-2')?.id).toBe('proj');
    }
  });

  it('assigns project suffixes after existing duplicate connection slugs', () => {
    const firstConnection = fix({ id: 'conn_a', name: 'Stripe', created_at: 2 });
    const secondConnection = fix({ id: 'conn_b', name: 'Stripe', created_at: 3 });
    const projectItem = project({ id: 'proj', name: 'Stripe', created_at: 1 });

    const map = buildSlugMap([projectItem, secondConnection, firstConnection]);

    expect(map.get('stripe')?.id).toBe('conn_a');
    expect(map.get('stripe-2')?.id).toBe('conn_b');
    expect(map.get('stripe-3')?.id).toBe('proj');
  });
});

describe('filterMentionables', () => {
  it('removes connections whose names cannot produce mention slugs', () => {
    const integrations = [
      fix({ id: 'valid', name: 'Sales DB' }),
      fix({ id: 'invalid', name: '!!!' }),
    ];

    expect(filterMentionables(integrations).map((item) => item.id))
      .toEqual(['valid']);
    expect(rankMentionables(integrations, '').map((item) => item.id))
      .toEqual(['valid']);
  });
});

describe('slugForMentionable', () => {
  it('returns the slug an integration was assigned in the map', () => {
    const a = fix({ id: 'a', name: 'Prod', created_at: 1 });
    const b = fix({ id: 'b', name: 'Prod', created_at: 2 });
    const map = buildSlugMap([a, b]);
    expect(slugForMentionable(a, map)).toBe('prod');
    expect(slugForMentionable(b, map)).toBe('prod-2');
  });
});

describe('rankMentionables', () => {
  const integrations = [
    fix({ id: 'stripe', name: 'Stripe Live', integration_type: 'stripe' }),
    fix({ id: 'sales', name: 'Sales DB', integration_type: 'postgres' }),
    fix({ id: 'post', name: 'Post Analytics', integration_type: 'stripe' }),
    fix({ id: 'inventory', name: 'Inventory DB', integration_type: 'postgres' }),
  ];

  it('sorts alphabetically for an empty query', () => {
    expect(rankMentionables(integrations, '').map((item) => item.id))
      .toEqual(['inventory', 'post', 'sales', 'stripe']);
  });

  it('ranks name prefixes before integration type/display name prefixes', () => {
    expect(rankMentionables(integrations, 'post').map((item) => item.id))
      .toEqual(['post', 'inventory', 'sales']);
  });

  it('matches registry display names', () => {
    expect(rankMentionables(integrations, 'postgresql').map((item) => item.id))
      .toEqual(['inventory', 'sales']);
  });

  it('matches BigQuery connections by name, display name, and compact type queries', () => {
    const items = [
      fix({ id: 'prod_bigquery', name: 'Prod', integration_type: 'bigquery' }),
      project({ id: 'prod_project', name: 'Prod Site' }),
    ];

    expect(rankMentionables(items, 'prod').map((item) => item.id))
      .toContain('prod_bigquery');
    expect(rankMentionables(items, 'big query').map((item) => item.id))
      .toEqual(['prod_bigquery']);
    expect(rankMentionables(items, 'bigquery').map((item) => item.id))
      .toEqual(['prod_bigquery']);
  });

  it('matches natural spaced names through slug and compact queries', () => {
    for (const query of ['sales d', 'sales_db', 'sales-db', 'salesd', 'salesdb']) {
      expect(rankMentionables(integrations, query).map((item) => item.id))
        .toContain('sales');
    }
  });

  it('matches disambiguated slugs for duplicate names', () => {
    const duplicates = [
      fix({ id: 'a', name: 'Prod', created_at: 1 }),
      fix({ id: 'b', name: 'Prod', created_at: 2 }),
    ];

    expect(rankMentionables(duplicates, 'prod-2').map((item) => item.id))
      .toEqual(['b']);
  });

  it('sorts an empty query alphabetically across projects and connections', () => {
    const items = [
      fix({ id: 'z_conn', name: 'Zebra DB' }),
      project({ id: 'b_proj', name: 'Beta Site' }),
      project({ id: 'a_proj', name: 'Alpha Site' }),
      fix({ id: 'm_conn', name: 'Mailchimp' }),
    ];

    expect(rankMentionables(items, '').map((item) => item.id))
      .toEqual(['a_proj', 'b_proj', 'm_conn', 'z_conn']);
  });

  it('lets name-prefix project matches outrank substring-only connections', () => {
    const items = [
      fix({ id: 'conn', name: 'Old Camel DB' }),
      project({ id: 'proj', name: 'Camel Site' }),
    ];

    expect(rankMentionables(items, 'camel').map((item) => item.id))
      .toEqual(['proj', 'conn']);
  });

  it('lets name-prefix connection matches outrank substring-only projects', () => {
    const items = [
      project({ id: 'proj', name: 'Old Camel Site' }),
      fix({ id: 'conn', name: 'Camel DB' }),
    ];

    expect(rankMentionables(items, 'camel').map((item) => item.id))
      .toEqual(['conn', 'proj']);
  });

  it('sorts same-tier projects and connections alphabetically regardless of kind', () => {
    const items = [
      fix({ id: 'conn', name: 'Beta DB' }),
      project({ id: 'proj', name: 'Alpha Site' }),
    ];

    expect(rankMentionables(items, 'a').map((item) => item.id))
      .toEqual(['proj', 'conn']);
  });

  it('matches projects through the project type keyword only', () => {
    const items = [
      project({ id: 'proj', name: 'Marketing Site' }),
      fix({ id: 'conn', name: 'Analytics DB' }),
    ];

    expect(rankMentionables(items, 'proj').map((item) => item.id))
      .toEqual(['proj']);
    expect(rankMentionables(items, 'clo').map((item) => item.id))
      .toEqual([]);
  });

  it('preserves input order for identical names across kinds in the same tier', () => {
    const connection = fix({ id: 'conn', name: 'Camel', created_at: 1 });
    const projectItem = project({ id: 'proj', name: 'Camel', created_at: 2 });

    expect(rankMentionables([connection, projectItem], 'camel').map((item) => item.id))
      .toEqual(['conn', 'proj']);
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
    expect(matches[0]!.target?.id).toBe('1');
  });

  it('matches @<slug> after whitespace and newlines', () => {
    expect(parseMentions('hi @stripe', map).map((m) => m.slug)).toEqual(['stripe']);
    expect(parseMentions('hi\n@stripe', map).map((m) => m.slug)).toEqual(['stripe']);
  });

  it('does not match mid-word @ (email-like)', () => {
    expect(parseMentions('email@example.com', map)).toEqual([]);
    expect(parseMentions('foo@bar', map)).toEqual([]);
  });

  it('returns unmatched slugs with target=null', () => {
    const matches = parseMentions('use @unknown_db', map);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.slug).toBe('unknown_db');
    expect(matches[0]!.target).toBeNull();
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

  it('keeps connection annotations byte-identical', () => {
    const out = expandMentions('hi @stripe_live', map);
    expect(out).toBe('hi @stripe_live ⟦ref: stripe "Stripe Live" id=stripe1⟧');
  });

  it('annotates project slugs with project refs and exact project names', () => {
    const projectMap = buildSlugMap([
      project({ id: 'ca-ws-camel-site', name: 'camel-site' }),
    ]);

    const out = expandMentions('hi @camel_site', projectMap);
    expect(out).toBe(
      'hi @camel_site ⟦ref: project "camel-site" id=ca-ws-camel-site⟧',
    );
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

describe('projectsToMentionables', () => {
  it('ignores nested clones and parses source project dates', () => {
    const sourceProjects = [
      {
        id: 'ca-ws-camel-site',
        name: 'camel-site',
        description: 'Marketing site rebuild',
        createdAt: '2026-06-10T12:00:00.000Z',
        updatedAt: '2026-06-11T12:00:00.000Z',
        clones: [
          {
            id: 'ca-ws-camel-site-v2',
            name: 'camel-site-v2',
            description: 'Hero experiment',
            createdAt: 'not-a-date',
            updatedAt: '2026-06-11T13:00:00.000Z',
          },
        ],
      },
    ];

    const items = projectsToMentionables(sourceProjects);

    expect(items).toEqual([{
      kind: 'project',
      id: 'ca-ws-camel-site',
      name: 'camel-site',
      description: 'Marketing site rebuild',
      created_at: Date.parse('2026-06-10T12:00:00.000Z'),
      updated_at: Date.parse('2026-06-11T12:00:00.000Z'),
    }]);
  });

  it('skips top-level clones defensively', () => {
    const sourceProjects = [
      {
        id: 'clone',
        name: 'camel-site-v2',
        description: 'Hero experiment',
        kind: 'clone',
      },
    ] as const;

    expect(projectsToMentionables(sourceProjects)).toEqual([]);
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

  it('reads the connection id from the trailing annotation field', () => {
    const result = stripMentionAnnotationsWithMetadata(
      'hi @prod ⟦ref: postgres "Prod id=wrong" id=abc123⟧ now',
    );

    expect(result.displayText).toBe('hi @prod now');
    expect(result.annotatedMentions).toEqual([
      { slug: 'prod', id: 'abc123' },
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
