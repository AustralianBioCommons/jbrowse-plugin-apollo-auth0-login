const { readFileSync } = require('node:fs')
const path = require('node:path')
const { compileFunction } = require('node:vm')
const ts = require('typescript')

// Transpile in memory and allow only explicitly supplied dependencies.
function loadSource(relativePath, dependencies, globals = {}) {
  const filename = path.resolve(__dirname, '..', relativePath)
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  })
  const module = { exports: {} }
  const mockedRequire = (name) => {
    if (!Object.hasOwn(dependencies, name)) {
      throw new Error(`Unexpected dependency: ${name}`)
    }
    return dependencies[name]
  }
  // Use the current realm so errors and returned objects retain their identities.
  const evaluate = compileFunction(
    outputText,
    ['require', 'module', 'exports', ...Object.keys(globals)],
    { filename },
  )
  evaluate(mockedRequire, module, module.exports, ...Object.values(globals))
  return module.exports
}

module.exports = { loadSource }
