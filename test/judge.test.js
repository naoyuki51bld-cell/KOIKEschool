const test = require('node:test');
const assert = require('node:assert');
const { judge } = require('../server/judge');

const value = (...answers) => ({ answers, mode: 'value' });

test('値として等しい答えを正解にする', () => {
  for (const a of ['2√3', '√12', '２√３', '2*sqrt(3)', '3.4641016151377544', 'x=2√3', '答え：2√3']) {
    assert.equal(judge(a, value('2√3')), true, a);
  }
  assert.equal(judge('3', value('2√3')), false);
  assert.equal(judge('1/2', value('0.5')), true);
  assert.equal(judge('π/2', value('pi/2')), true);
  assert.equal(judge('-3', value('−3')), true);
});

test('文字式は代入して比べる', () => {
  for (const a of ['x^2+2x+1', 'x²+2x+1', '(x+1)(x+1)', 'x＾２＋２ｘ＋１']) {
    assert.equal(judge(a, value('(x+1)^2')), true, a);
  }
  assert.equal(judge('x^2+2x', value('(x+1)^2')), false);
  assert.equal(judge('2a+b', value('b+2a')), true);
});

test('完全一致モードは表記の違いだけ吸収する', () => {
  const exact = { answers: ['(x+1)^2'], mode: 'exact' };
  assert.equal(judge('( x + 1 )^2', exact), true);
  assert.equal(judge('x^2+2x+1', exact), false);
});

test('式でない入力や危険な入力は不正解', () => {
  assert.equal(judge('', value('1')), false);
  assert.equal(judge('import({})', value('1')), false);
  assert.equal(judge('evaluate("1")', value('1')), false);
  assert.equal(judge('わからない', value('1')), false);
  assert.equal(judge('1', { answers: [] }), null);
});
