const { readFileSync } = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

// Retain isolated modules so Node keeps their source maps until coverage is collected.
const loadedModules = []

// Transpile in memory and allow only explicitly supplied dependencies.
function loadSource(relativePath, dependencies, globals = {}) {
  const filename = path.resolve(__dirname, '..', relativePath)
  // Inject test globals on the first line so original source line numbers stay intact.
  const bindings = Object.keys(globals).length
    ? `const { ${Object.keys(globals).join(', ')} } = module.testGlobals; `
    : ''
  const { outputText } = ts.transpileModule(
    bindings + readFileSync(filename, 'utf8'),
    {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        inlineSourceMap: true,
        inlineSources: true,
      },
    },
  )
  // Compile as CommonJS so Node registers the inline map for coverage reporting.
  const compiledFilename = filename.replace(/\.ts$/, '.cjs')
  const module = new Module(compiledFilename)
  module.filename = compiledFilename
  module.testGlobals = globals
  const mockedRequire = (name) => {
    if (!Object.hasOwn(dependencies, name)) {
      throw new Error(`Unexpected dependency: ${name}`)
    }
    return dependencies[name]
  }
  // Keep dependency mocks local to this module and register its source map with Node.
  module.require = mockedRequire
  module._compile(outputText, compiledFilename)
  loadedModules.push(module)
  return module.exports
}

module.exports = { loadSource }
