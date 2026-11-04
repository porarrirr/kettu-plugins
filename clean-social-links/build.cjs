const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
// Source deliberately uses no async/class/lexical loops; no syntax lowering needed.
const bundle = '(function(){var module={exports:{}};\n' + read('src/core.cjs') + '\n' + read('src/plugin.js') + '\nreturn createPlugin(vendetta,module.exports);})()\n';
new Function('vendetta', 'return ' + bundle);
fs.writeFileSync(path.join(__dirname, 'index.js'), bundle);
fs.writeFileSync(path.join(__dirname, 'manifest.json'), JSON.stringify({
    name: 'Clean Social Links', description: 'Instagram・X・AmazonのリンクとAliExpressの商品リンクの ? 以降をサイト別にON/OFFして削除。Xのfxtwitter置換は任意（初期OFF）',
    authors: [{ name: 'porari' }], main: 'index.js',
    hash: crypto.createHash('sha256').update(bundle).digest('hex')
}, null, 2) + '\n');
console.log('Built index.js and manifest.json');
