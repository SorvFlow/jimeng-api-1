const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

module.exports = function loader(stubs = {}, globals = {}) {
  const root = path.join(__dirname, '../..');
  const cache = new Map();
  function load(name, parent = path.join(root, 'src')) {
    if (Object.hasOwn(stubs, name)) return stubs[name];
    let absolute = name.startsWith('@/') ? path.join(root, 'src', name.slice(2))
      : name.startsWith('.') ? path.resolve(parent, name) : name;
    if (absolute.startsWith(root) && absolute.endsWith('.js') && !fs.existsSync(absolute)) absolute = absolute.slice(0, -3) + '.ts';
    if (Object.hasOwn(stubs, absolute)) return stubs[absolute];
    if (!absolute.endsWith('.ts')) return require(absolute);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const mod = { exports: {} };
    cache.set(absolute, mod);
    const source = transformSync(fs.readFileSync(absolute, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node18' }).code;
    vm.runInNewContext(source, {
      module: mod, exports: mod.exports, Buffer, URL, Date, Math, console, process, setTimeout, clearTimeout,
      ...globals,
      require: id => load(id, path.dirname(absolute)),
    }, { filename: absolute });
    return mod.exports;
  }
  return name => load(name);
};
