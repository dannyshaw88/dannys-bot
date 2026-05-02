'use strict';
const path = require('path');
const fs = require('fs');

const bs3Dir = path.dirname(require.resolve('better-sqlite3/package.json'));
console.log('better-sqlite3 dir:', bs3Dir);

const dbJsPath = path.join(bs3Dir, 'lib', 'database.js');
let dbJs = fs.readFileSync(dbJsPath, 'utf8');
console.log('database.js first 300 chars:', dbJs.slice(0, 300));

const directLoad = "require(require('path').join(__dirname, '..', 'build', 'Release', 'better_sqlite3.node'))";

const patterns = [
  "require('bindings')('better_sqlite3')",
  'require("bindings")("better_sqlite3")',
  "require('bindings')(\"better_sqlite3\")",
  'require("bindings")(\'better_sqlite3\')',
];

let patched = false;
for (const p of patterns) {
  if (dbJs.includes(p)) {
    dbJs = dbJs.replace(p, directLoad);
    fs.writeFileSync(dbJsPath, dbJs);
    console.log('SUCCESS: Patched pattern:', p);
    patched = true;
    break;
  }
}

if (!patched) {
  const lines = dbJs.split('\n').filter(l => l.includes('bindings') || l.includes('.node'));
  console.log('COULD NOT PATCH. Relevant lines:');
  lines.forEach(l => console.log(' >', l.trim()));
  process.exit(1);
}
