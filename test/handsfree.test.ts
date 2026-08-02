/**
 * The hands-free mode's two pure halves: what gets said, and what an utterance means.
 *
 * The parser tests skew adversarial on purpose. A misheard "select" while driving
 * records an answer the learner did not give, and invariant 2 means it can never be
 * taken back — so the safe failure mode everywhere is null, and these tests pin the
 * cases where null is the right answer as firmly as the ones where a command is.
 */

import { describe, expect, it } from 'vitest';
import { parseCommand, type CommandContext } from '../lib/handsfree/commands';
import {
  answerPrompt,
  chunk,
  confidencePrompt,
  feedbackScript,
  itemScript,
  joinMarks,
  MAX_SPOKEN_CHUNK,
  type SpokenItem,
} from '../lib/handsfree/script';
import { en, zh } from '../lib/i18n/dict';

const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  locale: 'en',
  phase: 'answer',
  optionCount: 4,
  ...over,
});

describe('voice commands — selecting an option (en)', () => {
  it('hears the Greek series the interface prints', () => {
    expect(parseCommand('Alpha', ctx())).toEqual({ type: 'select', index: 0 });
    expect(parseCommand('beta.', ctx())).toEqual({ type: 'select', index: 1 });
    expect(parseCommand('I think gamma', ctx())).toEqual({ type: 'select', index: 2 });
    expect(parseCommand('Delta', ctx())).toEqual({ type: 'select', index: 3 });
  });

  it('hears plain letters, ordinals, and aimed forms', () => {
    expect(parseCommand('B', ctx())).toEqual({ type: 'select', index: 1 });
    expect(parseCommand('option c', ctx())).toEqual({ type: 'select', index: 2 });
    expect(parseCommand("it's d", ctx())).toEqual({ type: 'select', index: 3 });
    expect(parseCommand('the second one', ctx())).toEqual({ type: 'select', index: 1 });
    expect(parseCommand('3', ctx())).toEqual({ type: 'select', index: 2 });
  });

  it('does not fish a bare letter out of a long utterance', () => {
    // "a" is a word in almost every English sentence; a five-token utterance with an
    // "a" in it is conversation, not an answer.
    expect(parseCommand('give me a little more time here', ctx())).toBeNull();
  });

  it('never selects past the option count', () => {
    expect(parseCommand('epsilon', ctx({ optionCount: 4 }))).toBeNull();
  });

  it('prefers repeat over the number word inside it', () => {
    // "one more time" contains "one"; hearing it as option 1 would record an answer.
    expect(parseCommand('one more time', ctx())).toEqual({ type: 'repeat' });
  });
});

describe('voice commands — selecting an option (zh)', () => {
  const zhCtx = (phase: CommandContext['phase'] = 'answer') =>
    ctx({ locale: 'zh', phase });

  it('hears letters, aimed letters, and ordinals', () => {
    expect(parseCommand('B', zhCtx())).toEqual({ type: 'select', index: 1 });
    expect(parseCommand('选A', zhCtx())).toEqual({ type: 'select', index: 0 });
    expect(parseCommand('选项 C', zhCtx())).toEqual({ type: 'select', index: 2 });
    expect(parseCommand('第三个', zhCtx())).toEqual({ type: 'select', index: 2 });
    expect(parseCommand('我选第四个', zhCtx())).toEqual({ type: 'select', index: 3 });
  });

  it('takes a bare numeral only as the whole utterance', () => {
    expect(parseCommand('三', zhCtx())).toEqual({ type: 'select', index: 2 });
    expect(parseCommand('这三个里我都不喜欢', zhCtx())).toBeNull();
  });
});

describe('voice commands — confidence', () => {
  const conf = (phase: 'confidence' = 'confidence') => ctx({ phase });

  it('maps the three states', () => {
    expect(parseCommand('guessing', conf())).toEqual({ type: 'confidence', value: 'guessing' });
    expect(parseCommand('unsure', conf())).toEqual({ type: 'confidence', value: 'unsure' });
    expect(parseCommand('confident', conf())).toEqual({
      type: 'confidence',
      value: 'confident',
    });
  });

  it('does not hear "sure" inside "not sure"', () => {
    expect(parseCommand('not sure', conf())).toEqual({ type: 'confidence', value: 'unsure' });
    expect(parseCommand("I'm sure", conf())).toEqual({ type: 'confidence', value: 'confident' });
  });

  it('does not hear 确定 inside 不确定', () => {
    const zhConf = ctx({ locale: 'zh', phase: 'confidence' });
    expect(parseCommand('不确定', zhConf)).toEqual({ type: 'confidence', value: 'unsure' });
    expect(parseCommand('确定', zhConf)).toEqual({ type: 'confidence', value: 'confident' });
    expect(parseCommand('猜的', zhConf)).toEqual({ type: 'confidence', value: 'guessing' });
  });

  it('lets a changed mind re-select during the confidence phase', () => {
    expect(parseCommand('actually beta', ctx({ phase: 'confidence' }))).toEqual({
      type: 'select',
      index: 1,
    });
  });
});

describe('voice commands — flow control', () => {
  it('advances, repeats, and declines', () => {
    expect(parseCommand('next', ctx({ phase: 'feedback' }))).toEqual({ type: 'next' });
    expect(parseCommand('下一题', ctx({ locale: 'zh', phase: 'feedback' }))).toEqual({
      type: 'next',
    });
    expect(parseCommand('repeat that', ctx())).toEqual({ type: 'repeat' });
    expect(parseCommand('再读一遍', ctx({ locale: 'zh' }))).toEqual({ type: 'repeat' });
    expect(parseCommand("I don't know", ctx())).toEqual({ type: 'dontKnow' });
    expect(parseCommand('不知道', ctx({ locale: 'zh' }))).toEqual({ type: 'dontKnow' });
  });

  it('while paused, hears only resume', () => {
    expect(parseCommand('beta', ctx({ phase: 'paused' }))).toBeNull();
    expect(parseCommand("i don't know", ctx({ phase: 'paused' }))).toBeNull();
    expect(parseCommand('resume', ctx({ phase: 'paused' }))).toEqual({ type: 'resume' });
    expect(parseCommand('继续', ctx({ locale: 'zh', phase: 'paused' }))).toEqual({
      type: 'resume',
    });
  });

  it('returns null for silence and noise', () => {
    expect(parseCommand('', ctx())).toBeNull();
    expect(parseCommand('   ', ctx())).toBeNull();
    expect(parseCommand('hmm let me think about that', ctx())).toBeNull();
  });
});

describe('voice commands — dictation treats speech as content', () => {
  const dict = (locale: 'en' | 'zh' = 'en') => ctx({ locale, phase: 'dictation' });

  it('leaves answer-shaped sentences alone', () => {
    // All of these contain loose command words ("pass", "done", "wait") that the
    // other phases accept; mid-dictation they are the answer, not instructions.
    expect(parseCommand('the bill would pass the senate', dict())).toBeNull();
    expect(parseCommand('once the analysis is done it generalises', dict())).toBeNull();
    expect(parseCommand('workers wait for no one', dict())).toBeNull();
    expect(parseCommand('alpha decay emits a helium nucleus', dict())).toBeNull();
  });

  it('ends on the explicit closes only', () => {
    expect(parseCommand("I'm done", dict())).toEqual({ type: 'done' });
    expect(parseCommand('Done.', dict())).toEqual({ type: 'done' });
    expect(parseCommand('说完了', dict('zh'))).toEqual({ type: 'done' });
    expect(parseCommand('资本主义完了', dict('zh'))).toBeNull();
  });

  it('gives up only on the unmistakable phrasing', () => {
    expect(parseCommand('I give up', dict())).toEqual({ type: 'dontKnow' });
    expect(parseCommand('pass', dict())).toBeNull();
    expect(parseCommand('我放弃', dict('zh'))).toEqual({ type: 'dontKnow' });
  });
});

// ---------------------------------------------------------------------- scripts

const mcItem: SpokenItem = {
  kind: 'mc',
  stem: 'What does social ownership require?',
  position: 3,
  total: 20,
  options: [
    { text: 'Control by the direct producers' },
    { text: 'State ownership of all firms' },
    { text: 'Equal shareholdings' },
    { text: 'A ban on markets' },
  ],
};

describe('the item as read', () => {
  it('reads the counter, the stem, and every option with its spoken mark', () => {
    const script = itemScript(mcItem, en, 'en').join(' ');
    expect(script).toContain('Question 3 of 20');
    expect(script).toContain('What does social ownership require?');
    for (const o of mcItem.options) expect(script).toContain(o.text);
    // The Greek the interface prints, pronounced rather than shown.
    for (const mark of ['Alpha', 'Beta', 'Gamma', 'Delta']) expect(script).toContain(mark);
  });

  it('speaks Chinese in the Chinese interface, with ABCD marks', () => {
    const script = itemScript(mcItem, zh, 'zh').join(' ');
    expect(script).toContain('第 3 题');
    expect(script).toContain('选项 A');
    expect(script).toContain('选项 D');
  });

  it('prompts with the exact marks on offer', () => {
    expect(answerPrompt(mcItem, en, 'en')).toContain('Alpha, Beta, Gamma, or Delta');
    const three: SpokenItem = { ...mcItem, options: mcItem.options.slice(0, 3) };
    expect(answerPrompt(three, en, 'en')).toContain('Alpha, Beta, or Gamma');
    expect(answerPrompt(three, zh, 'zh')).toContain('A、B 或 C');
  });

  it('asks for confidence before recording, in both flows', () => {
    // Invariant 1 spoken out loud: the mark it echoes back, and the three states.
    const mc = confidencePrompt(1, en, 'en');
    expect(mc).toContain('Beta');
    expect(mc.toLowerCase()).toContain('guessing');
    const free = confidencePrompt(null, en, 'en');
    expect(free.toLowerCase()).toContain('confident');
  });

  it('reads a free-response item without inventing options', () => {
    const freeItem: SpokenItem = { ...mcItem, kind: 'free', options: [] };
    const script = itemScript(freeItem, en, 'en').join(' ');
    expect(script).not.toContain('Option');
    expect(answerPrompt(freeItem, en, 'en')).toBe(en.session.handsFreeSpokenFreePrompt);
  });
});

describe('the verdict as read', () => {
  const options = [
    { text: 'Control by the direct producers', isCorrect: true },
    { text: 'State ownership of all firms', isCorrect: false },
  ];

  it('a wrong answer names the correct option before explaining', () => {
    const script = feedbackScript(
      { kind: 'mc', correct: false, explanation: 'Ownership follows control.', options },
      en,
      'en'
    ).join(' ');
    expect(script).toContain(en.session.feedbackHeadWrong);
    expect(script).toContain('Alpha');
    expect(script).toContain('Control by the direct producers');
    expect(script).toContain('Ownership follows control.');
  });

  it('a correct answer does not re-read the options', () => {
    const script = feedbackScript(
      { kind: 'mc', correct: true, explanation: 'Just that.', options },
      en,
      'en'
    ).join(' ');
    expect(script).toContain(en.session.feedbackHeadCorrect);
    expect(script).not.toContain('State ownership of all firms');
  });

  it('a declined item is announced as not known', () => {
    const script = feedbackScript(
      { kind: 'mc', correct: false, declined: true, explanation: 'x', options },
      en,
      'en'
    ).join(' ');
    expect(script).toContain(en.session.feedbackHeadDontKnow);
  });

  it('a graded free response reads the verdict and the criteria count', () => {
    const script = feedbackScript(
      {
        kind: 'free',
        correct: false,
        score: 0.5,
        threshold: 0.8,
        criteria: [{ met: true }, { met: false }],
        verdictSummary: 'Half the argument is there.',
      },
      en,
      'en'
    ).join(' ');
    expect(script).toContain('Half the argument is there.');
    expect(script).toContain('1 of 2');
    expect(script).toContain('50%');
  });
});

describe('chunking for the synthesis endpoint', () => {
  it('passes short text through whole', () => {
    expect(chunk('One sentence.')).toEqual(['One sentence.']);
  });

  it('keeps every chunk under the cap and loses no words', () => {
    const sentence = 'A clause about ownership, control and the firm. ';
    const long = sentence.repeat(30);
    const chunks = chunk(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_SPOKEN_CHUNK);
      expect(c.trim().length).toBeGreaterThan(0);
    }
    expect(chunks.join(' ')).toBe(long.replace(/\s+/g, ' ').trim());
  });

  it('splits an unspaced Chinese sentence rather than overflowing', () => {
    const long = '这一段没有句号也没有空格却很长'.repeat(40);
    const chunks = chunk(long);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_SPOKEN_CHUNK);
    expect(chunks.join('')).toBe(long);
  });

  it('returns nothing for nothing', () => {
    expect(chunk('   ')).toEqual([]);
  });
});

describe('mark joining', () => {
  it('handles the degenerate lengths', () => {
    expect(joinMarks('en', [])).toBe('');
    expect(joinMarks('en', ['Alpha'])).toBe('Alpha');
    expect(joinMarks('en', ['Alpha', 'Beta'])).toBe('Alpha, or Beta');
  });
});
