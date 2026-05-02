'use strict';
const path = require('path');
const fs = require('fs');

const bs3Dir = path.dirname(require.resolve('better-sqlite3/package.json'));
console.log('better-sqlite3 dir:', bs3Dir);

const shimDir = path.join(bs3Dir, 'node_modules', 'bindings');
fs.mkdirSync(shimDir, { recursive: true });

const shim = [
  "'use strict';",
  "const path = require('path');",
  "module.exports = function(name) {",
  "  const f = path.join(__dirname, '..', '..', 'build', 'Release', name + '.node');",
  "  return require(f);",
  "};",
].join('\n');

fs.writeFileSync(path.join(shimDir, 'index.js'), shim);
fs.writeFileSync(
  path.join(shimDir, 'package.json'),
  JSON.stringify({ name: 'bindings', version: '1.5.0', main: 'index.js' })
);
console.log('Bindings shim written to:', shimDir);
