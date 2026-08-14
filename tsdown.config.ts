/**
 * tsdown build for dsh-polling: the Node host half (lib/index.js) plus the
 * browser client bundle (lib/client.js) in the same artifact directory.
 *
 * The client bundle follows the DeepSeek Harness client-plugin contract
 * (packages/client/tsdown.client.ts): a CJS factory registered through
 * `window.__ModuleLoader__.load({id, factory})`, externals resolved from the
 * frozen platform module table, CSS modules inlined with auto-injected
 * style tags.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import type { UserConfig } from 'tsdown'

/** The module specifiers the web shell shares into the frozen module table. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** Documented runtime exemption: the snapshot-store engine lives in runtime. */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

/** Externals resolved from the loader module table. */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

/** Node host half: ESM, resolves harness services at runtime from the host. */
const nodeConfig: UserConfig = {
  name: 'dsh-polling',
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  // Declarations come from `tsc` (build:types) into lib/types/, which
  // matches the package.json types fields; tsdown's own dts emit is a
  // non-standard serialized format and is disabled.
  dts: false,
  clean: true,
  // Harness packages are provided by the DSH host process; never bundle them.
  external: [/^@deepseek-ai\//],
  outputOptions: {
    entryFileNames: 'index.js',
  },
}

/** Browser client half: CJS factory under the loader handoff banner/footer. */
const clientConfig: UserConfig = {
  name: 'dsh-polling/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [{
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const absolute = importer === undefined
        ? resolve(source)
        : resolve(dirname(importer), source)
      // Project-relative virtual ids keep the built bundle free of the
      // author's absolute filesystem layout and make builds reproducible.
      const projectRelative = relative(process.cwd(), absolute)
      return '\0dsh-css:' + projectRelative + '.mjs'
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith('\0dsh-css:')) return null
      const relativeId = virtualId.slice('\0dsh-css:'.length, -'.mjs'.length)
      const fileId = resolve(process.cwd(), relativeId)
      this.addWatchFile(fileId)
      const source = await readFile(fileId, 'utf8')
      // Minimal CSS module transform: hash each class name for scoping.
      const classMap: Record<string, string> = {}
      const processed = source.replace(/\.([a-zA-Z][\w-]*)/g, (match, name: string) => {
        const hashed = `${name}_${hashString(relativeId + name).slice(0, 8)}`
        classMap[name] = hashed
        return `.${hashed}`
      })
      const tagId = `dsh-polling/${basename(fileId)}`
      return [
        `const css = ${JSON.stringify(processed)};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        '  tag.dataset.plugin = \'dsh-polling\';',
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-polling", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

/** Simple deterministic hash for CSS class scoping. */
function hashString(input: string): string {
  let hash = 0
  for (let index = 0; index < input.length; index++) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(36)
}

export default [nodeConfig, clientConfig]
