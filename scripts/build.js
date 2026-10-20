// 画面で使うライブラリを public/vendor にまとめる（npm run build）
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'vendor');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'firebase.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'FB',
  target: ['es2020'],
  outfile: path.join(out, 'firebase.js'),
  legalComments: 'none',
});

const katex = path.join(path.dirname(require.resolve('katex/package.json')), 'dist');
fs.cpSync(katex, path.join(out, 'katex'), {
  recursive: true,
  filter: (src) => !/\.(mjs|map)$/.test(src) && !src.includes(`${path.sep}contrib${path.sep}mhchem`),
});
fs.copyFileSync(path.join(root, 'node_modules', 'mathjs', 'lib', 'browser', 'math.js'), path.join(out, 'math.js'));
fs.copyFileSync(path.join(root, 'node_modules', 'qrcode-generator', 'dist', 'qrcode.js'), path.join(out, 'qrcode.js'));
console.log('public/vendor を作りました');
