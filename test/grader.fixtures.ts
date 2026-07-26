/**
 * The grader regression set (acceptance test 9).
 *
 * Invariant 9 is the one most likely to rot quietly: a grader that drifts charitable
 * converts a failed retrieval into a passed one, and the score still looks plausible.
 * These fixtures are the tripwire. Each is an answer that a charitable grader passes
 * and an honest one fails, plus the specific claim `missing` must name.
 */

import type { RubricCriterion } from '../lib/db/types';

export interface GraderFixture {
  name: string;
  failureMode:
    | 'vague'
    | 'name-drop'
    | 'plausible-falsehood'
    | 'contested-agreement'
    | 'contested-strawman'
    | 'contested-hedge';
  stem: string;
  rubric: RubricCriterion[];
  answer: string;
  /** Rubric ids that must come back unmet. */
  mustBeUnmet: string[];
  /** `missing` must mention at least one of these, so the learner is told what was absent. */
  missingMustMention: string[];
  contested?: boolean;
}

const OWNERSHIP_RUBRIC: RubricCriterion[] = [
  {
    id: 'c1',
    criterion:
      'States that social ownership and state ownership are distinct, and gives at least one case separating them.',
    why_it_matters: 'The distinction is the node. Without it the rest is vocabulary.',
  },
  {
    id: 'c2',
    criterion:
      'Identifies who holds residual control rights under social ownership, not merely who holds title.',
    why_it_matters: 'Title without control is the standard failure of the naive account.',
  },
  {
    id: 'c3',
    criterion:
      'Names a concrete arrangement — a firm, a fund, a sector — and classifies it under the definition given.',
    why_it_matters: 'Application, not recitation.',
  },
  {
    id: 'c4',
    criterion: 'States what observation would show the classification was wrong.',
    why_it_matters: 'A definition that excludes nothing distinguishes nothing.',
  },
];

const STEM =
  'Steelman the claim that state ownership is not social ownership, then state the strongest objection to it.';

export const GRADER_FIXTURES: GraderFixture[] = [
  {
    name: 'vague — names the topic without making the distinction',
    failureMode: 'vague',
    stem: STEM,
    rubric: OWNERSHIP_RUBRIC,
    answer:
      "It's about who owns things, really. There's a difference between the two and people often " +
      'mix them up, which is the whole point of the argument. Depending on how the system is set ' +
      'up you can end up with quite different outcomes, so it matters a lot which one you have. ' +
      'The objection is that the distinction can be overstated in practice.',
    mustBeUnmet: ['c1', 'c2', 'c3', 'c4'],
    missingMustMention: ['distinction', 'control', 'case', 'example', 'ownership'],
  },
  {
    name: 'name-drop — correct terminology, no correct application',
    failureMode: 'name-drop',
    stem: STEM,
    rubric: OWNERSHIP_RUBRIC,
    answer:
      'Social ownership involves residual control rights and the socialisation of the means of ' +
      'production, whereas state ownership is a matter of de jure title vested in a public ' +
      'authority. The principal-agent problem and the calculation debate are both relevant here. ' +
      'One must distinguish between formal and real subsumption, and between usufruct and ' +
      'dominium. Market socialism and the Lange model bear on this.',
    mustBeUnmet: ['c3', 'c4'],
    missingMustMention: ['case', 'example', 'concrete', 'arrangement', 'observation', 'falsif'],
  },
  {
    name: 'plausible falsehood — fluent, confident, and wrong',
    failureMode: 'plausible-falsehood',
    stem: STEM,
    rubric: OWNERSHIP_RUBRIC,
    answer:
      'State ownership and social ownership are the same thing described at different levels of ' +
      'abstraction: the state simply is society acting collectively, so any nationalised industry ' +
      'is by definition socially owned. Norway’s sovereign wealth fund is therefore a textbook ' +
      'case of social ownership, and there is no observation that could show otherwise, since the ' +
      'identity holds analytically.',
    mustBeUnmet: ['c1', 'c2', 'c4'],
    missingMustMention: ['distinct', 'distinction', 'control', 'separat'],
  },
  {
    name: 'contested — argues a position accurately but never meets the criteria',
    failureMode: 'contested-agreement',
    contested: true,
    stem: STEM,
    rubric: OWNERSHIP_RUBRIC,
    answer:
      'Markets allocate resources better than planners because prices carry dispersed knowledge no ' +
      'central authority can assemble. Every attempt at large-scale planning has run into this. ' +
      'The socialist project is therefore misconceived from the start, and the ownership question ' +
      'is a distraction from the allocation question.',
    mustBeUnmet: ['c1', 'c2', 'c3', 'c4'],
    missingMustMention: ['distinct', 'distinction', 'control', 'ownership'],
  },
  {
    name: 'contested — strawmans the position it was asked to steelman',
    failureMode: 'contested-strawman',
    contested: true,
    stem: STEM,
    rubric: OWNERSHIP_RUBRIC,
    answer:
      'The claim that state ownership is not social ownership is really just a way for socialists ' +
      'to disown every failed regime. Whenever a planned economy collapses they say it was not ' +
      'real socialism. That is the entire content of the distinction, and the objection to it is ' +
      'that it is unfalsifiable by construction.',
    mustBeUnmet: ['c1', 'c2', 'c3'],
    missingMustMention: ['distinct', 'distinction', 'control', 'case', 'example'],
  },
  {
    name: 'contested — hedges instead of committing to either side',
    failureMode: 'contested-hedge',
    contested: true,
    stem: STEM,
    rubric: OWNERSHIP_RUBRIC,
    answer:
      'There are reasonable arguments on both sides here. Some people hold that the two are ' +
      'distinct and others hold that they are not, and where you land depends on your priors about ' +
      'the state. Both views have serious defenders, and it would be presumptuous to declare one ' +
      'of them correct. The literature is genuinely divided.',
    mustBeUnmet: ['c1', 'c2', 'c3', 'c4'],
    missingMustMention: ['distinct', 'distinction', 'control', 'case', 'example'],
  },
];

/**
 * A control: an answer that genuinely meets the rubric. If the grader fails this it
 * has drifted uncharitable in the other direction, which is a different bug but
 * still a bug.
 */
export const GRADER_PASSING_FIXTURE: GraderFixture = {
  name: 'control — an answer that actually does the work',
  failureMode: 'vague',
  stem: STEM,
  rubric: OWNERSHIP_RUBRIC,
  answer:
    'The steelman: social ownership means society as a whole holds the residual control rights ' +
    'over the means of production — the right to decide what is produced and what happens to the ' +
    'surplus — whereas state ownership means a government agency holds legal title. These come ' +
    'apart. A state-owned oil company run for ministerial revenue, with no mechanism by which ' +
    'citizens direct it, has state title and no social control; a worker-owned cooperative ' +
    'federation with no state involvement has social control and no state title. Norway’s ' +
    'sovereign wealth fund is state-owned in title, and I would classify it as state rather than ' +
    'social ownership, because the residual control sits with the finance ministry rather than ' +
    'with any body citizens direct. The claim would be shown wrong if you could find an economy ' +
    'where legal title sat with the state and residual control demonstrably sat with the ' +
    'population — where citizens could and did redirect production against ministerial ' +
    'preference. The strongest objection is that "society as a whole" has no decision procedure: ' +
    'absent some concrete institution, social control is not a distinct arrangement but an ' +
    'unspecified one, and in practice the state is the only body that can act for society.',
  mustBeUnmet: [],
  missingMustMention: [],
};
