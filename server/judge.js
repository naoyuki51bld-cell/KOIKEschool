// 短答（数値・式）の自動判定。
// 「2√3」と「√12」、「1/2」と「0.5」、「x^2+2x+1」と「(x+1)^2」のような値として等しい答えを正解にできる。
const { create, all } = require('mathjs');

const math = create(all);

const ALLOWED_FUNCTIONS = new Set([
  'sqrt', 'cbrt', 'abs', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'log', 'log10', 'log2', 'exp', 'nthRoot',
]);
const CONSTANTS = new Set(['pi', 'e']);

// 全角→半角、記号の置き換えなど、表記ゆれを吸収する
function normalize(input) {
  // ²・³ は NFKC で「2」「3」になってしまうので先に置き換える
  let s = String(input || '').replace(/²/g, '^2').replace(/³/g, '^3').normalize('NFKC').trim();
  s = s.replace(/[\s　]+/g, '')
    .replace(/[×✕]/g, '*')
    .replace(/÷/g, '/')
    .replace(/[−–—ー]/g, '-')
    .replace(/π/g, 'pi')
    .replace(/[，、]/g, ',')
    .toLowerCase();
  // √3, √x, √(x+1) → sqrt(...)
  s = s.replace(/√(\d+(?:\.\d+)?|[a-z]|\([^()]*\))/g, (_, arg) => `sqrt(${arg.replace(/^\((.*)\)$/, '$1')})`);
  return s;
}

// 先頭の「x=」「答え:」などを外す
function stripLabel(s) {
  return s.replace(/^(?:答え?|ans(?:wer)?)[:：]?/, '').replace(/^[a-z]=(?=[^=]+$)/, '');
}

function parseSafe(expr) {
  let node;
  try {
    node = math.parse(expr);
  } catch {
    return null;
  }
  const variables = new Set();
  let ok = true;
  node.traverse((n, _path, parent) => {
    if (!ok) return;
    switch (n.type) {
      case 'ConstantNode':
      case 'OperatorNode':
      case 'ParenthesisNode':
        break;
      case 'FunctionNode':
        if (!ALLOWED_FUNCTIONS.has(n.fn.name)) ok = false;
        break;
      case 'SymbolNode':
        if (parent && parent.type === 'FunctionNode' && parent.fn === n) break;
        if (CONSTANTS.has(n.name)) break;
        if (/^[a-z]$/.test(n.name)) variables.add(n.name);
        else ok = false;
        break;
      default:
        ok = false;
    }
  });
  if (!ok) return null;
  return { code: node.compile(), variables };
}

function approxEqual(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

// 値として等しいか。文字を含む式は、いくつかの値を代入して比べる
function sameValue(a, b) {
  const pa = parseSafe(a);
  const pb = parseSafe(b);
  if (!pa || !pb) return false;
  const vars = [...new Set([...pa.variables, ...pb.variables])];
  const trials = vars.length ? 6 : 1;
  for (let t = 0; t < trials; t++) {
    const scope = {};
    vars.forEach((v, i) => { scope[v] = 0.37 + t * 1.13 + i * 0.71; });
    let va, vb;
    try {
      va = pa.code.evaluate({ ...scope });
      vb = pb.code.evaluate({ ...scope });
    } catch {
      return false;
    }
    if (!approxEqual(Number(va), Number(vb))) return false;
  }
  return true;
}

// accepted: { answers: string[], mode: 'value' | 'exact' }
function judge(answer, accepted) {
  const answers = (accepted && accepted.answers) || [];
  if (!answers.length) return null;
  const given = stripLabel(normalize(answer));
  if (!given) return false;
  for (const raw of answers) {
    const expected = stripLabel(normalize(raw));
    if (given === expected) return true;
    if (accepted.mode !== 'exact' && sameValue(given, expected)) return true;
  }
  return false;
}

module.exports = { judge, normalize };
