/**
 * Simulate the browser module loader against the built client bundle to
 * verify it executes without errors and exports the expected plugin face.
 * Run: node scripts/verify-client-bundle.mjs
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const bundlePath = new URL('../lib/client.js', import.meta.url)

// Minimal window/loader stub matching the DSH shell kernel.
const factories = new Map()
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      if (factories.has(id)) throw new Error(`duplicate factory registration for "${id}"`)
      factories.set(id, factory)
    },
  },
}
globalThis.document = {
  head: { appendChild() {} },
  querySelector() { return null },
  createElement() { return { dataset: {}, textContent: '' } },
}

const source = await readFile(bundlePath, 'utf8')
// The banner calls window.__ModuleLoader__.load synchronously; evaluate it.
const evaluate = new Function('require', 'module', 'exports', source)
const module = { exports: {} }
const sandboxRequire = (spec) => {
  // Platform modules resolve to stubs that satisfy the factory's needs.
  if (spec === 'react') return require('react')
  if (spec === 'react/jsx-runtime') return require('react/jsx-runtime')
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    return { StateDot: () => null, IconChevronDownOutline14: () => null }
  }
  throw new Error(`unexpected require: ${spec}`)
}
evaluate(sandboxRequire, module, module.exports)

const factory = factories.get('dsh-polling')
if (factory === undefined) throw new Error('factory "dsh-polling" was not registered')

// Materialize the factory (this is what the loader does on first import).
// The DSH loader calls `factory(require)` only; the intro/footer pair owns
// its own module/exports variables and RETURNS the exports object.
const factoryRequire = (spec) => sandboxRequire(spec)
const exportsOf = factory(factoryRequire)
if (typeof exportsOf.apply !== 'function') throw new Error('bundle does not export apply()')
if (!Array.isArray(exportsOf.inject)) throw new Error('bundle does not export inject[]')
console.log('✓ bundle executes cleanly')
console.log('✓ factory registered as "dsh-polling"')
console.log(`✓ exports: apply=${typeof exportsOf.apply}, inject=${JSON.stringify(exportsOf.inject)}`)
