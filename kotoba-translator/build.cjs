const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { transformSync } = require("esbuild");
const babel = require("@babel/core");
const root = __dirname;
const core = fs.readFileSync(path.join(root, "src/core.cjs"), "utf8");
const plugin = fs.readFileSync(path.join(root, "src/plugin.js"), "utf8");
const addons = fs.readFileSync(path.join(root, "src/addon-ui.js"), "utf8");
const messages = fs.readFileSync(path.join(root, "src/message-ui.js"), "utf8");
const statistics = fs.readFileSync(path.join(root, "src/statistics-ui.js"), "utf8");
const models = fs.readFileSync(path.join(root, "src/model-picker.js"), "utf8");
// Vendetta evaluates the downloaded JS as an expression with `vendetta` in scope.
// The iOS Hermes evaluator rejects native async functions and classes. Keep helpers inside
// the expression: Kettu inserts the entire file immediately after `return`.
const lowered = babel.transformSync(`const module={exports:{}};\n${core}\n${addons}\n${messages}\n${models}\n${statistics}\n${plugin}`, {
    babelrc: false, configFile: false, plugins: [require("@babel/plugin-transform-classes"), require("@babel/plugin-transform-block-scoping")],
}).code;
const { code } = transformSync(lowered, {
    loader: "js", target: "es2015", charset: "utf8", legalComments: "none",
});
const bundle = `(()=>{\n${code}\nreturn createPlugin(vendetta,module.exports);\n})()`;
new Function("vendetta", `return ${bundle}`);
fs.writeFileSync(path.join(root, "index.js"), bundle + "\n");
fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({
    name: "ことば Translator", description: "DeepL・OpenAI・DeepSeek・Gemini・OpenRouter・カスタムエンドポイント対応。自動翻訳・モデル一覧取得・API 切替",
    authors: [{ name: "porari" }], main: "index.js",
    hash: crypto.createHash("sha256").update(bundle + "\n").digest("hex"),
}, null, 2) + "\n");
console.log("Built index.js and manifest.json");
