/**
 * Seed a demo database without touching the LLM.
 *
 * Useful for looking at the UI, and for the smoke test in CI. It writes a blueprint,
 * a handful of items with tagged distractors, and a short response history so the
 * grid, the misconception profile and the forecast all have something to show.
 *
 *   GYM_DB=./data/demo.db npx tsx scripts/seed-demo.ts
 */

import { getDb } from '../lib/db';
import {
  createConcept,
  createNode,
  createUser,
  getUserByEmail,
  upsertMisconception,
} from '../lib/db/queries';
import { hashPasswordSync } from '../lib/password';
import { persistMcItem } from '../lib/pipeline/generateItem';
import { submitMcResponse } from '../lib/pipeline/respond';
import { startSession } from '../lib/pipeline/session';
import { setClock, TestClock } from '../lib/clock';

const NODES = [
  {
    title: 'Ownership structures',
    description:
      'What social ownership is, and how it differs from state ownership. Mastery means being able to place a concrete arrangement on the right side of the line and say why.',
    misconceptions: [
      ['state ownership = social ownership', 'I think if the government owns it, society owns it.'],
      ['socialism = redistribution', 'I think socialism just means taxing the rich and transferring income.'],
      ['socialism requires central planning', 'I think you cannot have socialism with markets.'],
    ],
  },
  {
    title: 'Allocation mechanisms',
    description:
      'How resources move under different arrangements: prices, plans, and hybrids. Mastery means treating allocation as separable from ownership.',
    misconceptions: [
      ['planning means no prices', 'I think a planned economy has no prices at all.'],
      ['markets imply private ownership', 'I think you cannot have a market without private owners.'],
      ['the plan is always national', 'I think planning has to happen at the level of the whole state.'],
    ],
  },
  {
    title: 'The calculation debate',
    description:
      'The argument that administrative allocation cannot use dispersed knowledge, and the replies to it. Mastery means stating the strongest form of each side.',
    misconceptions: [
      ['the debate is about motivation', 'I think the calculation problem is really about incentives.'],
      ['computers settle it', 'I think enough compute makes the calculation objection go away.'],
      ['it was settled empirically', 'I think the collapse of the USSR decided the argument.'],
    ],
  },
  {
    title: 'Historical cases',
    description:
      'Which actual economies instantiate which arrangement, and where the labels mislead. Mastery means resisting the pull of the self-description.',
    misconceptions: [
      ['self-description is definitive', 'I think if a state calls itself socialist, it is.'],
      ['nordic countries are socialist', 'I think large welfare states are socialist economies.'],
      ['every case is the same', 'I think all the twentieth-century cases were the same arrangement.'],
    ],
  },
  {
    title: 'Distribution of surplus',
    description:
      'Who receives the residual after costs, and why that is a separate question from title. Mastery means keeping surplus, title and control apart.',
    misconceptions: [
      ['surplus means profit', 'I think surplus is just another word for profit.'],
      ['equal shares are required', 'I think social ownership implies everyone gets the same.'],
      ['wages settle it', 'I think if wages are high the surplus question is answered.'],
    ],
  },
];

const clock = new TestClock('2026-01-01T00:00:00.000Z');
setClock(clock);

const db = getDb();

// Accounts exist now, so a seed has to belong to one. This is the account the demo logs
// in as; it is not the migration's owner and carries a throwaway password on purpose.
const demoUser =
  getUserByEmail(db, 'demo@localhost') ??
  createUser(db, {
    email: 'demo@localhost',
    passwordHash: hashPasswordSync('demo-password'),
    displayName: 'Demo',
  });

const { concept } = createConcept(db, {
  userId: demoUser.id,
  name: 'Socialism',
  sourceText:
    'Social ownership is ownership of the means of production by society as a whole. It is ' +
    'distinct from state ownership, in which a government agency holds legal title.\n\n' +
    'Market socialism retains price signals while socialising ownership. Central planning ' +
    'allocates resources administratively rather than through prices.\n\n' +
    'The calculation debate concerns whether administrative allocation can make use of the ' +
    'knowledge dispersed across an economy, which prices are said to aggregate.',
  sourceNote: 'Demo seed [contested]',
});

const nodeIds: number[] = [];
NODES.forEach((n, i) => {
  const node = createNode(db, {
    conceptId: concept.id,
    title: n.title,
    description: n.description,
    orderIndex: i,
    origin: 'generated',
    applicableDepths: [1, 2, 3, 4, 5, 6],
  });
  nodeIds.push(node.id);
  for (const [label, description] of n.misconceptions) {
    upsertMisconception(db, { nodeId: node.id, label, description, origin: 'generated' });
  }
});

// One item per node at D1, with every distractor tagged.
const items = nodeIds.map((nodeId, i) => {
  const cell = db.prepare(`SELECT id FROM cells WHERE node_id = ? AND depth = 1`).get(nodeId) as {
    id: number;
  };
  const bank = db
    .prepare(`SELECT label FROM misconceptions WHERE node_id = ? ORDER BY id`)
    .all(nodeId) as { label: string }[];

  return persistMcItem(db, {
    cellId: cell.id,
    nodeId,
    order: [0, 1, 2, 3],
    verdict: { best_option: 1, defensible_options: [1], flags: [], notes: 'seeded' },
    gen: {
      stem: `${NODES[i].title}: which statement is supported by the source?`,
      explanation:
        'The source separates who holds title from how resources are allocated. Keeping those ' +
        'two apart is what the node is for.',
      options: [
        {
          text: 'Title and allocation are separate questions, and the source treats them separately.',
          is_correct: true,
          misconception_label: null,
          rationale: 'This is the distinction the passage draws explicitly.',
        },
        ...bank.slice(0, 3).map((m) => ({
          text: `A reading that follows from believing "${m.label}".`,
          is_correct: false,
          misconception_label: m.label,
          rationale: `This is what someone holding "${m.label}" would conclude, and it collapses ` +
            `a distinction the source keeps open.`,
        })),
      ],
    },
  });
});

// A short history: mostly right, with one belief selected twice so remediation kicks in.
const session = startSession(db, demoUser.id, concept.id, { length: 20 });

items.forEach((item, i) => {
  const options = db
    .prepare(`SELECT * FROM options WHERE item_id = ? ORDER BY position`)
    .all(item.id) as { id: number; is_correct: number }[];

  const wrong = i >= 3;
  const chosen = wrong ? options.find((o) => o.is_correct === 0)! : options.find((o) => o.is_correct === 1)!;

  clock.advanceMs(90_000);
  submitMcResponse(db, {
    sessionId: session.sessionId,
    itemId: item.id,
    chosenOptionId: chosen.id,
    confidence: wrong ? 'confident' : 'confident',
    latencyMs: 12_000,
  });
});

// Repeat the last miss so its misconception becomes active.
const lastItem = items[items.length - 1];
const lastWrong = db
  .prepare(`SELECT id FROM options WHERE item_id = ? AND is_correct = 0 ORDER BY position LIMIT 1`)
  .get(lastItem.id) as { id: number };
clock.advanceMs(90_000);
submitMcResponse(db, {
  sessionId: session.sessionId,
  itemId: lastItem.id,
  chosenOptionId: lastWrong.id,
  confidence: 'confident',
  latencyMs: 9_000,
});

// One frozen benchmark item so the benchmark screen is not empty.
db.prepare(`UPDATE items SET frozen = 1 WHERE id = ?`).run(items[0].id);

console.log(`seeded concept ${concept.id} (${concept.name}) with ${nodeIds.length} nodes`);
console.log(`  sign in as demo@localhost / demo-password`);
console.log(`  items: ${items.length}, one promoted to the benchmark set`);
console.log(`  db: ${process.env.GYM_DB ?? './data/gym.db'}`);
