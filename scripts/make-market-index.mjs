#!/usr/bin/env node
/**
 * Build a standalone DSH plugin-market index (format 1) for this bundle.
 *
 * Shape mirrors the community index at
 * https://cdn.jsdelivr.net/gh/realguan/dsh-plugin-market@dist/dsh-index.json
 * (format/title/description/metadata/plugins/x-provenance). Zero npm deps:
 * only node:fs, node:path, node:child_process and the local repo are used.
 *
 * Usage:
 *   node scripts/make-market-index.mjs
 *   QQ_MARKET_COMMIT=<40-hex> node scripts/make-market-index.mjs
 *
 * Output: market/dsh-index.json (committed; serve it over any static HTTPS host,
 * e.g. https://cdn.jsdelivr.net/gh/luchengfj/qq-bot@main/market/dsh-index.json)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const read = (p) => readFileSync(resolve(root, p), 'utf8')

const pkg = JSON.parse(read('package.json'))
const meta = JSON.parse(read('market/plugin.json'))

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

const commit = (process.env.QQ_MARKET_COMMIT || git(['rev-parse', 'HEAD']) || '').trim()
if (!/^[0-9a-f]{40}$/u.test(commit)) {
  console.error('ERROR: need a 40-char commit SHA (git rev-parse HEAD or QQ_MARKET_COMMIT).')
  process.exit(1)
}
const published = Number(process.env.QQ_MARKET_TIMESTAMP || git(['log', '-1', '--format=%ct']) || Math.floor(Date.now() / 1000))

const index = {
  format: 1,
  title: { en: 'QQ Bot Channel — DSH Plugin Market', zh: 'QQ 机器人通道 — DSH 插件市场' },
  description: {
    en: 'A single-bundle market index for the @local/qq-bot DSH plugin.',
    zh: '@local/qq-bot 插件的单条目市场索引。',
  },
  metadata: {
    categories: {
      identity: { title: { en: 'Identity & Communication', zh: '身份与通信' } },
    },
    labels: {
      shell: { title: { en: 'Runs shell commands', zh: '执行 Shell 命令' } },
      'fs-write': { title: { en: 'Writes files', zh: '写入文件' } },
      'fs-read': { title: { en: 'Reads files', zh: '读取文件' } },
      network: { title: { en: 'Network access', zh: '网络访问' } },
      llm: { title: { en: 'Calls models', zh: '调用模型' } },
    },
    sortKeys: {
      stars: { title: { en: 'Stars', zh: '星标' }, order: 'desc' },
      added: { title: { en: 'Recently added', zh: '最近收录' }, order: 'desc' },
    },
  },
  plugins: [
    {
      name: meta.name,
      title: meta.title,
      description: { en: meta.description.en, zh: meta.description.zh },
      icon: meta.icon,
      author: meta.author,
      homepage: meta.homepage,
      repository: { url: meta.repository },
      metadata: {
        category: meta.category,
        keywords: meta.keywords,
        labels: meta.labels,
        sortKeys: { stars: meta.stars, added: published },
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: published,
          source: { type: 'git', url: meta.repository, commit },
          engines: { dsh: pkg.engines.dsh },
        },
      ],
    },
  ],
  'x-provenance': {
    source: 'https://github.com/luchengfj/qq-bot',
    sourceUpdated: new Date(published * 1000).toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    entries: 1,
    listed: 1,
    withIcon: 1,
  },
}

const out = resolve(root, 'market/dsh-index.json')
writeFileSync(out, JSON.stringify(index, null, 2) + '\n', 'utf8')
console.log(`wrote ${out}`)
console.log(`  name    ${meta.name}@${pkg.version}`)
console.log(`  commit  ${commit}`)
console.log(`  added   ${published} (${new Date(published * 1000).toISOString()})`)
